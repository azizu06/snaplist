import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupClerkTestUsers,
  provisionClerkTestUser,
  type ClerkTestUser,
} from "@/lib/supabase/test-users";

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

function entry(userId: string, key: string) {
  return {
    autopilot_enabled: false,
    cost_basis: 12.5,
    idempotency_key: key,
    photo_paths: [`${userId}/staging/${key}/front.jpg`],
    source: "single" as const,
  };
}

async function stageRun(user: ClerkTestUser, key: string) {
  return admin.rpc("stage_pipeline_batch", {
    p_batch_id: crypto.randomUUID(),
    p_daily_limit: 50,
    p_entries: [entry(user.id, key)],
    p_per_minute_limit: 50,
    p_user_id: user.id,
  });
}

/** Drives a claim to `reserved`, the state the fence treats as device-paid. */
async function reserveClaim(user: ClerkTestUser): Promise<string> {
  const claimId = crypto.randomUUID();
  const created = await admin.rpc("begin_included_offer_claim", {
    p_app_attest_key_id: `key-${claimId}`,
    p_claim_id: claimId,
    p_idempotency_key: `idem-${claimId}`,
    p_state: "queued",
    p_user_id: user.id,
  });
  expect(created.error).toBeNull();
  const advanced = await admin.rpc("transition_included_offer_claim", {
    p_claim_id: claimId,
    p_from: ["queued"],
    p_to: "reserved",
  });
  expect(advanced.error).toBeNull();
  return claimId;
}

beforeAll(async () => {
  reachable = await stackReachable();
  if (!reachable) return;
  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  [userA, userB] = await Promise.all([
    provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "device_fence_a"),
    provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "device_fence_b"),
  ]);
});

afterAll(async () => {
  if (!reachable) return;
  await admin
    .from("included_offer_support_overrides")
    .delete()
    .in("user_id", [userA.id, userB.id]);
  await admin
    .from("included_offer_device_claims")
    .delete()
    .in("user_id", [userA.id, userB.id]);
  await cleanupClerkTestUsers(admin, [userA.id, userB.id]);
});

