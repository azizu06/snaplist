import { readFileSync } from "node:fs";
import { Client, type QueryResult } from "pg";
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
import { resolveLocalTestDatabaseUrl } from "@/test/exclusive-resource-lock";

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "http://127.0.0.1:54321";
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DATABASE_URL = resolveLocalTestDatabaseUrl(
  process.env.SUPABASE_TEST_DB_URL ??
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
);
const MIGRATION = readFileSync(
  new URL(
    "../../../supabase/migrations/20260720003000_manual_retry_credit_reconciliation.sql",
    import.meta.url,
  ),
  "utf8",
);
const UPGRADE_BACKFILL_BEGIN = "-- manual-retry-upgrade-backfill:begin";
const UPGRADE_BACKFILL_END = "-- manual-retry-upgrade-backfill:end";

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
let upgradeSeller: ClerkTestUser;
let upgradeConflictSeller: ClerkTestUser;
let upgradeOverlapSeller: ClerkTestUser;
let retryProjectionSeller: ClerkTestUser;
const queueMessageIds = new Set<string>();

function upgradeBackfillSql(): string {
  const start = MIGRATION.indexOf(UPGRADE_BACKFILL_BEGIN);
  const end = MIGRATION.indexOf(UPGRADE_BACKFILL_END);
  if (start < 0 || end <= start) {
    throw new Error("Manual retry upgrade backfill markers are missing");
  }
  return MIGRATION.slice(start + UPGRADE_BACKFILL_BEGIN.length, end);
}

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

async function simulateLegacyManualRetry(
  runId: string,
  bypassRetryCreditTrigger = false,
): Promise<string> {
  const database = new Client({
    application_name: "issue-278-upgrade-path",
    connectionString: DATABASE_URL,
  });
  try {
    await database.connect();
    if (bypassRetryCreditTrigger) {
      await database.query("begin");
      await database.query("set local session_replication_role = replica");
    }
    const legacyRetry = await database.query<{ queue_message_id: string }>(
      `with retry_message as (
         select run.id,
                pgmq.send(
                  'pipeline_jobs',
                  jsonb_build_object(
                    'run_id', run.id,
                    'schema_version', run.schema_version
                  )
                ) as message_id
         from public.pipeline_runs run
         where run.id = $1::uuid
       )
       update public.pipeline_runs run
       set status = 'queued',
           stage = 'queued',
           max_attempts = greatest(run.max_attempts, run.attempt_count + 3),
           queue_message_id = retry_message.message_id,
           enqueued_at = statement_timestamp(),
           completed_at = null,
           failure_code = null,
           safe_failure_message = null,
           lease_token = null,
           lease_expires_at = null,
           next_attempt_at = null
       from retry_message
       where run.id = retry_message.id
       returning run.queue_message_id::text`,
      [runId],
    );
    const messageId = legacyRetry.rows[0]?.queue_message_id ?? "";
    if (messageId === "") {
      throw new Error("Legacy manual retry simulation did not queue the run");
    }
    if (bypassRetryCreditTrigger) await database.query("commit");
    queueMessageIds.add(messageId);
    return messageId;
  } catch (error) {
    if (bypassRetryCreditTrigger) {
      await database.query("rollback").catch(() => undefined);
    }
    throw error;
  } finally {
    await database.end().catch(() => undefined);
  }
}

async function runUpgradeBackfill(): Promise<void> {
  const database = new Client({
    application_name: "issue-278-upgrade-backfill",
    connectionString: DATABASE_URL,
  });
  try {
    await database.connect();
    await database.query(upgradeBackfillSql());
  } finally {
    await database.end().catch(() => undefined);
  }
}

async function cleanupManualRetryAllowancePeriods(
  userIds: string[],
): Promise<void> {
  const database = new Client({
    application_name: "issue-278-cleanup",
    connectionString: DATABASE_URL,
  });
  try {
    await database.connect();
    await database.query(
      `delete from public.ai_item_allowance_periods
       where user_id = any($1::text[])`,
      [userIds],
    );
  } finally {
    await database.end().catch(() => undefined);
  }
}

