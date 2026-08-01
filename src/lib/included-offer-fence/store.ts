import { z } from "zod";
import {
  INCLUDED_OFFER_REDEMPTION_SCHEMA_VERSION,
  isTerminalIncludedOfferState,
  type IncludedOfferApplePhase,
  type IncludedOfferClaimState,
} from "./contract";

export interface IncludedOfferClaim {
  appAttestKeyId: string;
  applePhase: IncludedOfferApplePhase | null;
  attemptCount: number;
  claimId: string;
  consumedAt: Date | null;
  createdAt: Date;
  idempotencyKey: string;
  queueMessageId: string | null;
  state: IncludedOfferClaimState;
  tokenDeadlineAt: Date | null;
  updatedAt: Date;
  userId: string;
}

export interface IncludedOfferSupportOverride {
  claimId: string | null;
  consumedAt: Date | null;
  grantedAt: Date;
  grantedBy: string;
  overrideId: string;
  reason: string;
  userId: string;
}

export interface IncludedOfferClaimTransition {
  applePhase?: IncludedOfferApplePhase | null;
  attemptCount?: number;
  claimId: string;
  /** Optimistic guard: the transition applies only from one of these states. */
  from: readonly IncludedOfferClaimState[];
  now: Date;
  /**
   * Applies only while this claim provably still holds the writer lease. Set it
   * for the write that claims a clear-device observation: checking the lease
   * separately leaves a gap in which it lapses, a rival spends the device, and
   * the write lands anyway on a reading that is no longer true.
   */
  requireWriterLease?: boolean;
  to: IncludedOfferClaimState;
  tokenDeadlineAt?: Date | null;
}

export interface IncludedOfferClaimStore {
  createClaim(input: {
    appAttestKeyId: string;
    claimId: string;
    idempotencyKey: string;
    now: Date;
    state: IncludedOfferClaimState;
    userId: string;
  }): Promise<IncludedOfferClaim>;
  findClaimByIdempotencyKey(input: {
    idempotencyKey: string;
    userId: string;
  }): Promise<IncludedOfferClaim | null>;
  /**
   * Claim-scoped read. `userId` is required for caller-facing reads so a claim
   * identifier alone never discloses another tenant's promotion state.
   */
  findClaimById(input: {
    claimId: string;
    userId?: string;
  }): Promise<IncludedOfferClaim | null>;
  transitionClaim(
    input: IncludedOfferClaimTransition,
  ): Promise<IncludedOfferClaim | null>;
  recordQueueMessage(input: {
    claimId: string;
    queueMessageId: string;
  }): Promise<void>;
  findActiveSupportOverride(input: {
    userId: string;
  }): Promise<IncludedOfferSupportOverride | null>;
  consumeSupportOverride(input: {
    claimId: string;
    now: Date;
    overrideId: string;
  }): Promise<boolean>;
  /**
   * Whether a claim other than `exceptClaimId` still occupies the rendezvous.
   * The worker uses it to keep exactly one claim open at a time.
   *
   * "Occupies" means either its token window is still open, or it carries an
   * unresolved `update` write that no other claim can make progress past anyway.
   * Deliberately a boolean: the worker does not own the blocking claim and has
   * no business reading another tenant's identity out of it.
   */
  hasOpenRendezvous(input: {
    exceptClaimId: string;
    now: Date;
  }): Promise<boolean>;
  /**
   * Terminalizes claims whose unresolved `update` write has gone stale, and
   * returns their ids.
   *
   * An unresolved write blocks every account's redemption, and a client that
   * never comes back would block them forever. Terminalizing is the only safe
   * release: the device bit may or may not be set, so the abandoning claim has
   * to lose the offer before anyone else may read that bit as clear.
   */
  expireStaleRendezvous(input: { olderThan: Date }): Promise<string[]>;
  /**
   * The global single-writer lease over Apple's query-and-set window. Apple
   * exposes query and update but no compare-and-set, so correctness requires
   * that exactly one claim anywhere can be mid-rendezvous.
   *
   * Acquisition also fails while any other non-terminal claim carries
   * `applePhase === "update"`. That claim observed a clear device and may or may
   * not have landed its write, so the device is indeterminate but spoken for —
   * letting a rival read the bit as clear is exactly how one device mints two
   * included runs.
   */
  acquireWriterLease(input: {
    claimId: string;
    leaseMs: number;
    now: Date;
  }): Promise<boolean>;
  /**
   * Whether this claim still holds the lease it took, unexpired.
   *
   * Re-acquiring cannot answer this: a lease that lapsed and was picked up and
   * released by a rival is free again, and re-acquiring it would succeed while
   * the rival's write sat between our stale `bit0` read and our own.
   */
  releaseWriterLease(input: { claimId: string }): Promise<void>;
}

