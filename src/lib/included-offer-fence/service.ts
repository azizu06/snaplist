import { randomUUID } from "node:crypto";
import type { AppAttestVerificationResult } from "@/lib/app-attest/service";
import {
  INCLUDED_OFFER_REDEMPTION_SCHEMA_VERSION,
  appAttestProofSchema,
  canonicalRedemptionRequest,
  deviceCheckTokenSchema,
  isTerminalIncludedOfferState,
  type AppAttestProof,
  type IncludedOfferApplePhase,
  type IncludedOfferOutcome,
} from "./contract";
import type {
  DeviceCheckAdapter,
  DeviceCheckAmbiguousReason,
} from "./device-check-adapter";
import type {
  IncludedOfferClaim,
  IncludedOfferClaimStore,
  IncludedOfferRedemptionQueue,
} from "./store";

/**
 * The fence consumes #331-verified truth through this port and never reaches
 * into App Attest's cryptographic verification, which stays frozen.
 */
export interface AppAttestRedemptionVerifier {
  verify(input: {
    assertionObject: string;
    challengeId: string;
    keyId: string;
    requestBody: Uint8Array;
  }): Promise<AppAttestVerificationResult>;
}

/** The authoritative per-account allowance ledger, unchanged by this issue. */
export interface IncludedAllowanceLedger {
  isIncludedRunAvailable(userId: string): Promise<boolean>;
}

export interface IncludedOfferFenceComposition {
  appAttest: AppAttestRedemptionVerifier;
  clock?: () => Date;
  deviceCheck: DeviceCheckAdapter;
  includedAllowance: IncludedAllowanceLedger;
  /** Terminal after this many ambiguous Apple attempts. Never grants the offer. */
  maxAppleAttempts?: number;
  newClaimId?: () => string;
  /**
   * How long an unresolved Apple write may hold the deployment-wide rendezvous
   * before the worker terminalizes it. Generous: a seller reconciling a real
   * network blip must not lose their offer to an impatient sweep.
   */
  reconcileDeadlineMs?: number;
  queue: IncludedOfferRedemptionQueue;
  store: IncludedOfferClaimStore;
  /** How long a claim at the head may wait for a fresh token before requeueing. */
  tokenWindowMs: number;
  writerLeaseMs?: number;
}

export interface IncludedOfferFence {
  redeem(input: {
    appAttest: AppAttestProof;
    idempotencyKey: string;
    userId: string;
  }): Promise<IncludedOfferOutcome>;
  submitDeviceToken(input: {
    appAttest: AppAttestProof;
    claimId: string;
    deviceToken: string;
    userId: string;
  }): Promise<IncludedOfferOutcome>;
  readClaim(input: {
    claimId: string;
    userId: string;
  }): Promise<IncludedOfferOutcome>;
}

export interface IncludedOfferRedemptionWorker {
  /** Advances the single head claim. Returns the claims opened for a token. */
  advance(): Promise<{ acked: string[]; expired: string[]; opened: string[] }>;
}

const DEFAULT_MAX_APPLE_ATTEMPTS = 5;
const DEFAULT_RECONCILE_DEADLINE_MS = 15 * 60_000;
const DEFAULT_WRITER_LEASE_MS = 30_000;
const QUEUE_VISIBILITY_SLACK_MS = 5_000;

function retryAfterMsFor(claim: IncludedOfferClaim, now: Date): number {
  if (claim.tokenDeadlineAt) {
    return Math.max(1_000, claim.tokenDeadlineAt.getTime() - now.getTime());
  }
  return 2_000;
}

function outcomeFor(claim: IncludedOfferClaim, now: Date): IncludedOfferOutcome {
  switch (claim.state) {
    case "reserved":
      return { claimId: claim.claimId, status: "reserved" };
    case "denied_device_consumed":
      return {
        appealPath: "support-override",
        claimId: claim.claimId,
        status: "denied_device_consumed",
      };
    case "denied_apple_unavailable":
      return {
        appealPath: "support-override",
        claimId: claim.claimId,
        paidPathAvailable: true,
        status: "denied_apple_unavailable",
      };
    case "awaiting_device_token":
      return {
        claimId: claim.claimId,
        status: "device_token_required",
        tokenDeadlineAt: (claim.tokenDeadlineAt ?? now).toISOString(),
      };
    // Listed rather than defaulted: a new claim state must be a compile error
    // here, not something that quietly reports itself as "queued".
    case "queued":
    case "apple_pending":
    case "reconcile_required":
      return {
        claimId: claim.claimId,
        retryAfterMs: retryAfterMsFor(claim, now),
        status: "queued",
      };
  }
}