describe("included-offer device fence at the pre-spend reservation boundary", () => {
  it("refuses the included run for a second account on the same consumed device", async () => {
    if (!reachable) return;

    // Account A redeems the promotion: its claim reached `reserved` because the
    // device's DeviceCheck bit0 was observed clear and then set.
    const claimId = await reserveClaim(userA);
    const first = await stageRun(userA, `fence-a-${crypto.randomUUID()}`);
    expect(first.error).toBeNull();

    const [spent] = (
      await admin
        .from("included_offer_device_claims")
        .select("consumed_at, pipeline_run_id")
        .eq("claim_id", claimId)
    ).data as { consumed_at: string | null; pipeline_run_id: string | null }[];
    expect(spent.consumed_at).not.toBeNull();
    expect(spent.pipeline_run_id).toBe(
      (first.data as { run_id: string }[])[0].run_id,
    );

    // Account B is a different Clerk identity on the same physical device, so
    // its redemption ended `denied_device_consumed` and never reached reserved.
    const runsBefore = await userB.client.from("pipeline_runs").select("id");
    const second = await stageRun(userB, `fence-b-${crypto.randomUUID()}`);
    expect(second.error?.message).toMatch(/device-fence-required/);

    const runsAfter = await userB.client.from("pipeline_runs").select("id");
    expect(runsAfter.data).toEqual(runsBefore.data);
    // No entitlement was minted either: the fence aborts before any spend-capable
    // row exists.
    const reservations = await userB.client
      .from("ai_item_credit_reservations")
      .select("id");
    expect(reservations).toMatchObject({ data: [], error: null });
  });

  it("does not ask the device to pay twice when a restored credit is retried", async () => {
    if (!reachable) return;
    await reserveClaim(userB);
    const first = await stageRun(userB, `restore-${crypto.randomUUID()}`);
    expect(first.error).toBeNull();
    const runId = (first.data as { run_id: string }[])[0].run_id;

    // Cancelling restores the account's included credit through the real seam.
    const canceled = await userB.client.rpc("cancel_pipeline_run", {
      p_run_id: runId,
    });
    expect(canceled.error).toBeNull();

    // The device already paid for this account, so the retry must not demand a
    // second claim the seller can never obtain (bit0 is lifetime-set).
    const retry = await stageRun(userB, `restore-retry-${crypto.randomUUID()}`);
    expect(retry.error).toBeNull();
  });

  it("keeps claim and override rows tenant-private and server-written", async () => {
    if (!reachable) return;
    const claimId = await reserveClaim(userA);
    const overrideId = crypto.randomUUID();
    const granted = await admin.rpc("grant_included_offer_support_override", {
      p_granted_by: "support-agent",
      p_override_id: overrideId,
      p_reason: "shared family device",
      p_user_id: userA.id,
    });
    expect(granted.error).toBeNull();

    await expect(
      userA.client
        .from("included_offer_device_claims")
        .select("claim_id")
        .eq("claim_id", claimId),
    ).resolves.toMatchObject({ data: [{ claim_id: claimId }] });
    await expect(
      userB.client
        .from("included_offer_device_claims")
        .select("claim_id")
        .eq("claim_id", claimId),
    ).resolves.toMatchObject({ data: [] });
    await expect(
      userB.client
        .from("included_offer_support_overrides")
        .select("override_id")
        .eq("override_id", overrideId),
    ).resolves.toMatchObject({ data: [] });

    // Sellers hold no write authority anywhere on the fence.
    const sellerInsert = await userA.client
      .from("included_offer_device_claims")
      .insert({
        app_attest_key_id: "forged",
        claim_id: crypto.randomUUID(),
        idempotency_key: `forged-${crypto.randomUUID()}`,
        state: "reserved",
        user_id: userA.id,
      });
    expect(sellerInsert.error).not.toBeNull();
    const sellerUpdate = await userA.client
      .from("included_offer_device_claims")
      .update({ state: "reserved" })
      .eq("claim_id", claimId);
    expect(sellerUpdate.error).not.toBeNull();

    for (const rpc of [
      "begin_included_offer_claim",
      "transition_included_offer_claim",
      "acquire_included_offer_writer_lease",
      "grant_included_offer_support_override",
      "claim_included_offer_message",
    ]) {
      const call = await userA.client.rpc(rpc, {});
      expect(call.error, `${rpc} must reject seller authority`).not.toBeNull();
    }
  });

  it("holds the claim state machine and the spent-claim record immutable", async () => {
    if (!reachable) return;
    const claimId = await reserveClaim(userA);

    const reTransition = await admin.rpc("transition_included_offer_claim", {
      p_claim_id: claimId,
      p_from: ["reserved"],
      p_to: "denied_device_consumed",
    });
    expect(reTransition.error?.message).toMatch(/already terminal/i);

    const observed = crypto.randomUUID();
    const created = await admin.rpc("begin_included_offer_claim", {
      p_app_attest_key_id: `key-${observed}`,
      p_claim_id: observed,
      p_idempotency_key: `idem-${observed}`,
      p_state: "queued",
      p_user_id: userA.id,
    });
    expect(created.error).toBeNull();
    await admin.rpc("transition_included_offer_claim", {
      p_claim_id: observed,
      p_from: ["queued"],
      p_to: "awaiting_device_token",
    });
    await admin.rpc("transition_included_offer_claim", {
      p_apple_phase: "update",
      p_claim_id: observed,
      p_from: ["awaiting_device_token"],
      p_set_apple_phase: true,
      p_to: "apple_pending",
    });
    // Downgrading the phase would let a later set bit0 read as somebody else's
    // consumption instead of this claim's own write.
    const withdrawn = await admin.rpc("transition_included_offer_claim", {
      p_apple_phase: "query",
      p_claim_id: observed,
      p_from: ["apple_pending"],
      p_set_apple_phase: true,
      p_to: "reconcile_required",
    });
    expect(withdrawn.error?.message).toMatch(/cannot be withdrawn/i);
  });

  it("consumes an audited support override once and only for its own account", async () => {
    if (!reachable) return;
    const claimId = await reserveClaim(userB);
    const overrideId = crypto.randomUUID();
    const granted = await admin.rpc("grant_included_offer_support_override", {
      p_granted_by: "support-agent",
      p_override_id: overrideId,
      p_reason: "device replaced under warranty",
      p_user_id: userB.id,
    });
    expect(granted.error).toBeNull();

    const foreignClaim = await reserveClaim(userA);
    const misdirected = await admin.rpc("consume_included_offer_override", {
      p_claim_id: foreignClaim,
      p_override_id: overrideId,
    });
    expect(misdirected).toMatchObject({ data: false, error: null });

    const consumed = await admin.rpc("consume_included_offer_override", {
      p_claim_id: claimId,
      p_override_id: overrideId,
    });
    expect(consumed).toMatchObject({ data: true, error: null });
    const replay = await admin.rpc("consume_included_offer_override", {
      p_claim_id: claimId,
      p_override_id: overrideId,
    });
    expect(replay).toMatchObject({ data: false, error: null });
  });
});
