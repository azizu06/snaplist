import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import {
  cleanupClerkTestUsers,
  grantIncludedOfferDeviceClaim,
  mintUserJwt,
  mintVerifiedGuestJwt,
} from "@/lib/supabase/test-users";
import {
  MobileRunNotFoundError,
  createConfiguredSupabaseMobileRunOperations,
} from "./runs";
import { resolveLocalTestDatabaseUrl } from "@/test/exclusive-resource-lock";
import { canonicalizeVerifiedPhotoSet } from "@/lib/photo-identity/photo-set";
import type { PipelineResult } from "@/lib/pipeline";
import {
  createSupabasePipelineWorkerStore,
  type PipelineWorkerRpcClient,
} from "@/lib/pipeline-queue/worker-store";

const SUPABASE_URL =
  process.env.SUPABASE_URL
  ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  ?? "http://127.0.0.1:54321";
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CURSOR_SIGNING_SECRET = "offline-run-history-cursor-signing-secret";
const DATABASE_URL = resolveLocalTestDatabaseUrl(
  process.env.SUPABASE_TEST_DB_URL
    ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
);

let reachable = false;
let admin: SupabaseClient;
let userAId = "";
let userBId = "";
let userAToken = "";
let userBToken = "";
let userAClient: SupabaseClient;
let itemA = "";
let runA = "";
let reviewItemA = "";
let reviewListingA = "";
let reviewRunA = "";
let reviewRevisionA = "";
let guestOperationTokenA = "";
let reviewQueueMessageA = "";

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