function invalidProofOutcome(
  result: Extract<AppAttestVerificationResult, { status: "invalid" }>,
): IncludedOfferOutcome {
  return { code: result.code, status: "invalid_proof" };
}

export function createIncludedOfferFence(
  composition: IncludedOfferFenceComposition,
): IncludedOfferFence {
  const clock = composition.clock ?? (() => new Date());
  const newClaimId = composition.newClaimId ?? randomUUID;
  const maxAppleAttempts =
    composition.maxAppleAttempts ?? DEFAULT_MAX_APPLE_ATTEMPTS;
  const writerLeaseMs = composition.writerLeaseMs ?? DEFAULT_WRITER_LEASE_MS;

  async function settle(
    claim: IncludedOfferClaim,
    to: "reserved" | "denied_device_consumed" | "denied_apple_unavailable",
    now: Date,
  ): Promise<IncludedOfferClaim> {
    const settled =
      (await composition.store.transitionClaim({
        claimId: claim.claimId,
        from: ["queued", "awaiting_device_token", "apple_pending", "reconcile_required"],
        now,
        to,
        tokenDeadlineAt: null,
      })) ?? claim;
    if (claim.queueMessageId) {
      // Releasing the head immediately is what lets the next account's claim run;
      // the worker also acks terminal claims defensively on redelivery.
      await composition.queue.ack(claim.queueMessageId);
    }
    return settled;
  }

  /**
   * The bounded Apple rendezvous. The caller has already taken the global
   * single-writer lease and moved the claim to `apple_pending`, so this owns
   * Apple's query-and-set window for the duration.
   *
   * `priorPhase` carries what the claim already proved. A claim that reached
   * `update` observed a clear device while holding the lease, and the lease
   * refuses every rival while that write is unresolved, so a later `bit0 = true`
   * is our own write rather than somebody else's consumption.
   */
  async function rendezvous(
    owned: IncludedOfferClaim,
    priorPhase: IncludedOfferApplePhase | null,
    attemptCount: number,
    deviceToken: string,
    now: Date,
  ): Promise<IncludedOfferOutcome> {
    const query = await composition.deviceCheck.queryTwoBits({ deviceToken });
    if (query.status === "ambiguous") {
      return deferAmbiguous(owned, query.reason, attemptCount, now);
    }

    if (query.bit0) {
      if (priorPhase === "update") {
        // Our own update landed despite an ambiguous response.
        const settled = await settle(owned, "reserved", now);
        return outcomeFor(settled, now);
      }
      const settled = await settle(owned, "denied_device_consumed", now);
      return outcomeFor(settled, now);
    }

    // The `bit0 = false` above is only worth acting on if we have held the lease
    // continuously since reading it. A lease that lapsed mid-query could have
    // been taken, used, and released by a rival, leaving this reading stale and
    // the device already spent.
    if (!(await composition.store.holdsWriterLease({ claimId: owned.claimId, now }))) {
      return deferAmbiguous(owned, "timeout", attemptCount, now);
    }

    // Observed clear under the lease. Record that before touching Apple again so
    // a crash between here and the response cannot be reconciled as "consumed".
    const writing = await composition.store.transitionClaim({
      applePhase: "update",
      claimId: owned.claimId,
      from: ["apple_pending"],
      now,
      to: "apple_pending",
    });
    if (!writing) {
      // The ownership record has to land before Apple is touched. Writing the
      // bit without it would leave a set device nobody can reconcile.
      return deferAmbiguous(owned, "server_error", attemptCount, now);
    }

    const update = await composition.deviceCheck.updateTwoBits({
      bit0: true,
      bit1: query.bit1,
      deviceToken,
    });
    if (update.status === "ambiguous") {
      return deferAmbiguous(writing, update.reason, attemptCount, now);
    }
    const settled = await settle(writing, "reserved", now);
    return outcomeFor(settled, now);
  }

  async function deferAmbiguous(
    claim: IncludedOfferClaim,
    reason: DeviceCheckAmbiguousReason,
    attemptCount: number,
    now: Date,
  ): Promise<IncludedOfferOutcome> {
    if (attemptCount >= maxAppleAttempts) {
      const settled = await settle(claim, "denied_apple_unavailable", now);
      return outcomeFor(settled, now);
    }
    const deferred =
      (await composition.store.transitionClaim({
        attemptCount,
        claimId: claim.claimId,
        from: ["apple_pending"],
        now,
        to: "reconcile_required",
        tokenDeadlineAt: null,
      })) ?? claim;
    return {
      claimId: deferred.claimId,
      paidPathAvailable: true,
      reason,
      retryAfterMs: 2_000,
      status: "retry_required",
    };
  }

  return {
    async redeem(input) {
      const proof = appAttestProofSchema.parse(input.appAttest);
      const now = clock();
      const verification = await composition.appAttest.verify({
        ...proof,
        requestBody: canonicalRedemptionRequest({
          action: "included-offer.redeem",
          idempotencyKey: input.idempotencyKey,
          userId: input.userId,
        }),
      });
      if (verification.status === "invalid") return invalidProofOutcome(verification);

      const existing = await composition.store.findClaimByIdempotencyKey({
        idempotencyKey: input.idempotencyKey,
        userId: input.userId,
      });
      if (existing) return outcomeFor(existing, now);

      if (!(await composition.includedAllowance.isIncludedRunAvailable(input.userId))) {
        return { paidPathAvailable: true, status: "denied_account_consumed" };
      }

      const override = await composition.store.findActiveSupportOverride({
        userId: input.userId,
      });
      const claim = await composition.store.createClaim({
        appAttestKeyId: proof.keyId,
        claimId: newClaimId(),
        idempotencyKey: input.idempotencyKey,
        now,
        state: "queued",
        userId: input.userId,
      });
      if (override) {
        // Consuming decides; the override is one-time, so a concurrent
        // different-key redemption that loses this race falls through to the
        // device fence rather than minting a second exception. An override
        // authorizes exactly one claim and never clears Apple's lifetime bit.
        const consumed = await composition.store.consumeSupportOverride({
          claimId: claim.claimId,
          now,
          overrideId: override.overrideId,
        });
        if (consumed) {
          const reserved =
            (await composition.store.transitionClaim({
              claimId: claim.claimId,
              from: ["queued"],
              now,
              to: "reserved",
              tokenDeadlineAt: null,
            })) ?? claim;
          return outcomeFor(reserved, now);
        }
      }
      const messageId = await composition.queue.enqueue({
        claim_id: claim.claimId,
        schema_version: INCLUDED_OFFER_REDEMPTION_SCHEMA_VERSION,
      });
      await composition.store.recordQueueMessage({
        claimId: claim.claimId,
        queueMessageId: messageId,
      });
      return outcomeFor(claim, now);
    },

    async submitDeviceToken(input) {
      const proof = appAttestProofSchema.parse(input.appAttest);
      const deviceToken = deviceCheckTokenSchema.parse(input.deviceToken);
      const now = clock();
      const verification = await composition.appAttest.verify({
        ...proof,
        requestBody: canonicalRedemptionRequest({
          action: "included-offer.device-token",
          claimId: input.claimId,
          userId: input.userId,
        }),
      });
      if (verification.status === "invalid") return invalidProofOutcome(verification);

      const claim = await composition.store.findClaimById({
        claimId: input.claimId,
        userId: input.userId,
      });
      if (!claim) return { status: "claim_not_found" };
      if (isTerminalIncludedOfferState(claim.state)) return outcomeFor(claim, now);
      if (claim.state !== "awaiting_device_token") return outcomeFor(claim, now);
      if (claim.tokenDeadlineAt && claim.tokenDeadlineAt.getTime() <= now.getTime()) {
        const requeued =
          (await composition.store.transitionClaim({
            claimId: claim.claimId,
            from: ["awaiting_device_token"],
            now,
            to: "queued",
            tokenDeadlineAt: null,
          })) ?? claim;
        return outcomeFor(requeued, now);
      }

      if (
        !(await composition.store.acquireWriterLease({
          claimId: claim.claimId,
          leaseMs: writerLeaseMs,
          now,
        }))
      ) {
        return outcomeFor({ ...claim, state: "queued" }, now);
      }

      const attemptCount = claim.attemptCount + 1;
      const priorPhase = claim.applePhase;
      const owned = await composition.store.transitionClaim({
        applePhase: priorPhase ?? "query",
        attemptCount,
        claimId: claim.claimId,
        from: ["awaiting_device_token", "reconcile_required"],
        now,
        to: "apple_pending",
      });
      if (!owned) {
        // A concurrent call for this same claim already owns the rendezvous and
        // holds the lease. Releasing it here would reopen Apple's window
        // mid-write, so this call withdraws without touching either.
        return outcomeFor(claim, now);
      }
      try {
        return await rendezvous(owned, priorPhase, attemptCount, deviceToken, now);
      } finally {
        await composition.store.releaseWriterLease({ claimId: claim.claimId });
      }
    },

    async readClaim(input) {
      const claim = await composition.store.findClaimById({
        claimId: input.claimId,
        userId: input.userId,
      });
      if (!claim) return { status: "claim_not_found" };
      return outcomeFor(claim, clock());
    },
  };
}