/** States in which a claim already holds, or is owed, an Apple rendezvous. */
const OPEN_RENDEZVOUS_STATES: readonly IncludedOfferClaimState[] = [
  "awaiting_device_token",
  "apple_pending",
  "reconcile_required",
];

export const includedOfferQueueEnvelopeSchema = z
  .object({
    claim_id: z.string().uuid(),
    schema_version: z.literal(INCLUDED_OFFER_REDEMPTION_SCHEMA_VERSION),
  })
  .strict();

export type IncludedOfferQueueEnvelope = z.infer<
  typeof includedOfferQueueEnvelopeSchema
>;

export interface IncludedOfferQueueMessage {
  envelope: IncludedOfferQueueEnvelope;
  messageId: string;
  readCount: number;
}

/**
 * Deliberately narrower than a general queue: the head is claimed one message at
 * a time because this queue exists to serialize, not to parallelize.
 */
export interface IncludedOfferRedemptionQueue {
  enqueue(envelope: IncludedOfferQueueEnvelope): Promise<string>;
  claimHead(input: {
    visibilityTimeoutSeconds: number;
  }): Promise<IncludedOfferQueueMessage | null>;
  ack(messageId: string): Promise<boolean>;
  defer(messageId: string, visibilityTimeoutSeconds: number): Promise<boolean>;
}

export class InMemoryIncludedOfferClaimStore implements IncludedOfferClaimStore {
  readonly #claims = new Map<string, IncludedOfferClaim>();
  readonly #overrides = new Map<string, IncludedOfferSupportOverride>();
  #lease: { claimId: string; expiresAt: Date } | null = null;

  async createClaim(input: {
    appAttestKeyId: string;
    claimId: string;
    idempotencyKey: string;
    now: Date;
    state: IncludedOfferClaimState;
    userId: string;
  }): Promise<IncludedOfferClaim> {
    const existing = await this.findClaimByIdempotencyKey({
      idempotencyKey: input.idempotencyKey,
      userId: input.userId,
    });
    if (existing) return existing;
    const claim: IncludedOfferClaim = {
      appAttestKeyId: input.appAttestKeyId,
      applePhase: null,
      attemptCount: 0,
      claimId: input.claimId,
      consumedAt: null,
      createdAt: input.now,
      idempotencyKey: input.idempotencyKey,
      queueMessageId: null,
      state: input.state,
      tokenDeadlineAt: null,
      updatedAt: input.now,
      userId: input.userId,
    };
    this.#claims.set(claim.claimId, claim);
    return { ...claim };
  }

  async findClaimByIdempotencyKey(input: {
    idempotencyKey: string;
    userId: string;
  }): Promise<IncludedOfferClaim | null> {
    for (const claim of this.#claims.values()) {
      if (
        claim.userId === input.userId &&
        claim.idempotencyKey === input.idempotencyKey
      ) {
        return { ...claim };
      }
    }
    return null;
  }

  async findClaimById(input: {
    claimId: string;
    userId?: string;
  }): Promise<IncludedOfferClaim | null> {
    const claim = this.#claims.get(input.claimId);
    if (!claim) return null;
    if (input.userId !== undefined && claim.userId !== input.userId) return null;
    return { ...claim };
  }

  async transitionClaim(
    input: IncludedOfferClaimTransition,
  ): Promise<IncludedOfferClaim | null> {
    const claim = this.#claims.get(input.claimId);
    if (!claim || !input.from.includes(claim.state)) return null;
    if (
      input.requireWriterLease
      && !(
        this.#lease?.claimId === input.claimId
        && this.#lease.expiresAt.getTime() > input.now.getTime()
      )
    ) {
      return null;
    }
    claim.state = input.to;
    claim.updatedAt = input.now;
    if (input.applePhase !== undefined) claim.applePhase = input.applePhase;
    if (input.attemptCount !== undefined) claim.attemptCount = input.attemptCount;
    if (input.tokenDeadlineAt !== undefined) {
      claim.tokenDeadlineAt = input.tokenDeadlineAt;
    }
    return { ...claim };
  }

  async recordQueueMessage(input: {
    claimId: string;
    queueMessageId: string;
  }): Promise<void> {
    const claim = this.#claims.get(input.claimId);
    if (claim) claim.queueMessageId = input.queueMessageId;
  }

  async findActiveSupportOverride(input: {
    userId: string;
  }): Promise<IncludedOfferSupportOverride | null> {
    for (const override of this.#overrides.values()) {
      if (override.userId === input.userId && override.consumedAt === null) {
        return { ...override };
      }
    }
    return null;
  }

  async consumeSupportOverride(input: {
    claimId: string;
    now: Date;
    overrideId: string;
  }): Promise<boolean> {
    const override = this.#overrides.get(input.overrideId);
    if (!override || override.consumedAt !== null) return false;
    override.consumedAt = input.now;
    override.claimId = input.claimId;
    return true;
  }

