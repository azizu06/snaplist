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
  reconcileDeadlineMs?: number;
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
    reconcileDeadlineMs: options?.reconcileDeadlineMs,
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

  it("refuses a rival clear-device observation while a write is unresolved", async () => {
    const h = harness();

    // Mia observes a clear device under the lease, then her update never
    // reaches Apple. The device bit is now indeterminate but spoken for.
    const mia = await h.redeem("user_mia", "key-mia", "idem-mia-1");
    await h.advance();
    h.deviceCheck.failNextUpdate("timeout");
    await expect(
      h.submitToken("user_mia", "key-mia", claimIdOf(mia), "device-5:token-a"),
    ).resolves.toMatchObject({ status: "retry_required" });
    expect(h.deviceCheck.bits("device-5")?.bit0 ?? false).toBe(false);

    // Noah is a different Clerk account on the same physical device. Apple still
    // reports the bit clear, but that clear reading is Mia's to reconcile.
    const noah = await h.redeem("user_noah", "key-noah", "idem-noah-1");
    await h.openForToken(claimIdOf(noah));
    const noahOutcome = await h.submitToken(
      "user_noah",
      "key-noah",
      claimIdOf(noah),
      "device-5:token-b",
    );
    expect(noahOutcome.status).not.toBe("reserved");
    expect(h.deviceCheck.bits("device-5")?.bit0 ?? false).toBe(false);

    // Mia reconciles into the one reservation the device may ever grant, and
    // Noah's retry now reads the bit as consumed by somebody else. Both claims
    // are reopened directly so this stays a test of the lease rather than of
    // the worker's scheduling.
    h.setNow(new Date("2026-07-31T18:10:00.000Z"));
    await h.openForToken(claimIdOf(mia));
    await expect(
      h.submitToken("user_mia", "key-mia", claimIdOf(mia), "device-5:token-c"),
    ).resolves.toEqual({ claimId: claimIdOf(mia), status: "reserved" });

    // Noah's rendezvous window lapsed while the device was indeterminate, so he
    // requeues and is invited again once the bit is finally decided.
    await expect(
      h.submitToken("user_noah", "key-noah", claimIdOf(noah), "device-5:token-d"),
    ).resolves.toMatchObject({ status: "queued" });
    await h.openForToken(claimIdOf(noah));
    await expect(
      h.submitToken("user_noah", "key-noah", claimIdOf(noah), "device-5:token-e"),
    ).resolves.toMatchObject({ status: "denied_device_consumed" });
  });

  it("opens one rendezvous at a time while an earlier claim is unresolved", async () => {
    const h = harness();

    const opal = await h.redeem("user_opal", "key-opal", "idem-opal-1");
    await h.advance();
    h.deviceCheck.failNextUpdate("throttled");
    await expect(
      h.submitToken("user_opal", "key-opal", claimIdOf(opal), "device-6:token-a"),
    ).resolves.toMatchObject({ status: "retry_required" });

    // Opal's claim is still mid-rendezvous, so the worker must not invite the
    // next account to spend a fresh token it can only be refused for.
    const pete = await h.redeem("user_pete", "key-pete", "idem-pete-1");
    await expect(h.advance()).resolves.toEqual({
      acked: [],
      erasing: [],
      expired: [],
      opened: [],
    });
    await expect(
      h.fence.readClaim({ claimId: claimIdOf(pete), userId: "user_pete" }),
    ).resolves.toMatchObject({ status: "queued" });
  });

  it("refuses to set Apple's bit once the writer lease has lapsed", async () => {
    // The lease is what makes a clear reading trustworthy. Dropping it mid-query
    // stands in for a rendezvous that outlived its lease: by the time the write
    // would land, a rival could have taken the lease, spent the device, and let
    // it go again, so the clear reading in hand is stale.
    let dropLease: (() => Promise<void>) | null = null;
    const h = harness({
      async gateQuery() {
        const drop = dropLease;
        dropLease = null;
        await drop?.();
      },
    });

    const quinn = await h.redeem("user_quinn", "key-quinn", "idem-quinn-1");
    await h.advance();
    dropLease = () =>
      h.store.releaseWriterLease({ claimId: claimIdOf(quinn) });

    await expect(
      h.submitToken("user_quinn", "key-quinn", claimIdOf(quinn), "device-11:token-a"),
    ).resolves.toMatchObject({ status: "retry_required" });
    // Nothing was written to Apple, so the device stays genuinely unspent and
    // the seller can still reconcile into it.
    expect(h.deviceCheck.bits("device-11")?.bit0 ?? false).toBe(false);

    await h.openForToken(claimIdOf(quinn));
    await expect(
      h.submitToken("user_quinn", "key-quinn", claimIdOf(quinn), "device-11:token-b"),
    ).resolves.toEqual({ claimId: claimIdOf(quinn), status: "reserved" });
  });

  it("terminalizes an abandoned Apple write instead of blocking the queue forever", async () => {
    const h = harness({ reconcileDeadlineMs: 5 * 60_000 });

    const rosa = await h.redeem("user_rosa", "key-rosa", "idem-rosa-1");
    await h.advance();
    h.deviceCheck.failNextUpdate("unavailable");
    await expect(
      h.submitToken("user_rosa", "key-rosa", claimIdOf(rosa), "device-12:token-a"),
    ).resolves.toMatchObject({ status: "retry_required" });

    // Rosa never comes back. Her unresolved write holds the deployment-wide
    // rendezvous, so Sam cannot be invited while it stands.
    const sam = await h.redeem("user_sam", "key-sam", "idem-sam-1");
    await expect(h.advance()).resolves.toMatchObject({ opened: [] });

    h.setNow(new Date("2026-07-31T18:30:00.000Z"));
    const swept = await h.advance();
    expect(swept.expired).toEqual([claimIdOf(rosa)]);
    // Rosa's own queue message is now terminal, so it retires rather than
    // reopening her, and the next turn belongs to Sam.
    expect(swept.acked).toEqual([claimIdOf(rosa)]);
    await expect(h.advance()).resolves.toMatchObject({
      opened: [claimIdOf(sam)],
    });

    // Rosa loses the offer rather than merely stopping blocking: the device bit
    // may already be set, and only a terminal claim makes the next reading
    // mean what it says.
    await expect(
      h.fence.readClaim({ claimId: claimIdOf(rosa), userId: "user_rosa" }),
    ).resolves.toMatchObject({ status: "denied_apple_unavailable" });
  });

  it("keeps advancing other accounts while one tenant is being erased", async () => {
    const h = harness({ reconcileDeadlineMs: 5 * 60_000 });

    const tess = await h.redeem("user_tess", "key-tess", "idem-tess-1");
    await h.advance();
    h.deviceCheck.failNextUpdate("unavailable");
    await expect(
      h.submitToken("user_tess", "key-tess", claimIdOf(tess), "device-13:token-a"),
    ).resolves.toMatchObject({ status: "retry_required" });

    // Tess asks for her account to be deleted while that write is unresolved.
    // Every write to her claim is fenced from here — including the sweep that
    // would otherwise release the rendezvous she is holding — so the worker has
    // to stop selecting her row rather than abort the whole tick on it.
    h.store.beginAccountErasure("user_tess");

    const uma = await h.redeem("user_uma", "key-uma", "idem-uma-1");
    h.setNow(new Date("2026-07-31T18:30:00.000Z"));

    // Tess's own message is redelivered first, and her claim is long past the
    // reconcile deadline. The tick resolves it and keeps going.
    const tick = await h.advance();
    expect(tick.expired).toEqual([]);
    expect(tick.erasing).toEqual([claimIdOf(tess)]);
    expect(tick.opened).toEqual([]);
    // Her wake-up is retired, not rescheduled. A deferred one comes back as the
    // oldest visible message on the very next tick and is declined again, which
    // is a permanent claim on the queue head rather than a release.
    expect(h.queue.depth()).toBe(1);

    // The next cron tick. Production's period is a minute and the worker's queue
    // visibility timeout is shorter, so anything the previous tick deferred is
    // visible again by now — and the queue hands back the oldest visible
    // message. Reading twice at a single instant cannot see that: the deferred
    // message is merely invisible to the second read.
    h.setNow(new Date("2026-07-31T18:40:00.000Z"));

    // Liveness, which is the whole point: Uma is not held behind a rendezvous
    // that nothing left in the system is allowed to release.
    await expect(h.advance()).resolves.toMatchObject({
      opened: [claimIdOf(uma)],
    });
  });

  it("grants the writer lease past an erasing tenant's unresolved write", async () => {
    const h = harness();

    // Vera observes a clear device under the lease and her update never resolves.
    // The deployment-wide rendezvous is now spoken for by an indeterminate bit.
    const vera = await h.redeem("user_vera", "key-vera", "idem-vera-1");
    await h.advance();
    h.deviceCheck.failNextUpdate("timeout");
    await expect(
      h.submitToken("user_vera", "key-vera", claimIdOf(vera), "device-14:token-a"),
    ).resolves.toMatchObject({ status: "retry_required" });

    // Then she asks for her account to be deleted. Her claim can never reserve
    // from here and the sweep can no longer reach it, so an unresolved write that
    // still outranked the lease would refuse every other account for the length
    // of the erasure — the same stall as the queue head, one seam over.
    h.store.beginAccountErasure("user_vera");

    // Wes is a different account on a different phone. The lease is the only
    // thing standing between him and his own device, and it has to let him past.
    // His claim is opened directly so this tests the lease rather than the
    // worker's scheduling, which the erasure tick above already covers.
    const wes = await h.redeem("user_wes", "key-wes", "idem-wes-1");
    await h.openForToken(claimIdOf(wes));
    await expect(
      h.submitToken("user_wes", "key-wes", claimIdOf(wes), "device-15:token-a"),
    ).resolves.toEqual({ claimId: claimIdOf(wes), status: "reserved" });
  });
});
