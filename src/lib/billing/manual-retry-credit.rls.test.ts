import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { PipelineResult } from "@/lib/pipeline";
import {
  createSupabasePipelineWorkerStore,
  type PipelineAttemptAcquisition,
  type PipelineWorkerRpcClient,
} from "@/lib/pipeline-queue/worker-store";
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

const RESULT: PipelineResult = {
  attributes: { brand: "Sony", model: "WH-1000XM4", condition: "good" },
  identification: { label: "Sony WH-1000XM4", confident: true, evidence: 1 },
  price: {
    suggested: 149,
    range: { min: 130, max: 170 },
    confidence: 0.8,
    sources: [],
    tier: "llm-only",
  },
  confidence: { score: 0.86, band: "high", autopilotEligible: true },
  listing: {
    platform: "ebay",
    title: "Sony WH-1000XM4 Headphones",
    description: "Used headphones in good condition.",
    fields: { itemSpecifics: { Brand: "Sony" } },
  },
  model: "offline-vision",
  listingModel: "offline-listing",
};

interface StagedRun {
  item_id: string;
  run_id: string;
  queue_message_id: string | number;
}

let reachable = false;
let admin: SupabaseClient;
let seller: ClerkTestUser;
let otherSeller: ClerkTestUser;
let concurrentSeller: ClerkTestUser;
const queueMessageIds = new Set<string>();

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

function acquired(
  value: PipelineAttemptAcquisition,
): Extract<PipelineAttemptAcquisition, { kind: "acquired" }> {
  expect(value.kind).toBe("acquired");
  return value as Extract<PipelineAttemptAcquisition, { kind: "acquired" }>;
}

async function stageRun(
  key: string,
  owner: ClerkTestUser = seller,
): Promise<StagedRun> {
  const batchId = crypto.randomUUID();
  const staged = await admin.rpc("stage_pipeline_batch", {
    p_batch_id: batchId,
    p_daily_limit: 1_000,
    p_entries: [
      {
        idempotency_key: key,
        source: "single",
        autopilot_enabled: false,
        photo_paths: [`${owner.id}/manual-retry/${batchId}/front.jpg`],
        cost_basis: null,
      },
    ],
    p_per_minute_limit: 1_000,
    p_user_id: owner.id,
  });
  if (staged.error) throw new Error(staged.error.message);
  const run = (staged.data as StagedRun[])[0];
  queueMessageIds.add(String(run.queue_message_id));
  return run;
}

beforeAll(async () => {
  reachable = await stackReachable();
  if (!reachable) return;
  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  [seller, otherSeller, concurrentSeller] = await Promise.all([
    provisionClerkTestUser(
      SUPABASE_URL,
      ANON_KEY!,
      "manual_retry_credit",
    ),
    provisionClerkTestUser(
      SUPABASE_URL,
      ANON_KEY!,
      "manual_retry_credit_other",
    ),
    provisionClerkTestUser(
      SUPABASE_URL,
      ANON_KEY!,
      "manual_retry_credit_concurrent",
    ),
  ]);
});

afterAll(async () => {
  if (!reachable) return;
  await Promise.all(
    [...queueMessageIds].map((messageId) =>
      admin.rpc("ack_pipeline_message", { p_message_id: messageId }),
    ),
  );
  await cleanupClerkTestUsers(admin, [
    seller.id,
    otherSeller.id,
    concurrentSeller.id,
  ]);
});