async function waitForApplicationLock(
  observer: Client,
  applicationName: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await observer.query<{ waiting: boolean }>(
      `select exists (
         select 1
         from pg_stat_activity
         where application_name = $1
           and state = 'active'
           and wait_event_type = 'Lock'
       ) as waiting`,
      [applicationName],
    );
    if (waiting.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${applicationName} to reach the DDL fence`);
}

beforeAll(async () => {
  reachable = await stackReachable();
  if (!reachable) return;
  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  [
    seller,
    otherSeller,
    concurrentSeller,
    upgradeSeller,
    upgradeConflictSeller,
    upgradeOverlapSeller,
    retryProjectionSeller,
  ] = await Promise.all([
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
    provisionClerkTestUser(
      SUPABASE_URL,
      ANON_KEY!,
      "manual_retry_credit_upgrade",
    ),
    provisionClerkTestUser(
      SUPABASE_URL,
      ANON_KEY!,
      "manual_retry_credit_upgrade_conflict",
    ),
    provisionClerkTestUser(
      SUPABASE_URL,
      ANON_KEY!,
      "manual_retry_credit_upgrade_overlap",
    ),
    provisionClerkTestUser(
      SUPABASE_URL,
      ANON_KEY!,
      "manual_retry_credit_projection",
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
  const userIds = [
    seller.id,
    otherSeller.id,
    concurrentSeller.id,
    upgradeSeller.id,
    upgradeConflictSeller.id,
    upgradeOverlapSeller.id,
    retryProjectionSeller.id,
  ];
  await cleanupClerkTestUsers(admin, userIds);
  await cleanupManualRetryAllowancePeriods(userIds);
});

describe("manual retry AI-item credit accounting", () => {
  it("projects effective allowance and Retry from canonical reclaim truth", async () => {
    if (!reachable) return;
    const run = await stageRun(
      "manual-retry-effective-projection",
      retryProjectionSeller,
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

    const restoredProjection = await retryProjectionSeller.client.rpc(
      "get_pipeline_run_retry_projection",
      { p_run_id: run.run_id },
    );
    expect(restoredProjection).toMatchObject({
      error: null,
      data: [{ effective_allowance: "restored", can_retry: true }],
    });

    const retried = await retryProjectionSeller.client.rpc(
      "retry_pipeline_run",
      { p_run_id: run.run_id },
    );
    expect(retried).toMatchObject({ error: null, data: { status: "queued" } });
    queueMessageIds.add(String(retried.data.queueMessageId));

    const activeProjection = await retryProjectionSeller.client.rpc(
      "get_pipeline_run_retry_projection",
      { p_run_id: run.run_id },
    );
    expect(activeProjection).toMatchObject({
      error: null,
      data: [{ effective_allowance: "reserved", can_retry: false }],
    });

    const canceled = await retryProjectionSeller.client.rpc(
      "cancel_pipeline_run",
      { p_run_id: run.run_id },
    );
    expect(canceled).toMatchObject({ error: null, data: { status: "canceled" } });
    await stageRun(
      "manual-retry-effective-projection-competing",
      retryProjectionSeller,
    );

    const exhaustedProjection = await retryProjectionSeller.client.rpc(
      "get_pipeline_run_retry_projection",
      { p_run_id: run.run_id },
    );
    expect(exhaustedProjection).toMatchObject({
      error: null,
      data: [{ effective_allowance: "restored", can_retry: false }],
    });
    const rejectedRetry = await retryProjectionSeller.client.rpc(
      "retry_pipeline_run",
      { p_run_id: run.run_id },
    );
    expect(rejectedRetry.error).toMatchObject({ code: "P0001" });

    const foreignProjection = await seller.client.rpc(
      "get_pipeline_run_retry_projection",
      { p_run_id: run.run_id },
    );
    expect(foreignProjection).toMatchObject({ error: null, data: [] });
  }, 20_000);

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

  it("reclaims a retry that waits behind the migration trigger fence", async () => {
    if (!reachable) return;
    const run = await stageRun(
      "manual-retry-upgrade-overlap",
      upgradeOverlapSeller,
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

    const migration = new Client({
      application_name: "issue-278-migration-trigger-fence",
      connectionString: DATABASE_URL,
    });
    const retry = new Client({
      application_name: "issue-278-overlap-retry",
      connectionString: DATABASE_URL,
    });
    let retryCall:
      | Promise<QueryResult<{ value: Record<string, unknown> }>>
      | undefined;
    try {
      await Promise.all([migration.connect(), retry.connect()]);
      await migration.query("begin");
      await migration.query(
        "lock table public.pipeline_runs in share row exclusive mode",
      );
      await retry.query("begin");
      await retry.query(
        "select set_config('request.jwt.claims', $1, true)",
        [JSON.stringify({ role: "authenticated", sub: upgradeOverlapSeller.id })],
      );
      await retry.query("set local role authenticated");

      retryCall = retry.query<{ value: Record<string, unknown> }>(
        "select public.retry_pipeline_run($1::uuid) as value",
        [run.run_id],
      );
      await waitForApplicationLock(migration, "issue-278-overlap-retry");
      await migration.query("commit");

      const retried = await retryCall;
      await retry.query("commit");
      const retryValue = retried.rows[0]?.value;
      expect(retryValue).toMatchObject({ status: "queued" });
      const retryMessageId = String(retryValue?.queueMessageId);
      expect(retryMessageId).not.toBe("undefined");
      queueMessageIds.add(retryMessageId);

      const { data: reservation } = await upgradeOverlapSeller.client
        .from("ai_item_credit_reservations")
        .select("state, retry_reservation_count, retry_restore_count")
        .eq("pipeline_run_id", run.run_id)
        .single();
      expect(reservation).toEqual({
        state: "restored",
        retry_reservation_count: 1,
        retry_restore_count: 0,
      });
    } finally {
      await migration.query("rollback").catch(() => undefined);
      if (retryCall) await retryCall.catch(() => undefined);
      await retry.query("rollback").catch(() => undefined);
      await Promise.all([
        migration.end().catch(() => undefined),
        retry.end().catch(() => undefined),
      ]);
    }
  }, 20_000);

  it("reconciles a retry already active when the migration starts", async () => {
    if (!reachable) return;
    const run = await stageRun("manual-retry-upgrade", upgradeSeller);
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

    const retryMessageId = await simulateLegacyManualRetry(run.run_id, true);
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
    await expect(
      store.complete({
        runId: run.run_id,
        leaseToken: retryAttempt.context.run.lease_token,
        result: RESULT,
        autopilotEnabled: false,
      }),
    ).rejects.toThrow(/active manual retry/i);

    await runUpgradeBackfill();
    const replayed = await upgradeSeller.client.rpc("retry_pipeline_run", {
      p_run_id: run.run_id,
    });
    expect(replayed.error).toBeNull();
    expect(replayed.data.status).toBe("running");
    expect(String(replayed.data.queueMessageId)).toBe(retryMessageId);
    const { data: reclaimed } = await upgradeSeller.client
      .from("ai_item_credit_reservations")
      .select("state, retry_reservation_count, retry_restore_count")
      .eq("pipeline_run_id", run.run_id)
      .single();
    expect(reclaimed).toEqual({
      state: "restored",
      retry_reservation_count: 1,
      retry_restore_count: 0,
    });

    await store.complete({
      runId: run.run_id,
      leaseToken: retryAttempt.context.run.lease_token,
      result: RESULT,
      autopilotEnabled: false,
    });

    const { data: settled } = await upgradeSeller.client
      .from("ai_item_credit_reservations")
      .select("state, settled_at, retry_reservation_count, retry_restore_count")
      .eq("pipeline_run_id", run.run_id)
      .single();
    expect(settled).toMatchObject({
      state: "settled",
      settled_at: expect.any(String),
      retry_reservation_count: 1,
      retry_restore_count: 0,
    });
  }, 20_000);

  it("fails the upgrade closed when an active legacy retry lost its allowance slot", async () => {
    if (!reachable) return;
    const run = await stageRun(
      "manual-retry-upgrade-conflict",
      upgradeConflictSeller,
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
    await simulateLegacyManualRetry(run.run_id, true);

    const competing = await stageRun(
      "manual-retry-upgrade-conflict-competing",
      upgradeConflictSeller,
    );
    await expect(runUpgradeBackfill()).rejects.toThrow(
      /Cannot reconcile active manual retries without overbooking/i,
    );

    const [{ data: reservations }, { data: durableRun }] = await Promise.all([
      upgradeConflictSeller.client
        .from("ai_item_credit_reservations")
        .select(
          "pipeline_run_id, state, retry_reservation_count, retry_restore_count",
        ),
      upgradeConflictSeller.client
        .from("pipeline_runs")
        .select("status")
        .eq("id", run.run_id)
        .single(),
    ]);
    expect(durableRun?.status).toBe("queued");
    expect(
      reservations?.find(
        (reservation) => reservation.pipeline_run_id === run.run_id,
      ),
    ).toMatchObject({
      state: "restored",
      retry_reservation_count: 0,
      retry_restore_count: 0,
    });
    expect(
      reservations?.find(
        (reservation) => reservation.pipeline_run_id === competing.run_id,
      ),
    ).toMatchObject({
      state: "reserved",
      retry_reservation_count: 0,
      retry_restore_count: 0,
    });
  }, 20_000);
});