export function createIncludedOfferRedemptionWorker(
  composition: IncludedOfferFenceComposition,
): IncludedOfferRedemptionWorker {
  const clock = composition.clock ?? (() => new Date());
  const reconcileDeadlineMs =
    composition.reconcileDeadlineMs ?? DEFAULT_RECONCILE_DEADLINE_MS;
  const visibilityTimeoutSeconds = Math.max(
    1,
    Math.ceil((composition.tokenWindowMs + QUEUE_VISIBILITY_SLACK_MS) / 1000),
  );

  return {
    async advance() {
      const now = clock();
      const acked: string[] = [];
      const opened: string[] = [];

      // An unresolved write blocks every account, so a client that never comes
      // back would block them forever. Terminalizing is the only safe release:
      // the abandoning claim loses the offer, and only then may the next claim
      // read Apple's bit — as set if the write landed, clear if it did not.
      const expired = await composition.store.expireStaleRendezvous({
        olderThan: new Date(now.getTime() - reconcileDeadlineMs),
      });

      const message = await composition.queue.claimHead({
        visibilityTimeoutSeconds,
      });
      if (!message) return { acked, expired, opened };

      const claim = await composition.store.findClaimById({
        claimId: message.envelope.claim_id,
      });
      if (!claim || isTerminalIncludedOfferState(claim.state)) {
        await composition.queue.ack(message.messageId);
        acked.push(message.envelope.claim_id);
        return { acked, expired, opened };
      }

      // Single-writer means one open rendezvous, not one message in flight.
      // Inviting a second account to spend a fresh ephemeral token it can only
      // be refused for would also make the queue's ordering cosmetic.
      const inFlight = await composition.store.hasOpenRendezvous({
        exceptClaimId: claim.claimId,
        now,
      });
      if (inFlight) {
        await composition.queue.defer(message.messageId, visibilityTimeoutSeconds);
        return { acked, expired, opened };
      }

      const deadline = new Date(now.getTime() + composition.tokenWindowMs);
      const openedClaim = await composition.store.transitionClaim({
        claimId: claim.claimId,
        from: ["queued", "awaiting_device_token", "apple_pending", "reconcile_required"],
        now,
        to: "awaiting_device_token",
        tokenDeadlineAt: deadline,
      });
      if (openedClaim) opened.push(openedClaim.claimId);
      await composition.queue.defer(message.messageId, visibilityTimeoutSeconds);
      return { acked, expired, opened };
    },
  };
}
