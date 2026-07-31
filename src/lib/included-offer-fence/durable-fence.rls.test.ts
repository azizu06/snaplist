import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupClerkTestUsers,
  provisionClerkTestUser,
  type ClerkTestUser,
} from "@/lib/supabase/test-users";
import { canonicalRedemptionRequest, type AppAttestProof } from "./contract";
import {
  createIncludedOfferFence,
  createIncludedOfferRedemptionWorker,
  type IncludedOfferFence,
  type IncludedOfferRedemptionWorker,
} from "./service";
import {
  createSupabaseIncludedOfferClaimStore,
  createSupabaseIncludedOfferRedemptionQueue,
  type IncludedOfferRpcClient,
} from "./supabase-store";
import {
  createFakeAppAttestVerifier,
  createFakeDeviceCheck,
  fakeAssertionFor,
} from "./testing";

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "http://127.0.0.1:54321";
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function stackReachable(): Promise<boolean> {
  if (!ANON_KEY || !SERVICE_ROLE_KEY) return false;
  try {
    return (
      await fetch(`${SUPABASE_URL}/auth/v1/health`, {
        headers: { apikey: ANON_KEY },
        signal: AbortSignal.timeout(2_000),
      })
    ).ok;
  } catch {
    return false;
  }
}

let reachable = false;
let admin: SupabaseClient;
let userA: ClerkTestUser;
let userB: ClerkTestUser;

/** Every token this suite mints resolves to the one shared physical device. */
const SHARED_DEVICE = "device-shared";

interface Harness {
  appAttest: ReturnType<typeof createFakeAppAttestVerifier>;
  deviceCheck: ReturnType<typeof createFakeDeviceCheck>;
  fence: IncludedOfferFence;
  worker: IncludedOfferRedemptionWorker;
}

function harness(includedAvailable: (userId: string) => boolean): Harness {
  const appAttest = createFakeAppAttestVerifier({});
  const deviceCheck = createFakeDeviceCheck({ deviceForToken: () => SHARED_DEVICE });
  const rpc = admin as unknown as IncludedOfferRpcClient;
  const composition = {
    appAttest,
    deviceCheck,
    includedAllowance: {
      async isIncludedRunAvailable(userId: string) {
        return includedAvailable(userId);
      },
    },
    queue: createSupabaseIncludedOfferRedemptionQueue(rpc),
    store: createSupabaseIncludedOfferClaimStore(rpc),
    tokenWindowMs: 30_000,
  };
  return {
    appAttest,
    deviceCheck,
    fence: createIncludedOfferFence(composition),
    worker: createIncludedOfferRedemptionWorker(composition),
  };
}

function proofFor(
  harnessed: Harness,
  keyId: string,
  requestBody: Uint8Array,
): AppAttestProof {
  return {
    assertionObject: fakeAssertionFor(requestBody),
    challengeId: harnessed.appAttest.issueChallenge(keyId),
    keyId,
  };
}

/**
 * Drives the worker until it opens this claim's token window. The queue is a
 * strict single-writer head, so a claim waits its turn exactly as in production.
 */
async function openTokenWindow(
  harnessed: Harness,
  claimId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { opened } = await harnessed.worker.advance();
    if (opened.includes(claimId)) return;
  }
  throw new Error(`worker never opened claim ${claimId}`);
}

/**
 * Fast-forwards a deferred claim's retry backoff. Production waits out the queue
 * visibility timeout; the test makes the message visible now instead of sleeping.
 */
async function expireRetryBackoff(claimId: string): Promise<void> {
  const claim = await admin
    .from("included_offer_device_claims")
    .select("queue_message_id")
    .eq("claim_id", claimId)
    .single();
  expect(claim.error).toBeNull();
  const messageId = (claim.data as { queue_message_id: number }).queue_message_id;
  const deferred = await admin.rpc("defer_included_offer_message", {
    p_message_id: messageId,
    p_visibility_timeout_seconds: 0,
  });
  expect(deferred).toMatchObject({ data: true, error: null });
}

/** Redeem, let the worker open the claim, then rendezvous with a fresh token. */
async function redeemThroughDevice(
  harnessed: Harness,
  user: ClerkTestUser,
  keyId: string,
) {
  harnessed.appAttest.attest(keyId);
  const idempotencyKey = `durable-${crypto.randomUUID()}`;
  const queued = await harnessed.fence.redeem({
    appAttest: proofFor(
      harnessed,
      keyId,
      canonicalRedemptionRequest({
        action: "included-offer.redeem",
        idempotencyKey,
        userId: user.id,
      }),
    ),
    idempotencyKey,
    userId: user.id,
  });
  if (queued.status !== "queued") return queued;

  await openTokenWindow(harnessed, queued.claimId);
  return harnessed.fence.submitDeviceToken({
    appAttest: proofFor(
      harnessed,
      keyId,
      canonicalRedemptionRequest({
        action: "included-offer.device-token",
        claimId: queued.claimId,
        userId: user.id,
      }),
    ),
    claimId: queued.claimId,
    deviceToken: `token-${crypto.randomUUID()}`,
    userId: user.id,
  });
}

