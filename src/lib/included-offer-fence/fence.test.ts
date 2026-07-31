import { describe, expect, it } from "vitest";
import {
  InMemoryIncludedOfferClaimStore,
  InMemoryIncludedOfferRedemptionQueue,
} from "./store";
import {
  createIncludedOfferFence,
  createIncludedOfferRedemptionWorker,
  type IncludedOfferFence,
} from "./service";
import {
  createFakeAppAttestVerifier,
  createFakeDeviceCheck,
  fakeAssertionFor,
} from "./testing";
import {
  canonicalRedemptionRequest,
  type IncludedOfferOutcome,
} from "./contract";

/** Narrows the outcome union: only claim-bearing outcomes carry an id. */
function claimIdOf(outcome: IncludedOfferOutcome): string {
  if (!("claimId" in outcome)) {
    throw new Error(`outcome ${outcome.status} carries no claim id`);
  }
  return outcome.claimId;
}

const TOKEN_WINDOW_MS = 60_000;

function harness(options?: {
  deviceForToken?(token: string): string;
  gateQuery?(): Promise<void>;
  initialBits?: Record<string, { bit0: boolean; bit1: boolean }>;
  maxAppleAttempts?: number;
}) {
  let now = new Date("2026-07-31T18:00:00.000Z");
  const appAttest = createFakeAppAttestVerifier({});
  const rawDeviceCheck = createFakeDeviceCheck({
    deviceForToken: options?.deviceForToken ?? ((token) => token.split(":")[0]),
    initialBits: options?.initialBits,
  });
  const deviceCheck = {
    ...rawDeviceCheck,
    async queryTwoBits(input: { deviceToken: string }) {
      await options?.gateQuery?.();
      return rawDeviceCheck.queryTwoBits(input);
    },
  };
  const store = new InMemoryIncludedOfferClaimStore();
  const queue = new InMemoryIncludedOfferRedemptionQueue();
  const includedRunConsumed = new Set<string>();

  const composition = {
    appAttest,
    clock: () => now,
    deviceCheck,
    includedAllowance: {
      async isIncludedRunAvailable(userId: string) {
        return !includedRunConsumed.has(userId);
      },
    },
    maxAppleAttempts: options?.maxAppleAttempts,
    queue,
    store,
    tokenWindowMs: TOKEN_WINDOW_MS,
  };

  const fence: IncludedOfferFence = createIncludedOfferFence(composition);
  const worker = createIncludedOfferRedemptionWorker(composition);

  async function redeem(userId: string, keyId: string, idempotencyKey: string) {
    const body = canonicalRedemptionRequest({
      action: "included-offer.redeem",
      idempotencyKey,
      userId,
    });
    appAttest.attest(keyId);
    const challengeId = appAttest.issueChallenge(keyId);
    return fence.redeem({
      appAttest: {
        assertionObject: fakeAssertionFor(body),
        challengeId,
        keyId,
      },
      idempotencyKey,
      userId,
    });
  }

  async function submitToken(
    userId: string,
    keyId: string,
    claimId: string,
    deviceToken: string,
  ) {
    const body = canonicalRedemptionRequest({
      action: "included-offer.device-token",
      claimId,
      userId,
    });
    const challengeId = appAttest.issueChallenge(keyId);
    return fence.submitDeviceToken({
      appAttest: {
        assertionObject: fakeAssertionFor(body),
        challengeId,
        keyId,
      },
      claimId,
      deviceToken,
      userId,
    });
  }

  /** Replays a challenge the verifier has already consumed. */
  async function redeemWithReusedChallenge(
    userId: string,
    keyId: string,
    idempotencyKey: string,
  ) {
    const body = canonicalRedemptionRequest({
      action: "included-offer.redeem",
      idempotencyKey,
      userId,
    });
    appAttest.attest(keyId);
    const challengeId = appAttest.issueChallenge(keyId);
    const proof = {
      appAttest: {
        assertionObject: fakeAssertionFor(body),
        challengeId,
        keyId,
      },
      idempotencyKey,
      userId,
    };
    const first = await fence.redeem(proof);
    const claimsAfterFirst = store.snapshotClaims();
    const queueDepthAfterFirst = queue.depth();
    return {
      claimsAfterFirst,
      first,
      queueDepthAfterFirst,
      replay: await fence.redeem(proof),
    };
  }

  return {
    advance: () => worker.advance(),
    consumeIncludedRun: (userId: string) => includedRunConsumed.add(userId),
    deviceCheck: rawDeviceCheck,
    fence,
    grantSupportOverride: (userId: string) =>
      store.grantSupportOverride({
        claimId: null,
        consumedAt: null,
        grantedAt: now,
        grantedBy: "support_agent_1",
        overrideId: `override-${userId}`,
        reason: "verified device transfer",
        userId,
      }),
    /** Puts a claim at the token rendezvous without waiting for its queue turn. */
    openForToken: (claimId: string) =>
      store.transitionClaim({
        claimId,
        from: ["queued", "reconcile_required"],
        now,
        to: "awaiting_device_token",
        tokenDeadlineAt: new Date(now.getTime() + TOKEN_WINDOW_MS),
      }),
    redeem,
    redeemWithReusedChallenge,
    queue,
    setNow: (next: Date) => {
      now = next;
      queue.setNow(next);
    },
    store,
    submitToken,
  };
}