describe("manual retry AI-item credit accounting", () => {
  it("settles the same restored reservation after a failed run is retried", async () => {
    if (!reachable) return;
    const run = await stageRun("manual-retry-after-failure");
    const store = createSupabasePipelineWorkerStore(
      admin as unknown as PipelineWorkerRpcClient,
    );
    const failedAttempt = acquired(
      await store.acquire({
        runId: run.run_id,
        messageId: String(run.queue_message_id),
        leaseSeconds: 60,
      }),
    );
    await store.failAttempt({
      runId: run.run_id,
      leaseToken: failedAttempt.context.run.lease_token,
      retryable: false,
      retryAfterSeconds: 1,
      failureCode: "invalid_pipeline_result",
      safeFailureMessage: "The generated listing did not pass validation.",
    });

    const { data: restored } = await seller.client
      .from("ai_item_credit_reservations")
      .select("id, state, restored_at")
      .eq("pipeline_run_id", run.run_id)
      .single();
    expect(restored).toMatchObject({
      state: "restored",
      restored_at: expect.any(String),
    });

    const retried = await seller.client.rpc("retry_pipeline_run", {
      p_run_id: run.run_id,
    });
    expect(retried.error).toBeNull();
    expect(retried.data).toMatchObject({ status: "queued" });
    const retryMessageId = String(retried.data.queueMessageId);
    queueMessageIds.add(retryMessageId);

    const repeated = await seller.client.rpc("retry_pipeline_run", {
      p_run_id: run.run_id,
    });
    expect(repeated).toMatchObject({
      error: null,
      data: { status: "queued", queueMessageId: retried.data.queueMessageId },
    });
    const entitlementDuringRetry = await admin.rpc(
      "get_verified_ai_item_entitlement",
      { p_user_id: seller.id },
    );
    expect(entitlementDuringRetry.error).toBeNull();
    expect(entitlementDuringRetry.data).toEqual([
      expect.objectContaining({
        billing_source: "included",
        remaining_items: 0,
      }),
    ]);

    const retryAttempt = acquired(
      await store.acquire({
        runId: run.run_id,
        messageId: retryMessageId,
        leaseSeconds: 60,
      }),
    );
    await store.checkpoint({
      runId: run.run_id,
      leaseToken: retryAttempt.context.run.lease_token,
      stage: "generating",
      checkpoint: {
        identified: {
          attributes: RESULT.attributes,
          identification: RESULT.identification,
          model: RESULT.model,
        },
        priced: RESULT.price,
        generated: { copy: RESULT.listing, model: RESULT.listingModel! },
      },
      leaseSeconds: 60,
    });
    const completed = await store.complete({
      runId: run.run_id,
      leaseToken: retryAttempt.context.run.lease_token,
      result: RESULT,
      autopilotEnabled: false,
    });

    const { data: settled } = await seller.client
      .from("ai_item_credit_reservations")
      .select(
        "id, pipeline_run_id, state, restored_at, settled_at, listing_id, retry_reservation_count, retry_restore_count",
      )
      .eq("pipeline_run_id", run.run_id)
      .single();
    expect(settled).toMatchObject({
      id: restored?.id,
      pipeline_run_id: run.run_id,
      state: "settled",
      restored_at: restored?.restored_at,
      settled_at: expect.any(String),
      listing_id: completed.listingId,
      retry_reservation_count: 1,
      retry_restore_count: 0,
    });
    const { count: reservationCount } = await seller.client
      .from("ai_item_credit_reservations")
      .select("id", { count: "exact", head: true })
      .eq("pipeline_run_id", run.run_id);
    const { count: runCount } = await seller.client
      .from("pipeline_runs")
      .select("id", { count: "exact", head: true })
      .eq("id", run.run_id);
    expect({ reservationCount, runCount }).toEqual({
      reservationCount: 1,
      runCount: 1,
    });
  }, 20_000);

  it("restores a canceled retry once, reclaims it again, and ignores delayed completion replay", async () => {
    if (!reachable) return;
    const run = await stageRun("manual-retry-after-cancel", otherSeller);
    const store = createSupabasePipelineWorkerStore(
      admin as unknown as PipelineWorkerRpcClient,
    );

    const canceled = await otherSeller.client.rpc("cancel_pipeline_run", {
      p_run_id: run.run_id,
    });
    expect(canceled).toMatchObject({ error: null, data: { status: "canceled" } });
    const foreignRetry = await seller.client.rpc("retry_pipeline_run", {
      p_run_id: run.run_id,
    });
    expect(foreignRetry.error?.message).toMatch(/not found/i);

    const firstRetry = await otherSeller.client.rpc("retry_pipeline_run", {
      p_run_id: run.run_id,
    });
    expect(firstRetry).toMatchObject({ error: null, data: { status: "queued" } });
    const firstRetryMessageId = String(firstRetry.data.queueMessageId);
    queueMessageIds.add(firstRetryMessageId);
    const firstRetryCancel = await otherSeller.client.rpc("cancel_pipeline_run", {
      p_run_id: run.run_id,
    });
    expect(firstRetryCancel).toMatchObject({
      error: null,
      data: { status: "canceled" },
    });
    const repeatedCancel = await otherSeller.client.rpc("cancel_pipeline_run", {
      p_run_id: run.run_id,
    });
    expect(repeatedCancel).toMatchObject({
      error: null,
      data: { status: "canceled" },
    });
    const { data: restoredAgain } = await otherSeller.client
      .from("ai_item_credit_reservations")
      .select("state, retry_reservation_count, retry_restore_count")
      .eq("pipeline_run_id", run.run_id)
      .single();
    expect(restoredAgain).toEqual({
      state: "restored",
      retry_reservation_count: 1,
      retry_restore_count: 1,
    });

    const secondRetry = await otherSeller.client.rpc("retry_pipeline_run", {
      p_run_id: run.run_id,
    });
    expect(secondRetry).toMatchObject({ error: null, data: { status: "queued" } });
    const secondRetryMessageId = String(secondRetry.data.queueMessageId);
    queueMessageIds.add(secondRetryMessageId);
    const retryAttempt = acquired(
      await store.acquire({
        runId: run.run_id,
        messageId: secondRetryMessageId,
        leaseSeconds: 60,
      }),
    );
    await store.checkpoint({
      runId: run.run_id,
      leaseToken: retryAttempt.context.run.lease_token,
      stage: "generating",
      checkpoint: {
        identified: {
          attributes: RESULT.attributes,
          identification: RESULT.identification,
          model: RESULT.model,
        },
        priced: RESULT.price,
        generated: { copy: RESULT.listing, model: RESULT.listingModel! },
      },
      leaseSeconds: 60,
    });
    await store.complete({
      runId: run.run_id,
      leaseToken: retryAttempt.context.run.lease_token,
      result: RESULT,
      autopilotEnabled: false,
    });
    await expect(
      store.complete({
        runId: run.run_id,
        leaseToken: retryAttempt.context.run.lease_token,
        result: RESULT,
        autopilotEnabled: false,
      }),
    ).rejects.toThrow(/stale/i);

    const { data: settled } = await otherSeller.client
      .from("ai_item_credit_reservations")
      .select(
        "state, settled_at, retry_reservation_count, retry_restore_count",
      )
      .eq("pipeline_run_id", run.run_id)
      .single();
    expect(settled).toMatchObject({
      state: "settled",
      settled_at: expect.any(String),
      retry_reservation_count: 2,
      retry_restore_count: 1,
    });
  }, 20_000);

  it("serializes concurrent retry replay and a competing reservation", async () => {
    if (!reachable) return;
    const run = await stageRun(
      "manual-retry-concurrency",
      concurrentSeller,
    );
    const store = createSupabasePipelineWorkerStore(
      admin as unknown as PipelineWorkerRpcClient,
    );
    const failedAttempt = acquired(
      await store.acquire({
        runId: run.run_id,
        messageId: String(run.queue_message_id),
        leaseSeconds: 60,
      }),
    );
    await store.failAttempt({
      runId: run.run_id,
      leaseToken: failedAttempt.context.run.lease_token,
      retryable: false,
      retryAfterSeconds: 1,
      failureCode: "invalid_pipeline_result",
      safeFailureMessage: "The generated listing did not pass validation.",
    });

    const [leftRetry, rightRetry] = await Promise.all([
      concurrentSeller.client.rpc("retry_pipeline_run", {
        p_run_id: run.run_id,
      }),
      concurrentSeller.client.rpc("retry_pipeline_run", {
        p_run_id: run.run_id,
      }),
    ]);
    expect(leftRetry.error).toBeNull();
    expect(rightRetry.error).toBeNull();
    expect(rightRetry.data.queueMessageId).toBe(leftRetry.data.queueMessageId);
    queueMessageIds.add(String(leftRetry.data.queueMessageId));
    const { data: oneReclaim } = await concurrentSeller.client
      .from("ai_item_credit_reservations")
      .select("retry_reservation_count, retry_restore_count")
      .eq("pipeline_run_id", run.run_id)
      .single();
    expect(oneReclaim).toEqual({
      retry_reservation_count: 1,
      retry_restore_count: 0,
    });

    const cancel = await concurrentSeller.client.rpc("cancel_pipeline_run", {
      p_run_id: run.run_id,
    });
    expect(cancel.error).toBeNull();
    const competingBatchId = crypto.randomUUID();
    const [retry, competingReservation] = await Promise.all([
      concurrentSeller.client.rpc("retry_pipeline_run", {
        p_run_id: run.run_id,
      }),
      admin.rpc("stage_pipeline_batch", {
        p_batch_id: competingBatchId,
        p_daily_limit: 1_000,
        p_entries: [
          {
            idempotency_key: "manual-retry-competing-run",
            source: "single",
            autopilot_enabled: false,
            photo_paths: [
              `${concurrentSeller.id}/manual-retry/${competingBatchId}/front.jpg`,
            ],
            cost_basis: null,
          },
        ],
        p_per_minute_limit: 1_000,
        p_user_id: concurrentSeller.id,
      }),
    ]);
    const successes = [retry, competingReservation].filter(
      (result) => result.error === null,
    );
    const failures = [retry, competingReservation].filter(
      (result) => result.error !== null,
    );
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].error?.message).toMatch(
      /restored-allowance-reused|snaplist-pro-required/i,
    );
    if (retry.error === null) {
      queueMessageIds.add(String(retry.data.queueMessageId));
    }
    if (competingReservation.error === null) {
      const staged = (competingReservation.data as StagedRun[])[0];
      queueMessageIds.add(String(staged.queue_message_id));
    }

    const [{ data: reservations }, { data: durableRun }] = await Promise.all([
      concurrentSeller.client
        .from("ai_item_credit_reservations")
        .select(
          "pipeline_run_id, state, retry_reservation_count, retry_restore_count",
        ),
      concurrentSeller.client
        .from("pipeline_runs")
        .select("status")
        .eq("id", run.run_id)
        .single(),
    ]);
    const activeReservations = (reservations ?? []).filter(
      (reservation) =>
        reservation.state === "reserved" ||
        reservation.state === "settled" ||
        (reservation.state === "restored" &&
          reservation.retry_reservation_count > reservation.retry_restore_count),
    );
    expect(activeReservations).toHaveLength(1);
    const original = reservations?.find(
      (reservation) => reservation.pipeline_run_id === run.run_id,
    );
    if (retry.error === null) {
      expect(durableRun?.status).toBe("queued");
      expect(original).toMatchObject({
        state: "restored",
        retry_reservation_count: 2,
        retry_restore_count: 1,
      });
    } else {
      expect(durableRun?.status).toBe("canceled");
      expect(original).toMatchObject({
        state: "restored",
        retry_reservation_count: 1,
        retry_restore_count: 1,
      });
    }
  }, 20_000);
});