beforeAll(async () => {
  reachable = await stackReachable();
  if (!reachable) return;
  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  [userA, userB] = await Promise.all([
    provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "durable_fence_a"),
    provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "durable_fence_b"),
  ]);
});

/** Empties the shared single-writer queue so each test owns the head. */
async function drainQueue(): Promise<void> {
  for (let drained = 0; drained < 50; drained += 1) {
    const claimed = await admin.rpc("claim_included_offer_message", {
      p_visibility_timeout_seconds: 1,
    });
    const rows = (claimed.data ?? []) as { message_id: number }[];
    if (rows.length === 0) return;
    await admin.rpc("ack_included_offer_message", {
      p_message_id: rows[0].message_id,
    });
  }
}

beforeEach(async () => {
  if (!reachable) return;
  await drainQueue();
});

afterAll(async () => {
  if (!reachable) return;
  await drainQueue();
  await admin
    .from("included_offer_device_claims")
    .delete()
    .in("user_id", [userA.id, userB.id]);
  await cleanupClerkTestUsers(admin, [userA.id, userB.id]);
});

describe("durable included-offer fence over Postgres", () => {
  it("grants one account and denies a second Clerk identity on the same device", async () => {
    if (!reachable) return;
    const harnessed = harness(() => true);

    const first = await redeemThroughDevice(harnessed, userA, "key-a");
    expect(first).toMatchObject({ status: "reserved" });
    expect(harnessed.deviceCheck.bits(SHARED_DEVICE)).toEqual({
      bit0: true,
      bit1: false,
    });

    const second = await redeemThroughDevice(harnessed, userB, "key-b");
    expect(second).toMatchObject({
      appealPath: "support-override",
      status: "denied_device_consumed",
    });

    // The denial is durable, not a per-request decision.
    const stored = await admin
      .from("included_offer_device_claims")
      .select("state, user_id")
      .in("user_id", [userA.id, userB.id]);
    expect(stored.data).toEqual(
      expect.arrayContaining([
        { state: "reserved", user_id: userA.id },
        { state: "denied_device_consumed", user_id: userB.id },
      ]),
    );
  });

  it("never turns an ambiguous Apple outcome into unused eligibility", async () => {
    if (!reachable) return;
    const harnessed = harness(() => true);
    harnessed.deviceCheck.failNextQuery("throttled");

    const attempt = await redeemThroughDevice(harnessed, userA, "key-throttled");
    expect(attempt).toMatchObject({
      paidPathAvailable: true,
      reason: "throttled",
      status: "retry_required",
    });
    const stored = await admin
      .from("included_offer_device_claims")
      .select("apple_phase, state")
      .eq("user_id", userA.id)
      .eq("state", "reconcile_required");
    expect(stored.data).toEqual([
      { apple_phase: "query", state: "reconcile_required" },
    ]);
  });

  it("reconciles an ambiguous update that actually reached Apple as its own", async () => {
    if (!reachable) return;
    const harnessed = harness(() => true);
    harnessed.appAttest.attest("key-reconcile");
    harnessed.deviceCheck.failNextUpdateAfterApplying("timeout");

    const deferred = await redeemThroughDevice(
      harnessed,
      userB,
      "key-reconcile",
    );
    expect(deferred).toMatchObject({ status: "retry_required" });
    if (deferred.status !== "retry_required") return;
    // Apple now reports bit0 set. Because this claim observed the device clear
    // while holding the writer lease, the set bit can only be its own write.
    expect(harnessed.deviceCheck.bits(SHARED_DEVICE)).toEqual({
      bit0: true,
      bit1: false,
    });

    await expireRetryBackoff(deferred.claimId);
    await openTokenWindow(harnessed, deferred.claimId);
    const retried = await harnessed.fence.submitDeviceToken({
      appAttest: proofFor(
        harnessed,
        "key-reconcile",
        canonicalRedemptionRequest({
          action: "included-offer.device-token",
          claimId: deferred.claimId,
          userId: userB.id,
        }),
      ),
      claimId: deferred.claimId,
      deviceToken: `token-${crypto.randomUUID()}`,
      userId: userB.id,
    });
    expect(retried).toMatchObject({ status: "reserved" });
  });

  it("resumes the original claim for an exact same-key replay", async () => {
    if (!reachable) return;
    const harnessed = harness(() => true);
    harnessed.appAttest.attest("key-replay");
    const idempotencyKey = `replay-${crypto.randomUUID()}`;
    const body = canonicalRedemptionRequest({
      action: "included-offer.redeem",
      idempotencyKey,
      userId: userA.id,
    });

    const first = await harnessed.fence.redeem({
      appAttest: proofFor(harnessed, "key-replay", body),
      idempotencyKey,
      userId: userA.id,
    });
    const replay = await harnessed.fence.redeem({
      appAttest: proofFor(harnessed, "key-replay", body),
      idempotencyKey,
      userId: userA.id,
    });
    expect(first.status).toBe("queued");
    expect(replay).toMatchObject({
      claimId: first.status === "queued" ? first.claimId : "",
    });

    const rows = await admin
      .from("included_offer_device_claims")
      .select("claim_id")
      .eq("user_id", userA.id)
      .eq("idempotency_key", idempotencyKey);
    expect(rows.data).toHaveLength(1);
  });

  it("keeps the ephemeral device token out of every durable surface", async () => {
    if (!reachable) return;
    const harnessed = harness(() => true);
    await redeemThroughDevice(harnessed, userA, "key-secrecy");

    const tokens = harnessed.deviceCheck.seenTokens();
    expect(tokens.length).toBeGreaterThan(0);

    const claims = await admin
      .from("included_offer_device_claims")
      .select("*")
      .in("user_id", [userA.id, userB.id]);
    const durable = JSON.stringify(claims.data);
    for (const token of tokens) {
      expect(durable).not.toContain(token);
    }
    // There is no device-token column to leak into, only the token *deadline*.
    for (const row of (claims.data ?? []) as Record<string, unknown>[]) {
      const columns = Object.keys(row);
      expect(columns).not.toContain("device_token");
      expect(columns.filter((column) => /token/i.test(column))).toEqual([
        "token_deadline_at",
      ]);
    }
  });

  it("denies only the account promotion when the ledger already spent it", async () => {
    if (!reachable) return;
    const harnessed = harness(() => false);
    harnessed.appAttest.attest("key-spent");
    const idempotencyKey = `spent-${crypto.randomUUID()}`;

    const outcome = await harnessed.fence.redeem({
      appAttest: proofFor(
        harnessed,
        "key-spent",
        canonicalRedemptionRequest({
          action: "included-offer.redeem",
          idempotencyKey,
          userId: userB.id,
        }),
      ),
      idempotencyKey,
      userId: userB.id,
    });
    expect(outcome).toEqual({
      paidPathAvailable: true,
      status: "denied_account_consumed",
    });
    // An account-side denial must not touch the device's lifetime bit.
    const rows = await admin
      .from("included_offer_device_claims")
      .select("claim_id")
      .eq("idempotency_key", idempotencyKey);
    expect(rows.data).toEqual([]);
  });

  it("serializes Apple's query-and-set window through one global writer", async () => {
    if (!reachable) return;
    const holder = crypto.randomUUID();
    const rival = crypto.randomUUID();

    const held = await admin.rpc("acquire_included_offer_writer_lease", {
      p_claim_id: holder,
      p_lease_seconds: 30,
    });
    expect(held).toMatchObject({ data: true, error: null });
    const blocked = await admin.rpc("acquire_included_offer_writer_lease", {
      p_claim_id: rival,
      p_lease_seconds: 30,
    });
    expect(blocked).toMatchObject({ data: false, error: null });
    // Reentrancy for the holder keeps a redelivered message from deadlocking.
    const reentrant = await admin.rpc("acquire_included_offer_writer_lease", {
      p_claim_id: holder,
      p_lease_seconds: 30,
    });
    expect(reentrant).toMatchObject({ data: true, error: null });

    const released = await admin.rpc("release_included_offer_writer_lease", {
      p_claim_id: holder,
    });
    expect(released).toMatchObject({ data: true, error: null });
    const afterRelease = await admin.rpc("acquire_included_offer_writer_lease", {
      p_claim_id: rival,
      p_lease_seconds: 1,
    });
    expect(afterRelease).toMatchObject({ data: true, error: null });
    await admin.rpc("release_included_offer_writer_lease", { p_claim_id: rival });
  });

  it("carries claim identity only through the redemption queue", async () => {
    if (!reachable) return;
    const claimId = crypto.randomUUID();
    const created = await admin.rpc("begin_included_offer_claim", {
      p_app_attest_key_id: `key-${claimId}`,
      p_claim_id: claimId,
      p_idempotency_key: `idem-${claimId}`,
      p_state: "queued",
      p_user_id: userA.id,
    });
    expect(created.error).toBeNull();

    const enqueued = await admin.rpc("enqueue_included_offer_claim", {
      p_claim_id: claimId,
      p_schema_version: 1,
    });
    expect(enqueued.error).toBeNull();
    // Re-enqueueing the same claim returns the existing message rather than
    // duplicating work behind the single-writer lease.
    const again = await admin.rpc("enqueue_included_offer_claim", {
      p_claim_id: claimId,
      p_schema_version: 1,
    });
    expect(String(again.data)).toBe(String(enqueued.data));

    const claimed = await admin.rpc("claim_included_offer_message", {
      p_visibility_timeout_seconds: 30,
    });
    expect(claimed.error).toBeNull();
    const message = (claimed.data as { envelope: unknown; message_id: number }[])[0];
    expect(message.envelope).toEqual({ claim_id: claimId, schema_version: 1 });
    await admin.rpc("ack_included_offer_message", { p_message_id: message.message_id });
  });
});