async function waitForDatabaseBlock(observer: Client, blockedPid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ blockers: number[] }>(
      `select pg_blocking_pids($1) as blockers
       from pg_stat_activity
       where pid = $1`,
      [blockedPid],
    );
    if ((result.rows[0]?.blockers.length ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Backend ${blockedPid} never entered a blocking lock wait`);
}

beforeAll(async () => {
  reachable = await stackReachable();
  if (!reachable) return;
  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  userAId = `user_test_mobile_run_a_${Date.now()}`;
  userBId = `user_test_mobile_run_b_${Date.now()}`;
  [userAToken, userBToken] = await Promise.all([
    mintUserJwt(userAId),
    mintUserJwt(userBId),
  ]);
  userAClient = createClient(SUPABASE_URL, ANON_KEY!, {
    accessToken: async () => userAToken,
  });
  // Every pipeline_runs insert below reserves an included credit, which #524
  // now fences on the device. This suite tests run reads and operations, not
  // how a device earns its reservation, so both tenants start past the fence.
  await Promise.all(
    [userAId, userBId].map((id) => grantIncludedOfferDeviceClaim(admin, id)),
  );
  const { data: item, error: itemError } = await userAClient
    .from("items")
    .insert({
      user_id: userAId,
      attributes: { brand: "Canon", model: "AE-1" },
      photos: [`${userAId}/items/front.jpg`],
    })
    .select("id")
    .single();
  expect(itemError).toBeNull();
  itemA = item!.id;

  const { data: run, error: runError } = await userAClient
    .from("pipeline_runs")
    .insert({
      user_id: userAId,
      item_id: itemA,
      idempotency_key: `mobile-run-${Date.now()}`,
    })
    .select("id")
    .single();
  expect(runError).toBeNull();
  runA = run!.id;

  const reviewBatchId = crypto.randomUUID();
  const reviewIdempotencyKey = `listing-review-${reviewBatchId}`;
  reviewRevisionA = crypto.randomUUID();
  const evidenceAsOf = new Date().toISOString();
  const reviewPhotoPath = `${userAId}/items/review-front.jpg`;
  const reviewPhotoIdentity = canonicalizeVerifiedPhotoSet(["a".repeat(64)]);
  const staged = await admin.rpc("stage_pipeline_batch", {
    p_user_id: userAId,
    p_batch_id: reviewBatchId,
    p_entries: [{
      idempotency_key: reviewIdempotencyKey,
      source: "single",
      autopilot_enabled: false,
      photo_paths: [reviewPhotoPath],
      cost_basis: null,
    }],
    p_daily_limit: 10,
    p_per_minute_limit: 10,
    p_photo_identities: [{
      idempotency_key: reviewIdempotencyKey,
      photo_identity_kind: reviewPhotoIdentity.kind,
      photo_identity_fingerprint: reviewPhotoIdentity.fingerprint,
    }],
  });
  expect(staged.error).toBeNull();
  const stagedReview = (staged.data as Array<{
    item_id: string;
    run_id: string;
    queue_message_id: string | number;
  }>)[0]!;
  reviewItemA = stagedReview.item_id;
  reviewRunA = stagedReview.run_id;
  reviewQueueMessageA = String(stagedReview.queue_message_id);

  const worker = createSupabasePipelineWorkerStore(
    admin as unknown as PipelineWorkerRpcClient,
  );
  const acquisition = await worker.acquire({
    runId: reviewRunA,
    messageId: reviewQueueMessageA,
    leaseSeconds: 60,
  });
  expect(acquisition.kind).toBe("acquired");
  if (acquisition.kind !== "acquired") {
    throw new Error(`Expected review fixture acquisition, received ${acquisition.kind}`);
  }
  const reviewResult: PipelineResult = {
    attributes: {
      brand: "Sony",
      model: "WH-1000XM4",
      condition: "very-good",
      category: "electronics",
      title: "Sony WH-1000XM4",
    },
    identification: {
      label: "Sony WH-1000XM4",
      confident: true,
      evidence: 0.9,
    },
    price: {
      suggested: 145,
      range: { min: 130, max: 160 },
      confidence: 0.72,
      sources: [],
      tier: "llm-only",
    },
    confidence: {
      score: 0.72,
      band: "medium",
      autopilotEligible: false,
    },
    listing: {
      platform: "ebay",
      title: "Sony WH-1000XM4 Noise-Canceling Headphones",
      description: "Clean, fully working headphones with case and charging cable.",
      fields: {
        itemSpecifics: {
          Brand: "Sony",
          Model: "WH-1000XM4",
        },
      },
    },
    model: "test-vision",
    listingModel: "test-listing",
  };
  await worker.checkpoint({
    runId: reviewRunA,
    leaseToken: acquisition.context.run.lease_token,
    stage: "generating",
    checkpoint: {
      identified: {
        attributes: reviewResult.attributes,
        identification: reviewResult.identification,
        model: reviewResult.model,
      },
      priced: {
        result: reviewResult.price,
        evidenceAsOf,
      },
      generated: {
        copy: reviewResult.listing,
        model: reviewResult.listingModel!,
      },
    },
    leaseSeconds: 60,
  });
  const completion = await worker.complete({
    runId: reviewRunA,
    leaseToken: acquisition.context.run.lease_token,
    result: reviewResult,
    autopilotEnabled: false,
  });
  reviewListingA = completion.listingId;
  const savedReview = await userAClient.rpc("save_review_edits", {
    p_item_id: reviewItemA,
    p_listing_id: reviewListingA,
    p_expected_review_revision: acquisition.context.item.review_revision,
    p_new_review_revision: reviewRevisionA,
    p_attributes: reviewResult.attributes,
    p_condition: reviewResult.attributes.condition,
    p_price_override: 149.99,
    p_cost_basis: null,
    p_listing_title: reviewResult.listing.title,
    p_listing_description: reviewResult.listing.description,
  });
  expect(savedReview.error).toBeNull();
  guestOperationTokenA = await mintVerifiedGuestJwt(
    userAId,
    crypto.randomUUID(),
  );
});

afterAll(async () => {
  if (!reachable) return;
  if (reviewQueueMessageA) {
    await admin.rpc("ack_pipeline_message", {
      p_message_id: reviewQueueMessageA,
    });
  }
  const database = new Client({ connectionString: DATABASE_URL });
  await database.connect();
  try {
    await database.query(
      `delete from private.mobile_run_operation_replays
       where user_id = any($1::text[])`,
      [[userAId, userBId]],
    );
  } finally {
    await database.end();
  }
  await cleanupClerkTestUsers(admin, [userAId, userBId]);
});

describe("mobile durable-run RLS adapter", () => {
  it("requires the local stack for real tenant proof", () => {
    if (!reachable) {
      console.warn(
        "[mobile-api/runs.rls.test] Local Supabase credentials unavailable; run a reset and export `supabase status -o env`.",
      );
    }
    expect(true).toBe(true);
  });

  it("hides another tenant's run while preserving the owner's canonical detail", async () => {
    if (!reachable) return;
    const owner = createConfiguredSupabaseMobileRunOperations({
      supabaseURL: SUPABASE_URL,
      anonKey: ANON_KEY!,
      cursorSigningSecret: CURSOR_SIGNING_SECRET,
    });
    const foreign = createConfiguredSupabaseMobileRunOperations({
      supabaseURL: SUPABASE_URL,
      anonKey: ANON_KEY!,
      cursorSigningSecret: CURSOR_SIGNING_SECRET,
    });

    await expect(owner.get({
      runId: runA,
      userId: userAId,
      bearerToken: userAToken,
    })).resolves.toMatchObject({
      id: runA,
      itemId: itemA,
      status: "queued",
      item: { title: "Canon AE-1", photoCount: 1 },
    });
    await expect(foreign.get({
      runId: runA,
      userId: userBId,
      bearerToken: userBToken,
    })).resolves.toBeNull();
    await expect(foreign.retry({
      runId: runA,
      userId: userBId,
      bearerToken: userBToken,
      idempotencyKey: crypto.randomUUID(),
    })).rejects.toBeInstanceOf(MobileRunNotFoundError);

    const missingRunId = crypto.randomUUID();
    const missingKey = crypto.randomUUID();
    const missingInput = {
      runId: missingRunId,
      userId: userBId,
      bearerToken: userBToken,
      idempotencyKey: missingKey,
    };
    await expect(foreign.retry(missingInput)).rejects.toBeInstanceOf(
      MobileRunNotFoundError,
    );
    await expect(foreign.retry(missingInput)).rejects.toBeInstanceOf(
      MobileRunNotFoundError,
    );
  });

  it.each(["Clerk", "GuestBearer"])(
    "returns one coherent review only to the owning %s principal",
    async (principalKind) => {
      if (!reachable) return;
      const ownerToken =
        principalKind === "Clerk" ? userAToken : guestOperationTokenA;
      const owner = createClient(SUPABASE_URL, ANON_KEY!, {
        accessToken: async () => ownerToken,
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const foreign = createClient(SUPABASE_URL, ANON_KEY!, {
        accessToken: async () => userBToken,
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const [owned, hidden] = await Promise.all([
        owner.rpc("get_mobile_listing_review", { p_run_id: reviewRunA }),
        foreign.rpc("get_mobile_listing_review", { p_run_id: reviewRunA }),
      ]);

      expect(owned.error).toBeNull();
      expect(owned.data).toMatchObject({
        run: {
          id: reviewRunA,
          userId: userAId,
          itemId: reviewItemA,
          listingId: reviewListingA,
        },
        item: {
          id: reviewItemA,
          userId: userAId,
          reviewRevision: reviewRevisionA,
        },
        listing: {
          id: reviewListingA,
          userId: userAId,
          itemId: reviewItemA,
          runId: reviewRunA,
        },
        pricingSnapshot: {
          runId: reviewRunA,
          userId: userAId,
          itemId: reviewItemA,
          listingId: reviewListingA,
        },
      });
      expect(hidden.error).toBeNull();
      expect(hidden.data).toBeNull();
    },
  );

  it("replays cancel and retry on one logical run without deleting its photos", async () => {
    if (!reachable) return;
    const operations = createConfiguredSupabaseMobileRunOperations({
      supabaseURL: SUPABASE_URL,
      anonKey: ANON_KEY!,
      cursorSigningSecret: CURSOR_SIGNING_SECRET,
    });
    const base = { runId: runA, userId: userAId, bearerToken: userAToken };
    const cancelKey = crypto.randomUUID();
    const firstCancel = await operations.cancel({
      ...base,
      idempotencyKey: cancelKey,
    });
    const duplicateCancel = await operations.cancel({
      ...base,
      idempotencyKey: cancelKey,
    });
    expect(firstCancel).toMatchObject({ id: runA, status: "canceled" });
    expect(duplicateCancel).toMatchObject({ id: runA, status: "canceled" });

    const retryKey = crypto.randomUUID();
    const firstRetry = await operations.retry({ ...base, idempotencyKey: retryKey });
    const duplicateRetry = await operations.retry({ ...base, idempotencyKey: retryKey });
    expect(firstRetry).toMatchObject({ id: runA, itemId: itemA, status: "queued" });
    expect(duplicateRetry).toMatchObject({ id: runA, itemId: itemA, status: "queued" });

    const database = new Client({ connectionString: DATABASE_URL });
    await database.connect();
    try {
      await database.query(
        `select pgmq.delete('pipeline_jobs', run.queue_message_id)
         from public.pipeline_runs run
         where run.id = $1
           and run.queue_message_id is not null`,
        [runA],
      );
      await database.query(
        `update public.pipeline_runs
         set status = 'running',
             stage = 'pricing',
             attempt_count = attempt_count + 1,
             queue_message_id = null,
             enqueued_at = null,
             started_at = statement_timestamp(),
             last_attempted_at = statement_timestamp(),
             lease_token = gen_random_uuid(),
             lease_expires_at = statement_timestamp() + interval '1 minute'
         where id = $1`,
        [runA],
      );
      await database.query(
        `update public.pipeline_runs
         set status = 'failed',
             failure_code = 'attempts_exhausted',
             safe_failure_message = 'A later attempt failed.',
             completed_at = statement_timestamp(),
             lease_token = null,
             lease_expires_at = null
         where id = $1`,
        [runA],
      );
    } finally {
      await database.end();
    }
    const delayedRetryReplay = await operations.retry({
      ...base,
      idempotencyKey: retryKey,
    });
    expect(delayedRetryReplay).toMatchObject({ id: runA, status: "failed" });

    const newRetry = await operations.retry({
      ...base,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(newRetry).toMatchObject({ id: runA, status: "queued" });

    const finalCancel = await operations.cancel({
      ...base,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(finalCancel.status).toBe("canceled");
    const { data: item } = await userAClient
      .from("items")
      .select("photos")
      .eq("id", itemA)
      .single();
    expect(item?.photos).toEqual([`${userAId}/items/front.jpg`]);
  });

  it("waits for terminal credit restoration before deciding whether retry is legal", async () => {
    if (!reachable) return;
    const fixtureUser = `user_test_mobile_run_race_${Date.now()}`;
    const itemId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const allowanceId = crypto.randomUUID();
    const retryKey = crypto.randomUUID();
    const setup = new Client({ connectionString: DATABASE_URL });
    const worker = new Client({ connectionString: DATABASE_URL });
    const retry = new Client({ connectionString: DATABASE_URL });
    const observer = new Client({ connectionString: DATABASE_URL });
    await Promise.all([setup.connect(), worker.connect(), retry.connect(), observer.connect()]);

    try {
      await setup.query(
        `insert into public.items (id, user_id, photos)
         values ($1::uuid, $2, array[$3::text])`,
        [itemId, fixtureUser, `${fixtureUser}/items/front.jpg`],
      );
      await setup.query(
        `insert into public.pipeline_runs (id, user_id, item_id, idempotency_key)
         values ($1::uuid, $2, $3::uuid, $4)`,
        [runId, fixtureUser, itemId, `mobile-race-${runId}`],
      );
      await setup.query(
        `update public.pipeline_runs
         set status = 'running',
             stage = 'pricing',
             attempt_count = 1,
             started_at = statement_timestamp(),
             last_attempted_at = statement_timestamp(),
             lease_token = gen_random_uuid(),
             lease_expires_at = statement_timestamp() + interval '1 minute'
         where id = $1::uuid`,
        [runId],
      );
      await setup.query(
        `insert into public.ai_item_allowance_periods (
           id, user_id, source, period_key, period_start, expires_date, state, allowance
         ) values (
           $1::uuid, $2, 'included', $3,
           statement_timestamp() - interval '1 day',
           statement_timestamp() + interval '1 year', 'active', 1
         )`,
        [allowanceId, fixtureUser, "included-first-run"],
      );
      await setup.query(
        `insert into public.ai_item_credit_reservations (
           user_id, pipeline_run_id, item_id, allowance_period_id,
           logical_run_key, photo_set_fingerprint, state
         ) values ($1, $2::uuid, $3::uuid, $4::uuid, $5, repeat('0', 64), 'reserved')`,
        [fixtureUser, runId, itemId, allowanceId, `logical-${runId}`],
      );

      await worker.query("begin");
      await worker.query(
        `update public.pipeline_runs
         set status = 'failed',
             failure_code = 'provider_unavailable',
             safe_failure_message = 'The listing could not be prepared.',
             completed_at = statement_timestamp(),
             lease_token = null,
             lease_expires_at = null
         where id = $1::uuid`,
        [runId],
      );

      await retry.query("begin");
      await retry.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: fixtureUser, role: "authenticated" }),
      ]);
      await retry.query("set local role authenticated");
      const retryPid = await retry.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      const retryPromise = retry.query<{ value: Record<string, unknown> }>(
        `select public.apply_mobile_run_operation($1::uuid, 'retry', $2::uuid) as value`,
        [runId, retryKey],
      );
      await waitForDatabaseBlock(observer, retryPid.rows[0]!.pid);

      await worker.query("commit");
      const result = await retryPromise;
      await retry.query("commit");

      expect(result.rows[0]?.value).toMatchObject({ status: "queued" });
      const finalState = await setup.query<{
        reservation_state: string;
        retry_reservation_count: number;
        retry_restore_count: number;
        status: string;
      }>(
        `select run.status,
                reservation.state as reservation_state,
                reservation.retry_reservation_count,
                reservation.retry_restore_count
         from public.pipeline_runs run
         join public.ai_item_credit_reservations reservation
           on reservation.pipeline_run_id = run.id
         where run.id = $1::uuid`,
        [runId],
      );
      expect(finalState.rows[0]).toEqual({
        reservation_state: "restored",
        retry_reservation_count: 1,
        retry_restore_count: 0,
        status: "queued",
      });

      const fixtureToken = await mintUserJwt(fixtureUser);
      const operations = createConfiguredSupabaseMobileRunOperations({
        supabaseURL: SUPABASE_URL,
        anonKey: ANON_KEY!,
        cursorSigningSecret: CURSOR_SIGNING_SECRET,
      });
      await expect(operations.get({
        runId,
        userId: fixtureUser,
        bearerToken: fixtureToken,
      })).resolves.toMatchObject({
        status: "queued",
        allowance: "reserved",
        legalActions: { canRetry: false },
      });
    } finally {
      await worker.query("rollback").catch(() => undefined);
      await retry.query("rollback").catch(() => undefined);
      await setup.query(
        `select pgmq.delete('pipeline_jobs', queue_message_id)
         from public.pipeline_runs
         where id = $1::uuid and queue_message_id is not null`,
        [runId],
      ).catch(() => undefined);
      await setup.query(
        "delete from private.mobile_run_operation_replays where requested_run_id = $1::uuid",
        [runId],
      ).catch(() => undefined);
      await setup.query("delete from public.items where id = $1::uuid", [itemId])
        .catch(() => undefined);
      await Promise.all([setup.end(), worker.end(), retry.end(), observer.end()]);
    }
  });

});