  async hasOpenRendezvous(input: {
    exceptClaimId: string;
    now: Date;
  }): Promise<boolean> {
    for (const claim of this.#claims.values()) {
      if (
        claim.claimId !== input.exceptClaimId &&
        OPEN_RENDEZVOUS_STATES.includes(claim.state) &&
        ((claim.tokenDeadlineAt !== null &&
          claim.tokenDeadlineAt.getTime() > input.now.getTime()) ||
          claim.applePhase === "update")
      ) {
        return true;
      }
    }
    return false;
  }

  async expireStaleRendezvous(input: { olderThan: Date }): Promise<string[]> {
    const expired: string[] = [];
    for (const claim of this.#claims.values()) {
      if (
        claim.applePhase === "update" &&
        !isTerminalIncludedOfferState(claim.state) &&
        claim.updatedAt.getTime() <= input.olderThan.getTime()
      ) {
        claim.state = "denied_apple_unavailable";
        claim.tokenDeadlineAt = null;
        expired.push(claim.claimId);
      }
    }
    return expired;
  }

  async acquireWriterLease(input: {
    claimId: string;
    leaseMs: number;
    now: Date;
  }): Promise<boolean> {
    if (
      this.#lease &&
      this.#lease.claimId !== input.claimId &&
      this.#lease.expiresAt.getTime() > input.now.getTime()
    ) {
      return false;
    }
    // An unresolved write outranks an expired lease: the lease can time out, but
    // Apple's indeterminate bit does not become somebody else's to claim. The
    // state test is "not terminal" rather than the open-rendezvous set, because
    // a deadline requeue parks a claim at `queued` with its phase intact.
    for (const claim of this.#claims.values()) {
      if (
        claim.claimId !== input.claimId &&
        claim.applePhase === "update" &&
        !isTerminalIncludedOfferState(claim.state)
      ) {
        return false;
      }
    }
    this.#lease = {
      claimId: input.claimId,
      expiresAt: new Date(input.now.getTime() + input.leaseMs),
    };
    return true;
  }

  async releaseWriterLease(input: { claimId: string }): Promise<void> {
    if (this.#lease?.claimId === input.claimId) this.#lease = null;
  }

  /** Test-only seam for the audited support-override path. */
  grantSupportOverride(override: IncludedOfferSupportOverride): void {
    this.#overrides.set(override.overrideId, { ...override });
  }

  snapshotClaims(): IncludedOfferClaim[] {
    return [...this.#claims.values()].map((claim) => ({ ...claim }));
  }
}

interface QueuedMessage {
  envelope: IncludedOfferQueueEnvelope;
  messageId: string;
  readCount: number;
  visibleAtMs: number;
}

export class InMemoryIncludedOfferRedemptionQueue
  implements IncludedOfferRedemptionQueue
{
  readonly #messages: QueuedMessage[] = [];
  readonly #enqueued: IncludedOfferQueueEnvelope[] = [];
  #nextId = 1;
  #nowMs = 0;

  /** Every envelope this queue has ever carried, for payload-content assertions. */
  enqueuedEnvelopes(): IncludedOfferQueueEnvelope[] {
    return this.#enqueued.map((envelope) => ({ ...envelope }));
  }

  /** Advances the queue's notion of time so deferred messages become visible. */
  setNow(now: Date): void {
    this.#nowMs = now.getTime();
  }

  async enqueue(envelope: IncludedOfferQueueEnvelope): Promise<string> {
    const parsed = includedOfferQueueEnvelopeSchema.parse(envelope);
    this.#enqueued.push(parsed);
    const messageId = String(this.#nextId++);
    this.#messages.push({
      envelope,
      messageId,
      readCount: 0,
      visibleAtMs: this.#nowMs,
    });
    return messageId;
  }

  async claimHead(input: {
    visibilityTimeoutSeconds: number;
  }): Promise<IncludedOfferQueueMessage | null> {
    const message = this.#messages.find(
      (candidate) => candidate.visibleAtMs <= this.#nowMs,
    );
    if (!message) return null;
    message.readCount += 1;
    message.visibleAtMs = this.#nowMs + input.visibilityTimeoutSeconds * 1000;
    return {
      envelope: message.envelope,
      messageId: message.messageId,
      readCount: message.readCount,
    };
  }

  async ack(messageId: string): Promise<boolean> {
    const index = this.#messages.findIndex(
      (message) => message.messageId === messageId,
    );
    if (index < 0) return false;
    this.#messages.splice(index, 1);
    return true;
  }

  async defer(
    messageId: string,
    visibilityTimeoutSeconds: number,
  ): Promise<boolean> {
    const message = this.#messages.find(
      (candidate) => candidate.messageId === messageId,
    );
    if (!message) return false;
    message.visibleAtMs = this.#nowMs + visibilityTimeoutSeconds * 1000;
    return true;
  }

  depth(): number {
    return this.#messages.length;
  }
}