describe("included first AI offer device fence", () => {
  it("denies a second Clerk account on the same verified device", async () => {
    const h = harness();

    const first = await h.redeem("user_alice", "key-alice", "idem-alice-1");
    expect(first).toEqual({
      claimId: expect.any(String),
      retryAfterMs: expect.any(Number),
      status: "queued",
    });

    await h.advance();
    const alicePrompt = await h.fence.readClaim({
      claimId: claimIdOf(first),
      userId: "user_alice",
    });
    expect(alicePrompt.status).toBe("device_token_required");

    await expect(
      h.submitToken("user_alice", "key-alice", claimIdOf(first), "device-7:token-a"),
    ).resolves.toEqual({ claimId: claimIdOf(first), status: "reserved" });

    // A brand new Clerk account, a regenerated App Attest key, the same phone.
    const second = await h.redeem("user_mallory", "key-mallory", "idem-mallory-1");
    expect(second.status).toBe("queued");

    await h.advance();
    await expect(
      h.submitToken(
        "user_mallory",
        "key-mallory",
        claimIdOf(second),
        "device-7:token-b",
      ),
    ).resolves.toEqual({
      appealPath: "support-override",
      claimId: claimIdOf(second),
      status: "denied_device_consumed",
    });

    expect(h.deviceCheck.bits("device-7")).toEqual({ bit0: true, bit1: false });
  });

  it("never converts an ambiguous query into unused eligibility", async () => {
    // The device already consumed the offer, but Apple's answer times out.
    const h = harness({ initialBits: { "device-9": { bit0: true, bit1: false } } });

    const claim = await h.redeem("user_carol", "key-carol", "idem-carol-1");
    await h.advance();
    h.deviceCheck.failNextQuery("timeout");

    await expect(
      h.submitToken("user_carol", "key-carol", claimIdOf(claim), "device-9:token-a"),
    ).resolves.toEqual({
      claimId: claimIdOf(claim),
      paidPathAvailable: true,
      reason: "timeout",
      retryAfterMs: expect.any(Number),
      status: "retry_required",
    });

    // Uncertainty is not a reservation.
    await expect(
      h.fence.readClaim({ claimId: claimIdOf(claim), userId: "user_carol" }),
    ).resolves.not.toMatchObject({ status: "reserved" });

    // Redelivery asks the owning client for another fresh token, and the truth
    // Apple finally reports is a denial — we never observed a clear device.
    h.setNow(new Date("2026-07-31T18:10:00.000Z"));
    await h.advance();
    await expect(
      h.submitToken("user_carol", "key-carol", claimIdOf(claim), "device-9:token-b"),
    ).resolves.toEqual({
      appealPath: "support-override",
      claimId: claimIdOf(claim),
      status: "denied_device_consumed",
    });
  });

  it("reconciles an ambiguous update that reached Apple as its own reservation", async () => {
    const h = harness();

    const claim = await h.redeem("user_dave", "key-dave", "idem-dave-1");
    await h.advance();
    // Apple applied the write, then the response was lost.
    h.deviceCheck.failNextUpdateAfterApplying("server_error");

    await expect(
      h.submitToken("user_dave", "key-dave", claimIdOf(claim), "device-3:token-a"),
    ).resolves.toMatchObject({ status: "retry_required" });
    expect(h.deviceCheck.bits("device-3")).toEqual({ bit0: true, bit1: false });

    h.setNow(new Date("2026-07-31T18:10:00.000Z"));
    await h.advance();
    // The claim observed a clear device while holding the single-writer lease,
    // so the set bit can only be its own write. Denying here would burn a
    // legitimate seller's one included run on a network blip.
    await expect(
      h.submitToken("user_dave", "key-dave", claimIdOf(claim), "device-3:token-b"),
    ).resolves.toEqual({ claimId: claimIdOf(claim), status: "reserved" });
  });

  it("resumes the original claim for an exact same-key replay", async () => {
    const h = harness();

    const first = await h.redeem("user_erin", "key-erin", "idem-erin-1");
    const replay = await h.redeem("user_erin", "key-erin", "idem-erin-1");
    expect(claimIdOf(replay)).toBe(claimIdOf(first));
    expect(h.store.snapshotClaims()).toHaveLength(1);
    expect(h.queue.depth()).toBe(1);

    await h.advance();
    await h.submitToken("user_erin", "key-erin", claimIdOf(first), "device-1:token-a");

    // A replay after settlement returns the same reservation, not a second one.
    await expect(h.redeem("user_erin", "key-erin", "idem-erin-1")).resolves.toEqual({
      claimId: claimIdOf(first),
      status: "reserved",
    });
    expect(h.store.snapshotClaims()).toHaveLength(1);
  });

  it("rejects a replayed App Attest challenge with no durable state change", async () => {
    const h = harness();

    const attempt = await h.redeemWithReusedChallenge(
      "user_frank",
      "key-frank",
      "idem-frank-1",
    );
    expect(attempt.first.status).toBe("queued");
    expect(attempt.replay).toEqual({
      code: "challenge_replayed",
      status: "invalid_proof",
    });
    // The rejected replay left the durable claim and queue exactly as they were.
    expect(h.store.snapshotClaims()).toEqual(attempt.claimsAfterFirst);
    expect(h.queue.depth()).toBe(attempt.queueDepthAfterFirst);
  });

  it("keeps the ephemeral device token out of every durable surface", async () => {
    const h = harness();
    const claim = await h.redeem("user_gina", "key-gina", "idem-gina-1");
    await h.advance();
    await h.submitToken("user_gina", "key-gina", claimIdOf(claim), "device-5:secret-token");

    expect(h.deviceCheck.seenTokens()).toContain("device-5:secret-token");
    expect(JSON.stringify(h.store.snapshotClaims())).not.toContain("secret-token");
    expect(h.queue.enqueuedEnvelopes()).toEqual([
      { claim_id: claimIdOf(claim), schema_version: 1 },
    ]);
  });

  it("denies only the promotion when the account ledger already spent it", async () => {
    const h = harness();
    h.consumeIncludedRun("user_hank");

    await expect(h.redeem("user_hank", "key-hank", "idem-hank-1")).resolves.toEqual({
      paidPathAvailable: true,
      status: "denied_account_consumed",
    });
    expect(h.store.snapshotClaims()).toHaveLength(0);
  });

  it("becomes terminal rather than eligible after repeated ambiguous outcomes", async () => {
    const h = harness({ maxAppleAttempts: 2 });
    const claim = await h.redeem("user_ivy", "key-ivy", "idem-ivy-1");

    for (const [attempt, minute] of [10, 20].entries()) {
      h.setNow(new Date(`2026-07-31T18:${String(minute).padStart(2, "0")}:00.000Z`));
      await h.advance();
      h.deviceCheck.failNextQuery("throttled");
      const outcome = await h.submitToken(
        "user_ivy",
        "key-ivy",
        claimIdOf(claim),
        `device-2:token-${attempt}`,
      );
      if (attempt === 1) {
        expect(outcome).toEqual({
          appealPath: "support-override",
          claimId: claimIdOf(claim),
          paidPathAvailable: true,
          status: "denied_apple_unavailable",
        });
      }
    }
    expect(h.deviceCheck.bits("device-2")).toBeNull();
  });

  it("honours a one-time audited support override without clearing the device bit", async () => {
    const h = harness({ initialBits: { "device-8": { bit0: true, bit1: false } } });
    h.grantSupportOverride("user_jill");

    const claim = await h.redeem("user_jill", "key-jill", "idem-jill-1");
    expect(claim).toEqual({ claimId: expect.any(String), status: "reserved" });
    // Apple was never asked to forget the device.
    expect(h.deviceCheck.bits("device-8")).toEqual({ bit0: true, bit1: false });
    expect(h.deviceCheck.seenTokens()).toEqual([]);

    // The override is one-time: a second account on the same device is still denied.
    const second = await h.redeem("user_jill2", "key-jill2", "idem-jill2-1");
    await h.advance();
    await expect(
      h.submitToken("user_jill2", "key-jill2", claimIdOf(second), "device-8:token-a"),
    ).resolves.toMatchObject({ status: "denied_device_consumed" });
  });

  it("lets only one concurrent claim pass a clear-device observation", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      gateQuery: async () => {
        await gate;
      },
    });

    const first = await h.redeem("user_kim", "key-kim", "idem-kim-1");
    const second = await h.redeem("user_liam", "key-liam", "idem-liam-1");
    // Force the pathological case the single-writer lease exists to stop: both
    // claims open for a token at the same instant on the same device.
    await h.openForToken(claimIdOf(first));
    await h.openForToken(claimIdOf(second));

    const firstCall = h.submitToken(
      "user_kim",
      "key-kim",
      claimIdOf(first),
      "device-4:token-a",
    );
    await Promise.resolve();
    const secondCall = h.submitToken(
      "user_liam",
      "key-liam",
      claimIdOf(second),
      "device-4:token-b",
    );
    release!();

    const [firstOutcome, secondOutcome] = await Promise.all([firstCall, secondCall]);
    const statuses = [firstOutcome.status, secondOutcome.status].sort();
    expect(statuses).toEqual(["queued", "reserved"]);
    expect(h.deviceCheck.bits("device-4")).toEqual({ bit0: true, bit1: false });
  });
});
