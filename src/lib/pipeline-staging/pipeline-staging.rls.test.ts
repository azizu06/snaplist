import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  cleanupClerkTestUsers,
  grantIncludedOfferDeviceClaim,
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

let reachable = false;
let admin: SupabaseClient;
let userA: ClerkTestUser;
let userB: ClerkTestUser;
let mixedUserA: ClerkTestUser;
let mixedUserB: ClerkTestUser;
const messageIds = new Set<string>();

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

function entry(userId: string, key: string, source: "single" | "batch" = "single") {
  return {
    idempotency_key: key,
    source,
    autopilot_enabled: false,
    photo_paths: [
      `${userId}/staging/${key}/front.jpg`,
      `${userId}/staging/${key}/back.jpg`,
    ],
    cost_basis: 12.5,
  };
}

beforeAll(async () => {
  reachable = await stackReachable();
  if (!reachable) return;
  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  [userA, userB, mixedUserA, mixedUserB] = await Promise.all([
    provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "pipeline_stage_a"),
    provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "pipeline_stage_b"),
    provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "pipeline_mixed_a"),
    provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "pipeline_mixed_b"),
  ]);
  // Staging is not the device fence's seam; these tenants only need to have
  // passed it so their included first run can reserve at all (#524).
  await Promise.all(
    [userA, userB, mixedUserA, mixedUserB].map((user) =>
      grantIncludedOfferDeviceClaim(admin, user.id),
    ),
  );
});

afterAll(async () => {
  if (!reachable) return;
  await Promise.all(
    [...messageIds].map((messageId) =>
      admin.rpc("ack_pipeline_message", { p_message_id: messageId }),
    ),
  );
  await cleanupClerkTestUsers(admin, [
    userA.id,
    userB.id,
    mixedUserA.id,
    mixedUserB.id,
  ]);
});

describe("durable pipeline staging RPC and RLS", () => {
  it("records exact seller/batch staging paths through a service-only cleanup seam", async () => {
    if (!reachable) return;
    const cleanupId = crypto.randomUUID();
    const batchId = crypto.randomUUID();
    const paths = [
      `${userA.id}/pipeline-staging/${batchId}/0/0-${crypto.randomUUID()}.jpg`,
    ];
    const args = {
      p_cleanup_id: cleanupId,
      p_user_id: userA.id,
      p_batch_id: batchId,
      p_photo_paths: paths,
    };

    const sellerCall = await userA.client.rpc(
      "record_pipeline_staging_cleanup_intent",
      args,
    );
    expect(sellerCall.error).not.toBeNull();

    const invalidPrefix = await admin.rpc(
      "record_pipeline_staging_cleanup_intent",
      { ...args, p_photo_paths: [`${userB.id}/pipeline-staging/${batchId}/0/photo.jpg`] },
    );
    expect(invalidPrefix.error?.message).toMatch(/cleanup path/i);

    const first = await admin.rpc("record_pipeline_staging_cleanup_intent", args);
    expect(first).toMatchObject({ data: true, error: null });
    const repeated = await admin.rpc("record_pipeline_staging_cleanup_intent", args);
    expect(repeated).toMatchObject({ data: false, error: null });

    const conflicting = await admin.rpc(
      "record_pipeline_staging_cleanup_intent",
      { ...args, p_photo_paths: [...paths, `${userA.id}/pipeline-staging/${batchId}/0/other.jpg`] },
    );
    expect(conflicting.error?.message).toMatch(/conflicts/i);

    const resolved = await admin.rpc("resolve_pipeline_staging_cleanup_intent", {
      p_cleanup_id: cleanupId,
    });
    expect(resolved).toMatchObject({ data: true, error: null });
    const resolvedAgain = await admin.rpc("resolve_pipeline_staging_cleanup_intent", {
      p_cleanup_id: cleanupId,
    });
    expect(resolvedAgain).toMatchObject({ data: false, error: null });
  });

  it("atomically stages ordered photos, one run, and one identifiers-only message", async () => {
    if (!reachable) return;
    const batchId = crypto.randomUUID();
    const idempotencyKey = `stage-${crypto.randomUUID()}`;
    const args = {
      p_user_id: userA.id,
      p_batch_id: batchId,
      p_entries: [entry(userA.id, idempotencyKey)],
      p_daily_limit: 15,
      p_per_minute_limit: 20,
    };

    const first = await admin.rpc("stage_pipeline_batch", args);
    expect(first.error).toBeNull();
    const rows = first.data as Array<{
      item_id: string;
      run_id: string;
      queue_message_id: number;
      batch_position: number;
    }>;
    expect(rows).toHaveLength(1);
    messageIds.add(String(rows[0].queue_message_id));

    const repeated = await admin.rpc("stage_pipeline_batch", args);
    expect(repeated.error).toBeNull();
    expect(repeated.data).toEqual(first.data);

    const replay = await admin.rpc("find_pipeline_batch_replay", {
      p_user_id: userA.id,
      p_batch_id: batchId,
      p_entries: [{
        idempotency_key: idempotencyKey,
        source: "single",
        autopilot_enabled: false,
        photo_count: 2,
        cost_basis: 12.5,
      }],
    });
    expect(replay).toMatchObject({ data: first.data, error: null });

    const conflictingReplay = await admin.rpc("find_pipeline_batch_replay", {
      p_user_id: userA.id,
      p_batch_id: batchId,
      p_entries: [{
        idempotency_key: idempotencyKey,
        source: "single",
        autopilot_enabled: false,
        photo_count: 2,
        cost_basis: 99,
      }],
    });
    expect(conflictingReplay.error).not.toBeNull();

    const { data: item } = await userA.client
      .from("items")
      .select("photos, cost_basis")
      .eq("id", rows[0].item_id)
      .single();
    expect(item?.photos).toEqual(entry(userA.id, idempotencyKey).photo_paths);
    expect(Number(item?.cost_basis)).toBe(12.5);

    const { data: ownRuns } = await userA.client
      .from("pipeline_runs")
      .select("id, batch_id, batch_position, capture_input")
      .eq("id", rows[0].run_id);
    expect(ownRuns).toEqual([
      {
        id: rows[0].run_id,
        batch_id: batchId,
        batch_position: 0,
        capture_input: {
          source: "single",
          autopilot_enabled: false,
          photo_count: 2,
        },
      },
    ]);

    const { data: crossTenant } = await userB.client
      .from("pipeline_runs")
      .select("id")
      .eq("id", rows[0].run_id);
    expect(crossTenant).toEqual([]);

    const claimed = await admin.rpc("claim_pipeline_messages", {
      p_quantity: 100,
      p_visibility_timeout_seconds: 60,
    });
    expect(claimed.error).toBeNull();
    const ownMessage = (claimed.data as Array<Record<string, unknown>>).find(
      (row) => String(row.message_id) === String(rows[0].queue_message_id),
    );
    expect(ownMessage?.envelope).toEqual({
      run_id: rows[0].run_id,
      schema_version: 1,
    });
  });

  it("rejects seller RPC access, forged photo ownership, and atomic over-cap batches", async () => {
    if (!reachable) return;
    const sellerCall = await userA.client.rpc("stage_pipeline_batch", {
      p_user_id: userA.id,
      p_batch_id: crypto.randomUUID(),
      p_entries: [entry(userA.id, `seller-${crypto.randomUUID()}`)],
      p_daily_limit: 15,
      p_per_minute_limit: 20,
    });
    expect(sellerCall.error).not.toBeNull();

    const forged = await admin.rpc("stage_pipeline_batch", {
      p_user_id: userA.id,
      p_batch_id: crypto.randomUUID(),
      p_entries: [entry(userB.id, `forged-${crypto.randomUUID()}`)],
      p_daily_limit: 15,
      p_per_minute_limit: 20,
    });
    expect(forged.error).not.toBeNull();

    const batchId = crypto.randomUUID();
    const before = await userB.client
      .from("pipeline_runs")
      .select("id", { count: "exact", head: true });
    const overCap = await admin.rpc("stage_pipeline_batch", {
      p_user_id: userB.id,
      p_batch_id: batchId,
      p_entries: [
        entry(userB.id, `cap-a-${crypto.randomUUID()}`, "batch"),
        entry(userB.id, `cap-b-${crypto.randomUUID()}`, "batch"),
      ],
      p_daily_limit: 1,
      p_per_minute_limit: 1,
    });
    expect(overCap.error).not.toBeNull();
    const after = await userB.client
      .from("pipeline_runs")
      .select("id", { count: "exact", head: true });
    expect(after.count).toBe(before.count);
  });

  it("releases daily capacity only once and only after failed/canceled terminal state", async () => {
    if (!reachable) return;
    const staged = await admin.rpc("stage_pipeline_batch", {
      p_user_id: userB.id,
      p_batch_id: crypto.randomUUID(),
      p_entries: [entry(userB.id, `release-${crypto.randomUUID()}`)],
      p_daily_limit: 15,
      p_per_minute_limit: 20,
    });
    expect(staged.error).toBeNull();
    const row = (staged.data as Array<{ run_id: string; queue_message_id: number }>)[0];
    messageIds.add(String(row.queue_message_id));

    const premature = await admin.rpc("release_pipeline_run_daily_reservation", {
      p_run_id: row.run_id,
    });
    expect(premature.error).not.toBeNull();

    const claimed = await admin.rpc("claim_pipeline_run_attempt", {
      p_lease_seconds: 60,
      p_message_id: row.queue_message_id,
      p_run_id: row.run_id,
    });
    expect(claimed.error).toBeNull();
    const leaseToken = (
      claimed.data as { context: { run: { lease_token: string } } }
    ).context.run.lease_token;

    const failed = await admin.rpc("finish_pipeline_run_attempt", {
      p_failure_code: "staging_failed",
      p_failure_message: "We couldn't finish staging this item.",
      p_lease_token: leaseToken,
      p_retry_after_seconds: 30,
      p_retryable: false,
      p_run_id: row.run_id,
    });
    expect(failed.error).toBeNull();
    expect(failed.data).toMatchObject({ status: "failed" });

    const released = await admin.rpc("release_pipeline_run_daily_reservation", {
      p_run_id: row.run_id,
    });
    expect(released).toMatchObject({ data: false, error: null });

    const { data: item } = await userB.client
      .from("items")
      .select("photos")
      .eq("id", (staged.data as Array<{ item_id: string }>)[0].item_id)
      .single();
    expect(item?.photos).toHaveLength(2);
  });

  it("shares daily capacity across legacy and durable entry points without crossing tenants", async () => {
    if (!reachable) return;
    const legacyReservationId = crypto.randomUUID();
    const legacyArgs = {
      p_reservation_id: legacyReservationId,
      p_user_id: mixedUserA.id,
      p_daily_limit: 1,
      p_per_minute_limit: 10,
    };

    const legacy = await admin.rpc("reserve_legacy_pipeline_usage", legacyArgs);
    expect(legacy).toMatchObject({ data: true, error: null });
    const repeated = await admin.rpc("reserve_legacy_pipeline_usage", legacyArgs);
    expect(repeated).toMatchObject({ data: false, error: null });

    const durableBlocked = await admin.rpc("stage_pipeline_batch", {
      p_user_id: mixedUserA.id,
      p_batch_id: crypto.randomUUID(),
      p_entries: [entry(mixedUserA.id, `mixed-blocked-${crypto.randomUUID()}`)],
      p_daily_limit: 1,
      p_per_minute_limit: 10,
    });
    expect(durableBlocked.error?.message).toMatch(/daily capacity/i);

    const durableMinuteBlocked = await admin.rpc("stage_pipeline_batch", {
      p_user_id: mixedUserA.id,
      p_batch_id: crypto.randomUUID(),
      p_entries: [entry(mixedUserA.id, `mixed-minute-${crypto.randomUUID()}`)],
      p_daily_limit: 10,
      p_per_minute_limit: 1,
    });
    expect(durableMinuteBlocked.error?.message).toMatch(/per-minute capacity/i);

    const otherTenant = await admin.rpc("stage_pipeline_batch", {
      p_user_id: mixedUserB.id,
      p_batch_id: crypto.randomUUID(),
      p_entries: [entry(mixedUserB.id, `mixed-other-${crypto.randomUUID()}`)],
      p_daily_limit: 1,
      p_per_minute_limit: 10,
    });
    expect(otherTenant.error).toBeNull();
    const otherRow = (otherTenant.data as Array<{
      queue_message_id: number;
    }>)[0];
    messageIds.add(String(otherRow.queue_message_id));

    const legacyMinuteBlocked = await admin.rpc("reserve_legacy_pipeline_usage", {
      p_reservation_id: crypto.randomUUID(),
      p_user_id: mixedUserB.id,
      p_daily_limit: 10,
      p_per_minute_limit: 1,
    });
    expect(legacyMinuteBlocked.error?.message).toMatch(/per-minute capacity/i);

    const released = await admin.rpc("release_legacy_pipeline_usage", {
      p_reservation_id: legacyReservationId,
    });
    expect(released).toMatchObject({ data: true, error: null });
    const releasedAgain = await admin.rpc("release_legacy_pipeline_usage", {
      p_reservation_id: legacyReservationId,
    });
    expect(releasedAgain).toMatchObject({ data: false, error: null });

    const durable = await admin.rpc("stage_pipeline_batch", {
      p_user_id: mixedUserA.id,
      p_batch_id: crypto.randomUUID(),
      p_entries: [entry(mixedUserA.id, `mixed-durable-${crypto.randomUUID()}`)],
      p_daily_limit: 1,
      p_per_minute_limit: 10,
    });
    expect(durable.error).toBeNull();
    const durableRow = (durable.data as Array<{
      queue_message_id: number;
    }>)[0];
    messageIds.add(String(durableRow.queue_message_id));

    const legacyBlocked = await admin.rpc("reserve_legacy_pipeline_usage", {
      p_reservation_id: crypto.randomUUID(),
      p_user_id: mixedUserA.id,
      p_daily_limit: 1,
      p_per_minute_limit: 10,
    });
    expect(legacyBlocked.error?.message).toMatch(/daily capacity/i);

    const sellerCall = await mixedUserA.client.rpc(
      "reserve_legacy_pipeline_usage",
      legacyArgs,
    );
    expect(sellerCall.error).not.toBeNull();
  });
});
