import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  acquireExclusiveTestResource,
  resolveLocalTestDatabaseUrl,
  type ExclusiveTestResourceLease,
} from "@/test/exclusive-resource-lock";
import {
  cleanupClerkTestUsers,
  grantIncludedOfferDeviceClaim,
  mintUserJwt,
} from "@/lib/supabase/test-users";
import { runPipelineAndPersist } from "@/lib/pipeline/persist";
import { StubPipeline } from "@/lib/pipeline/stub";
import { createMobileApiHandler } from "@/lib/mobile-api/app";
import { createSupabaseItemDeletionGateway } from "./gateway";
import { runPipelineMaintenance } from "@/lib/pipeline-operations/maintenance";
import { createSupabasePipelineOperationsStore } from "@/lib/pipeline-operations/store";
import { createStorageCleanupCapability } from "@/lib/pipeline-operations/storage-cleanup";
import { skipIfStackUnreachable, stackReachable, whenStackReachable } from "@/test/supabase-stack";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const DATABASE_URL = resolveLocalTestDatabaseUrl();

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

/**
 * The language tag inside the voice receipt. The retention matrix row
 * `seller-voice-transcript` names its completion proof as the transcript,
 * seller_voice provenance, and language tag being absent from tenant data, and
 * binds it to the earliest applicable deletion trigger — item deletion is one.
 */
const VOICE_LANGUAGE_TAG = "uz-UZ";

let reachable = false;
let database: Client;
let admin: SupabaseClient;
let lease: ExclusiveTestResourceLease;
let ownerId = "";
let foreignId = "";
let owner: SupabaseClient;
let foreign: SupabaseClient;
const tenantIds = new Set<string>();
/**
 * Item ids every fixture seeded. Teardown cannot rediscover them: the cleanup
 * jobs this suite is meant to leave behind outlive both the item row and its
 * Storage objects by design, so a `select id from public.items` sweep finds
 * nothing and the queue-depth pgTAP contracts inherit the residue.
 */
const seededItemIds = new Set<string>();
/**
 * Run ids every credited fixture staged. `stage_pipeline_batch` enqueues one
 * `pipeline_jobs` message per run and no worker runs here to consume it, so the
 * message outlives both the run row and the item `delete_item` removes.
 */
const seededRunIds = new Set<string>();
let queueDepthAtStart = 0;

/**
 * A tenant per behaviour. AI-item allowance is per seller and deliberately
 * consumed by these tests, so sharing one tenant would make each test depend on
 * the order the others ran in.
 */
async function provisionTenant(label: string): Promise<{
  userId: string;
  client: SupabaseClient;
  token: string;
}> {
  const userId = `user_test_item_deletion_${label}_${Date.now()}`;
  tenantIds.add(userId);
  const token = await mintUserJwt(userId);
  return {
    userId,
    token,
    client: createClient(SUPABASE_URL, PUBLISHABLE_KEY!, {
      accessToken: async () => token,
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  };
}

/**
 * The native transport wired to the real executor.
 *
 * `item-deletion.test.ts` proves the route maps each typed error to a status
 * from a stubbed gateway; what it cannot prove is that the executor's actual
 * answers ever produce those errors. A refusal arrives as a *successful* RPC
 * whose jsonb says `blocked`, and "not found" arrives as a raised `P0002` — two
 * shapes a stub can assert about only by restating them.
 */
function transportForSeller(userId: string) {
  return createMobileApiHandler({
    async authenticate() {
      return { kind: "clerk", userId };
    },
    worker: {} as never,
    itemDeletion: createSupabaseItemDeletionGateway((bearerToken) =>
      createClient(SUPABASE_URL, PUBLISHABLE_KEY!, {
        accessToken: async () => bearerToken,
        auth: { persistSession: false, autoRefreshToken: false },
      })),
    requestId: () => "req_181_transport",
  });
}

function deleteRequest(itemId: string, token: string): Request {
  return new Request(`https://api.test/v1/items/${itemId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeEach((context) => {
  skipIfStackUnreachable(context, reachable);
});

interface DeletionOutcome {
  status: string;
  item_id: string;
  blocked_by: string[];
  retained_records: string[];
}

function deletionOutcome(value: unknown): DeletionOutcome {
  if (!value || typeof value !== "object") throw new Error("Deletion outcome is missing.");
  const outcome = value as Partial<DeletionOutcome>;
  if (
    typeof outcome.status !== "string" ||
    typeof outcome.item_id !== "string" ||
    !Array.isArray(outcome.blocked_by) ||
    !Array.isArray(outcome.retained_records)
  ) {
    throw new Error(`Deletion outcome is invalid: ${JSON.stringify(value)}`);
  }
  return outcome as DeletionOutcome;
}

/**
 * One real item per tenant, built through the production persistence seam so the
 * fixture carries the same row graph a seller's item actually has — item,
 * pipeline run, listing, and the prediction log whose `item_id` is ON DELETE SET
 * NULL rather than CASCADE.
 */
async function seedItem(
  client: SupabaseClient,
  userId: string,
  label: string,
): Promise<{ itemId: string; photoPath: string }> {
  const photoPath = `${userId}/item-deletion-${label}.jpg`;
  const uploaded = await client.storage.from("photos").upload(photoPath, jpeg, {
    contentType: "image/jpeg",
    upsert: false,
  });
  expect(uploaded.error).toBeNull();
  const persisted = await runPipelineAndPersist(
    client,
    { userId, photos: [photoPath] },
    new StubPipeline(),
  );
  seededItemIds.add(persisted.itemId);
  return { itemId: persisted.itemId, photoPath };
}

async function tenantResidue(userId: string): Promise<{
  items: number;
  predictionLogs: number;
  listings: number;
}> {
  const { rows } = await database.query<{
    items: number;
    prediction_logs: number;
    listings: number;
  }>(
    `select
       (select count(*)::integer from public.items where user_id = $1) items,
       (select count(*)::integer from public.prediction_logs where user_id = $1) prediction_logs,
       (select count(*)::integer from public.listings where user_id = $1) listings`,
    [userId],
  );
  const row = rows[0]!;
  return {
    items: row.items,
    predictionLogs: row.prediction_logs,
    listings: row.listings,
  };
}

async function storageCleanupJob(itemId: string): Promise<{
  photo_paths: string[];
  state: string;
} | null> {
  const { rows } = await database.query<{ photo_paths: string[]; state: string }>(
    `select photo_paths, state
     from private.pipeline_storage_cleanup_jobs
     where source_type = 'item_deletion' and source_id = $1`,
    [itemId],
  );
  return rows[0] ?? null;
}

/**
 * How many wake-up messages the shared `pipeline_jobs` queue is holding. The
 * database CI job runs the RLS suites and the pgTAP contracts against one
 * Postgres, and `pipeline_operations_health()` reports an absolute `queueDepth`,
 * so a message this suite leaves behind is read later as live pipeline backlog.
 */
async function queuedPipelineMessages(): Promise<number> {
  const { rows } = await database.query<{ count: number }>(
    "select count(*)::integer count from pgmq.q_pipeline_jobs",
  );
  return rows[0]!.count;
}

function stageArgs(userId: string, idempotencyKey: string, photoPath: string) {
  return {
    p_batch_id: crypto.randomUUID(),
    p_daily_limit: 1_000,
    p_entries: [{
      idempotency_key: idempotencyKey,
      source: "single",
      autopilot_enabled: false,
      photo_paths: [photoPath],
      cost_basis: null,
    }],
    p_per_minute_limit: 1_000,
    p_photo_identities: [{
      idempotency_key: idempotencyKey,
      photo_identity_kind: "content_sha256_set_v1",
      photo_identity_fingerprint: "a".repeat(64),
    }],
    p_user_id: userId,
  };
}

/**
 * A run that consumed the seller's included AI-item credit and settled it — the
 * shape that makes item deletion a monetization question rather than only a
 * retention one.
 */
async function seedCreditedItem(
  userId: string,
  options: {
    settle?: boolean;
    /**
     * The submission key the run is reserved under. It becomes the
     * reservation's `logical_run_key`, so a test about key reuse has to choose
     * it rather than take a fresh one.
     */
    idempotencyKey?: string;
    /**
     * A paid StoreKit period with room for more than one run, for the cases
     * that need the seller to still have allowance after this item is gone.
     * Without it the fixture spends the single included run.
     */
    allowance?: number;
  } = {},
): Promise<{ itemId: string; runId: string; photoPath: string }> {
  if (options.allowance === undefined) {
    await grantIncludedOfferDeviceClaim(admin, userId);
  } else {
    const now = Date.now();
    const period = await admin.rpc("record_verified_storekit_ai_item_period", {
      p_allowance: options.allowance,
      p_event_created_at: new Date(now).toISOString(),
      p_event_id: crypto.randomUUID(),
      p_expires_date: new Date(now + 30 * 24 * 60 * 60 * 1_000).toISOString(),
      p_grace_expires_date: null,
      p_original_transaction_id: `original-${userId}`,
      p_period_key: `period-${userId}`,
      p_period_start: new Date(now - 60 * 60 * 1_000).toISOString(),
      p_state: "active",
      p_user_id: userId,
    });
    if (period.error) throw new Error(period.error.message);
  }
  const photoPath = `${userId}/item-deletion-credited.jpg`;
  const staged = await admin.rpc(
    "stage_pipeline_batch",
    stageArgs(userId, options.idempotencyKey ?? crypto.randomUUID(), photoPath),
  );
  if (staged.error) throw new Error(staged.error.message);
  const row = (staged.data as Array<{ item_id: string; run_id: string }>)[0];
  if (!row) throw new Error("Credited item fixture did not stage.");
  seededItemIds.add(row.item_id);
  seededRunIds.add(row.run_id);

  await database.query(
    `update public.pipeline_runs
     set status = 'running', stage = 'identifying', attempt_count = 1,
         started_at = statement_timestamp(),
         last_attempted_at = statement_timestamp(),
         lease_token = gen_random_uuid(),
         lease_expires_at = statement_timestamp() + interval '5 minutes'
     where id = $1`,
    [row.run_id],
  );
  if (options.settle === false) {
    return { itemId: row.item_id, runId: row.run_id, photoPath };
  }

  // Settlement fires from the run's succeeded transition and re-proves that one
  // coherent editable draft exists, so the fixture builds the same item,
  // listing, and prediction log the worker would have persisted.
  const item = await database.query<{ review_revision: string }>(
    `update public.items
     set attributes = '{"brand":"Fixture"}'::jsonb,
         identification = '{"title":"Fixture item"}'::jsonb,
         condition = 'used'
     where id = $1 and user_id = $2
     returning review_revision`,
    [row.item_id, userId],
  );
  const reviewRevision = item.rows[0]!.review_revision;
  const listing = await database.query<{ id: string }>(
    `insert into public.listings (
       user_id, item_id, platform, run_id, status, title, description,
       source_review_revision
     )
     values ($1, $2, 'ebay', $3, 'draft', 'Fixture listing',
             'Fixture description', $4)
     returning id`,
    [userId, row.item_id, row.run_id, reviewRevision],
  );
  await database.query(
    `insert into public.prediction_logs (
       user_id, item_id, listing_model, run_id, price, price_range,
       confidence, tier_fired, sources
     )
     values ($1, $2, 'stub-model', $3, 42.00,
             '{"low":30,"high":50}'::jsonb, 0.8, 'ebay-sold',
             '[{"url":"https://example.test/sold"}]'::jsonb)`,
    [userId, row.item_id, row.run_id],
  );
  await database.query(
    `update public.pipeline_runs
     set listing_id = $2, status = 'succeeded', stage = 'completed',
         completed_at = statement_timestamp(),
         lease_token = null, lease_expires_at = null
     where id = $1`,
    [row.run_id, listing.rows[0]!.id],
  );
  return { itemId: row.item_id, runId: row.run_id, photoPath };
}

/**
 * The accepted voice note for an item, with its raw audio still present.
 *
 * The receipt carries the whole seven-key shape
 * `assert_mobile_submission_voice_receipt` validates, not just the storage path:
 * `locale` is the seller's language tag, and whether it survives deletion is the
 * retention question this fixture exists to answer.
 */
async function seedVoiceHandoff(
  userId: string,
  item: { itemId: string; runId: string },
): Promise<{ cleanupId: string; storagePath: string }> {
  const cleanupId = crypto.randomUUID();
  const storagePath = `${userId}/voice/${cleanupId}.m4a`;
  // A real object, so the cleanup capability's absence proof reads a bucket
  // that actually held the path rather than one that never did.
  const uploaded = await admin.storage.from("photos").upload(storagePath, jpeg, {
    contentType: "audio/wav",
    upsert: true,
  });
  expect(uploaded.error).toBeNull();
  await database.query(
    `insert into private.mobile_item_submission_voice_handoffs (
       user_id, idempotency_key, request_fingerprint, batch_id, cleanup_id,
       receipt, state, item_id, run_id, accepted_at
     )
     values ($1::text, gen_random_uuid(), $2::text, gen_random_uuid(), $3::uuid,
             jsonb_build_object(
               'version', 1,
               'storage_path', $4::text,
               'content_sha256', repeat('d', 64),
               'byte_length', 2048,
               'duration_ms', 4200,
               'locale', $7::text,
               'media_type', 'audio/wav'
             ), 'accepted',
             $5::uuid, $6::uuid, statement_timestamp())`,
    [
      userId,
      "b".repeat(64),
      cleanupId,
      storagePath,
      item.itemId,
      item.runId,
      VOICE_LANGUAGE_TAG,
    ],
  );
  return { cleanupId, storagePath };
}

interface VoiceHandoffRow {
  state: string;
  item_id: string | null;
  run_id: string | null;
  receipt: Record<string, unknown>;
  raw_audio_cleanup_queued_at: Date | null;
  raw_audio_deleted_at: Date | null;
}

async function voiceHandoff(userId: string): Promise<VoiceHandoffRow | null> {
  const { rows } = await database.query<VoiceHandoffRow>(
    `select state, item_id, run_id, receipt, raw_audio_cleanup_queued_at,
            raw_audio_deleted_at
     from private.mobile_item_submission_voice_handoffs
     where user_id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

/** What the seller sees when the allowance is already spent. */
async function refusedSecondRun(userId: string): Promise<string> {
  const attempt = await admin.rpc(
    "stage_pipeline_batch",
    stageArgs(userId, crypto.randomUUID(), `${userId}/item-deletion-second.jpg`),
  );
  if (!attempt.error) throw new Error("A second run was accepted without a credit.");
  return attempt.error.message;
}

/** How many eBay-issued identifiers SnapList is still storing for a tenant. */
async function storedEbayIdentifiers(userId: string): Promise<number> {
  const { rows } = await database.query<{ count: number }>(
    `select count(*)::integer count
     from public.listings
     where user_id = $1
       and (ebay_offer_id is not null or ebay_listing_id is not null
            or ebay_status is not null)`,
    [userId],
  );
  return rows[0]!.count;
}

/** The #175 fields item deletion must leave untouched. */
async function guestRecovery(recoveryId: string): Promise<{
  state: string;
  expires_at: Date;
  usable_draft_at: Date;
  claimed_at: Date | null;
  expired_at: Date | null;
  item_id: string;
} | null> {
  const { rows } = await database.query<{
    state: string;
    expires_at: Date;
    usable_draft_at: Date;
    claimed_at: Date | null;
    expired_at: Date | null;
    item_id: string;
  }>(
    `select state, expires_at, usable_draft_at, claimed_at, expired_at, item_id
     from private.guest_draft_recoveries
     where id = $1`,
    [recoveryId],
  );
  return rows[0] ?? null;
}

async function creditLedgerRow(userId: string): Promise<{
  state: string;
  user_id: string;
  pipeline_run_id: string | null;
  item_id: string | null;
} | null> {
  const { rows } = await database.query<{
    state: string;
    user_id: string;
    pipeline_run_id: string | null;
    item_id: string | null;
  }>(
    `select state, user_id, pipeline_run_id, item_id
     from public.ai_item_credit_reservations
     where user_id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

beforeAll(async () => {
  reachable = await stackReachable({
    url: SUPABASE_URL,
    apiKey: PUBLISHABLE_KEY,
    requiredValues: [
      PUBLISHABLE_KEY?.startsWith("sb_publishable_"),
      SECRET_KEY?.startsWith("sb_secret_"),
      new URL(SUPABASE_URL).hostname.match(/^(127\.0\.0\.1|localhost|::1)$/),
    ],
  });
  await whenStackReachable(reachable, async () => {
    // The exact name the other pgmq suites hold. A lease is only a convention:
    // a name nobody else spells excludes nobody, and this suite reads and
    // publishes on the shared queue.
    lease = await acquireExclusiveTestResource(
      `local-pgmq:pipeline_jobs:${SUPABASE_URL}`,
    );
    database = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2_000 });
    await database.connect();
    // Taken under the queue lease, so nothing else can move it while this suite
    // runs and teardown can prove the suite put the queue back as it found it.
    queueDepthAtStart = await queuedPipelineMessages();
    admin = createClient(SUPABASE_URL, SECRET_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const [ownerTenant, foreignTenant] = await Promise.all([
      provisionTenant("owner"),
      provisionTenant("foreign"),
    ]);
    ownerId = ownerTenant.userId;
    owner = ownerTenant.client;
    foreignId = foreignTenant.userId;
    foreign = foreignTenant.client;
  });
});

afterAll(async () => {
  await whenStackReachable(reachable, async () => {
    const tenants = [...tenantIds];
    const objects = await database.query<{ name: string }>(
      `select name from storage.objects
       where bucket_id = 'photos' and split_part(name, '/', 1) = any($1::text[])`,
      [tenants],
    );
    const names = objects.rows.map((row) => row.name);
    if (names.length > 0) await admin.storage.from("photos").remove(names);
    await database.query(
      `delete from private.pipeline_storage_cleanup_jobs
       where photo_paths && (
         select coalesce(array_agg(object.name), array[]::text[])
         from storage.objects object
         where split_part(object.name, '/', 1) = any($1::text[])
       )
       or source_id in (select id from public.items where user_id = any($1::text[]))`,
      [tenants],
    ).catch(() => undefined);
    await database.query(
      `delete from private.pipeline_storage_cleanup_jobs
       where source_type = 'item_deletion' and source_id = any($1::uuid[])`,
      [[...seededItemIds]],
    ).catch(() => undefined);
    await database.query(
      "delete from private.mobile_item_submissions where user_id = any($1::text[])",
      [tenants],
    ).catch(() => undefined);
    await database.query(
      "delete from private.pipeline_staging_cleanup_intents where user_id = any($1::text[])",
      [tenants],
    ).catch(() => undefined);
    await database.query(
      `delete from private.pipeline_storage_cleanup_jobs
       where source_id in (
         select cleanup_id from private.mobile_item_submission_voice_handoffs
         where user_id = any($1::text[])
       )`,
      [tenants],
    ).catch(() => undefined);
    await database.query(
      "delete from private.mobile_item_submission_voice_handoffs where user_id = any($1::text[])",
      [tenants],
    ).catch(() => undefined);
    // `cleanupClerkTestUsers` lists both credit tables but cannot actually clear
    // them: service_role holds DELETE and not SELECT, so a filtered delete raises
    // "permission denied" — which the helper discards. That was invisible while
    // `ai_item_credit_reservations` cascaded away with the run; the settled rows
    // `delete_item` deliberately detaches have no cascade left to ride, so they
    // are removed here through the superuser connection instead.
    await database.query(
      "delete from public.ai_item_credit_reservations where user_id = any($1::text[])",
      [tenants],
    ).catch(() => undefined);
    await database.query(
      "delete from public.ai_item_allowance_periods where user_id = any($1::text[])",
      [tenants],
    ).catch(() => undefined);
    // The staged runs' queue messages have no cascade to ride: `delete_item`
    // removes the run, and pgmq keeps the wake-up message. Left behind, the
    // pgTAP contract `health exposes queue depth` reads them as live backlog and
    // fails a suite this one never touched. The error is not swallowed here —
    // silence is exactly what let the residue reach an unrelated contract.
    await database.query(
      "delete from pgmq.q_pipeline_jobs where message->>'run_id' = any($1::text[])",
      [[...seededRunIds]],
    );
    const queueDepthAtEnd = await queuedPipelineMessages();
    await cleanupClerkTestUsers(admin, tenants);
    await database.end();
    await lease.release();
    expect(queueDepthAtEnd).toBe(queueDepthAtStart);
  });
});

describe("non-guest item deletion against local Supabase", () => {
  it("purges the seller's item graph, publishes storage cleanup, and spares the other tenant", async () => {
    const [owned, untouched] = await Promise.all([
      seedItem(owner, ownerId, "owned"),
      seedItem(foreign, foreignId, "foreign"),
    ]);

    const before = await tenantResidue(ownerId);
    expect(before).toEqual({ items: 1, predictionLogs: 1, listings: 1 });

    const deleted = await owner.rpc("delete_item", { p_item_id: owned.itemId });
    expect(deleted.error).toBeNull();
    const outcome = deletionOutcome(deleted.data);
    expect(outcome.status).toBe("deleted");
    expect(outcome.item_id).toBe(owned.itemId);
    expect(outcome.blocked_by).toEqual([]);

    // Every SnapList-owned row the retention matrix binds to `item-deletion` is
    // gone — including the prediction log, whose FK would otherwise merely null
    // its `item_id` and leave the pricing evidence behind.
    expect(await tenantResidue(ownerId)).toEqual({
      items: 0,
      predictionLogs: 0,
      listings: 0,
    });

    // Storage removal is published as durable leased work, not performed inside
    // the deleting transaction: the object survives until the cleanup capability
    // proves it absent.
    const job = await storageCleanupJob(owned.itemId);
    expect(job).not.toBeNull();
    expect(job!.state).toBe("pending");
    expect(job!.photo_paths).toContain(owned.photoPath);
    const stillStored = await admin.storage.from("photos").download(owned.photoPath);
    expect(stillStored.error).toBeNull();

    expect(await tenantResidue(foreignId)).toEqual({
      items: 1,
      predictionLogs: 1,
      listings: 1,
    });
    const foreignStored = await admin.storage.from("photos").download(untouched.photoPath);
    expect(foreignStored.error).toBeNull();
  });

  it("keeps a settled AI-item credit spent after the item it paid for is deleted", async () => {
    const seller = await provisionTenant("credited");
    const credited = await seedCreditedItem(seller.userId);

    const settledBefore = await creditLedgerRow(seller.userId);
    expect(settledBefore?.state).toBe("settled");
    const refusalBefore = await refusedSecondRun(seller.userId);

    const deleted = await seller.client.rpc("delete_item", { p_item_id: credited.itemId });
    expect(deleted.error).toBeNull();
    expect(deletionOutcome(deleted.data).status).toBe("deleted");

    // The ledger row survives the run it was bound to. Its FK to `pipeline_runs`
    // is ON DELETE CASCADE, so without an explicit detach the settled credit
    // would disappear with the item and the seller would reclaim a spent
    // AI-item credit — including the free included first run.
    const settledAfter = await creditLedgerRow(seller.userId);
    expect(settledAfter).not.toBeNull();
    expect(settledAfter!.state).toBe("settled");
    expect(settledAfter!.user_id).toBe(seller.userId);
    expect(settledAfter!.pipeline_run_id).toBeNull();
    expect(settledAfter!.item_id).toBeNull();

    // The behaviour that matters: deletion is not a refund.
    expect(await refusedSecondRun(seller.userId)).toBe(refusalBefore);
  });

  it("releases the item's voice handoff and queues its raw audio for removal", async () => {
    const seller = await provisionTenant("voice");
    const credited = await seedCreditedItem(seller.userId);
    const voice = await seedVoiceHandoff(seller.userId, credited);

    const deleted = await seller.client.rpc("delete_item", { p_item_id: credited.itemId });
    expect(deleted.error).toBeNull();
    expect(deletionOutcome(deleted.data).status).toBe("deleted");

    // The handoff carries no foreign key to `items`, so nothing would have
    // removed the item and run identity it holds.
    const handoff = await voiceHandoff(seller.userId);
    expect(handoff).not.toBeNull();
    expect(handoff!.item_id).toBeNull();
    expect(handoff!.run_id).toBeNull();

    // The row survives only as the carrier for the raw-audio absence proof the
    // retention matrix names, and that proof is now pending.
    expect(handoff!.raw_audio_cleanup_queued_at).not.toBeNull();
    expect(handoff!.raw_audio_deleted_at).toBeNull();

    // Surviving as a proof carrier is not a licence to keep the payload. The
    // `seller-voice-transcript` retention row names the language tag as one of
    // the things that must be absent from tenant data by the earliest deletion
    // trigger, and `locale` in the receipt is that tag. What the pending cleanup
    // still needs is the storage path — the ceiling sweep and account erasure
    // both re-read it to publish removal — and nothing else.
    expect(Object.keys(handoff!.receipt).sort()).toEqual(["storage_path"]);
    expect(JSON.stringify(handoff!.receipt)).not.toContain(VOICE_LANGUAGE_TAG);
    expect(handoff!.receipt.storage_path).toBe(voice.storagePath);
    const queued = await database.query<{ photo_paths: string[] }>(
      `select photo_paths from private.pipeline_storage_cleanup_jobs
       where source_type = 'raw_voice' and source_id = $1`,
      [voice.cleanupId],
    );
    expect(queued.rows[0]?.photo_paths).toEqual([voice.storagePath]);
  });

  it("frees the submission key the deleted run held so an outbox replay can reuse it", async () => {
    const seller = await provisionTenant("keyreuse");
    const idempotencyKey = crypto.randomUUID();
    const credited = await seedCreditedItem(seller.userId, {
      idempotencyKey,
      allowance: 2,
    });

    const deleted = await seller.client.rpc("delete_item", { p_item_id: credited.itemId });
    expect(deleted.error).toBeNull();
    expect(deletionOutcome(deleted.data).status).toBe("deleted");

    // The settled reservation is detached rather than cascaded, and it keeps the
    // `logical_run_key` it was reserved under — the submission's idempotency
    // key. Before, the row cascaded away and freed that key. So a client
    // replaying an offline outbox entry whose 200 it never saw now stages a new
    // item and run, the reserve trigger inserts a second reservation under the
    // same key, and a plain unique on (user_id, logical_run_key) raises 23505
    // out of the RPC — at a seller who still has allowance left and did nothing
    // wrong. The key is only meaningful while it identifies a live run.
    const replay = await admin.rpc(
      "stage_pipeline_batch",
      stageArgs(
        seller.userId,
        idempotencyKey,
        `${seller.userId}/item-deletion-key-reuse.jpg`,
      ),
    );
    expect(replay.error).toBeNull();
    const replayed = (replay.data as Array<{ item_id: string; run_id: string }>)[0]!;
    seededItemIds.add(replayed.item_id);
    seededRunIds.add(replayed.run_id);
    expect(replayed.item_id).not.toBe(credited.itemId);

    // Both reservations coexist: the detached settled one still spends its
    // credit, and the new run holds its own.
    const { rows } = await database.query<{
      count: number;
      detached: number;
    }>(
      `select count(*)::integer count,
              count(*) filter (where pipeline_run_id is null)::integer detached
       from public.ai_item_credit_reservations
       where user_id = $1 and logical_run_key = $2`,
      [seller.userId, idempotencyKey],
    );
    expect(rows[0]).toEqual({ count: 2, detached: 1 });
  });

  it("refuses to re-accept a released voice handoff onto a new item", async () => {
    const seller = await provisionTenant("rebind");
    const credited = await seedCreditedItem(seller.userId);
    const voice = await seedVoiceHandoff(seller.userId, credited);
    const key = await database.query<{ idempotency_key: string }>(
      `select idempotency_key
       from private.mobile_item_submission_voice_handoffs
       where user_id = $1`,
      [seller.userId],
    );
    const idempotencyKey = key.rows[0]!.idempotency_key;

    const deleted = await seller.client.rpc("delete_item", { p_item_id: credited.itemId });
    expect(deleted.error).toBeNull();
    expect(deletionOutcome(deleted.data).status).toBe("deleted");

    // `private.mobile_item_submissions` cascades away with the item, so the
    // submission is no longer recognised as a replay — but the handoff has its
    // own primary key and survives. A client retrying an offline outbox entry
    // whose 200 it never saw therefore reaches the accept path again, and the
    // state branch used to fall through to an unconditional bind. That would
    // attach a voice asset already queued for deletion, or already proved
    // absent, to a brand new item.
    const released = await voiceHandoff(seller.userId);
    const rebind = database.query(
      `select private.accept_mobile_submission_voice_handoff(
         $1::text, $2::uuid, $3::jsonb, gen_random_uuid(), gen_random_uuid()
       )`,
      [seller.userId, idempotencyKey, JSON.stringify(released!.receipt)],
    );
    await expect(rebind).rejects.toThrow(
      /voice handoff was released/i,
    );

    const after = await voiceHandoff(seller.userId);
    expect(after!.state).toBe("released");
    expect(after!.item_id).toBeNull();
    expect(after!.run_id).toBeNull();
    expect(after!.receipt.storage_path).toBe(voice.storagePath);
  });

  it("lets the cleanup executor finish both jobs the deletion published", async () => {
    const seller = await provisionTenant("executed");
    const credited = await seedCreditedItem(seller.userId);
    const voice = await seedVoiceHandoff(seller.userId, credited);
    // `stage_pipeline_batch` records the path; the object itself is uploaded by
    // the client. This is the one test that needs the bytes to exist, because
    // it asserts the executor removed them.
    expect(
      (await admin.storage.from("photos").upload(credited.photoPath, jpeg, {
        contentType: "image/jpeg",
        upsert: true,
      })).error,
    ).toBeNull();

    const deleted = await seller.client.rpc("delete_item", { p_item_id: credited.itemId });
    expect(deleted.error).toBeNull();
    expect(deletionOutcome(deleted.data).status).toBe("deleted");
    expect((await admin.storage.from("photos").download(credited.photoPath)).error)
      .toBeNull();

    // The whole point of publishing removal as leased work is that a later pass
    // proves the object absent, so run the executor the worker runs — with the
    // production storage capability, not a stand-in.
    await runPipelineMaintenance({
      store: createSupabasePipelineOperationsStore(admin as never),
      storage: createStorageCleanupCapability(admin.storage.from("photos")),
    });

    // `item_deletion` and `raw_voice` are published by the same transaction and
    // claimed by the same shared executor. A source type the executor cannot
    // name throws after `claim_pipeline_storage_cleanup` has already taken the
    // lease, and that throw escapes `runPipelineMaintenance` — so asserting the
    // raw-voice half completed is what proves the item-deletion half is not a
    // head-of-line block on every other tenant's pending cleanup.
    expect((await admin.storage.from("photos").download(credited.photoPath)).error)
      .not.toBeNull();
    expect((await admin.storage.from("photos").download(voice.storagePath)).error)
      .not.toBeNull();

    expect(await storageCleanupJob(credited.itemId)).toBeNull();
    const rawVoice = await database.query<{ count: number }>(
      `select count(*)::integer count
       from private.pipeline_storage_cleanup_jobs
       where source_type = 'raw_voice' and source_id = $1`,
      [voice.cleanupId],
    );
    expect(rawVoice.rows[0]!.count).toBe(0);

    // The completion proof the retention matrix names for
    // `private-storage-raw-voice`, which only `complete_pipeline_storage_cleanup`
    // may write.
    expect((await voiceHandoff(seller.userId))?.raw_audio_deleted_at).not.toBeNull();
  });

  it("refuses while the item's run is still working and says why", async () => {
    const seller = await provisionTenant("active");
    const credited = await seedCreditedItem(seller.userId, { settle: false });

    const refused = await seller.client.rpc("delete_item", { p_item_id: credited.itemId });
    expect(refused.error).toBeNull();
    const outcome = deletionOutcome(refused.data);
    expect(outcome.status).toBe("blocked");
    expect(outcome.blocked_by).toEqual(["run-in-progress"]);

    // Blocked means nothing moved: a worker still holding this run must not find
    // its item deleted underneath it.
    const residue = await tenantResidue(seller.userId);
    expect(residue.items).toBe(1);
    expect(await storageCleanupJob(credited.itemId)).toBeNull();
  });

  it("refuses while an eBay publish is in flight", async () => {
    const seller = await provisionTenant("publishing");
    const credited = await seedCreditedItem(seller.userId);
    await database.query(
      `update public.listings
       set ebay_status = 'publishing',
           ebay_publish_claim_id = gen_random_uuid(),
           ebay_publish_claimed_at = statement_timestamp()
       where item_id = $1 and user_id = $2`,
      [credited.itemId, seller.userId],
    );

    const refused = await seller.client.rpc("delete_item", { p_item_id: credited.itemId });
    expect(refused.error).toBeNull();
    const outcome = deletionOutcome(refused.data);
    expect(outcome.status).toBe("blocked");
    expect(outcome.blocked_by).toEqual(["ebay-publish-in-progress"]);
    expect((await tenantResidue(seller.userId)).items).toBe(1);
  });

  it("names the live eBay listing it cannot delete as a retained provider record", async () => {
    const seller = await provisionTenant("published");
    const credited = await seedCreditedItem(seller.userId);
    await database.query(
      `update public.listings
       set status = 'published', ebay_status = 'published',
           ebay_listing_id = 'EXTERNAL-EBAY-181'
       where item_id = $1 and user_id = $2`,
      [credited.itemId, seller.userId],
    );

    const deleted = await seller.client.rpc("delete_item", { p_item_id: credited.itemId });
    expect(deleted.error).toBeNull();
    const outcome = deletionOutcome(deleted.data);

    // SnapList deletes what SnapList owns. The listing still live on eBay is the
    // seller's to end there, and saying so is the difference between honest
    // deletion and a false completion claim.
    expect(outcome.status).toBe("deleted");
    expect(outcome.retained_records).toEqual(["ebay-live-listing"]);
    expect((await tenantResidue(seller.userId)).items).toBe(0);
  });

  it("leaves the seller no direct delete that skips the executor", async () => {
    const target = await seedItem(foreign, foreignId, "direct");

    // The row-level DELETE policy on `items` used to be a complete bypass: it
    // cascades the listing and run, nulls the prediction log's `item_id`, and
    // leaves the Storage objects and voice handoff behind with nothing to publish
    // their removal. RLS filters rather than raises, so the bypass reports success
    // — hence the surviving-row assertion rather than an error assertion.
    const direct = await foreign.from("items").delete().eq("id", target.itemId);
    expect(direct.error).toBeNull();
    const survived = await database.query<{ count: number }>(
      "select count(*)::integer count from public.items where id = $1",
      [target.itemId],
    );
    expect(survived.rows[0]!.count).toBe(1);

    const deleted = await foreign.rpc("delete_item", { p_item_id: target.itemId });
    expect(deleted.error).toBeNull();
    expect(deletionOutcome(deleted.data).status).toBe("deleted");
  });

  it("still lets the owner clear an anchor item that produced nothing", async () => {
    // The policy is narrowed, not removed. `runPipelineAndPersist` deletes its own
    // anchor item through the caller's RLS client when a run fails, so a row with
    // no listing and no durable run stays directly deletable — otherwise that
    // cleanup silently matches zero rows and the item strands as "Processing"
    // forever. This is the other half of the test above: without it, a predicate
    // that refused everything would look correct here and break the pipeline.
    const anchor = await foreign
      .from("items")
      .insert({ user_id: foreignId, photos: [], attributes: {} })
      .select("id")
      .single();
    expect(anchor.error).toBeNull();
    const anchorId = (anchor.data as { id: string }).id;

    const cleared = await foreign.from("items").delete().eq("id", anchorId);
    expect(cleared.error).toBeNull();
    const remaining = await database.query<{ count: number }>(
      "select count(*)::integer count from public.items where id = $1",
      [anchorId],
    );
    expect(remaining.rows[0]!.count).toBe(0);
  });

  it("is safe to replay: a second delete refuses and publishes no second cleanup job", async () => {
    const seller = await provisionTenant("replay");
    const credited = await seedCreditedItem(seller.userId);

    const first = await seller.client.rpc("delete_item", { p_item_id: credited.itemId });
    expect(first.error).toBeNull();
    expect(deletionOutcome(first.data).status).toBe("deleted");

    // The client that retries a deletion whose response it never saw is the
    // ordinary case, not the exotic one. It must not re-arm a cleanup job the
    // capability may already have leased, because resetting the lease mid-flight
    // is how one object gets deleted twice and the second attempt dead-letters.
    await database.query(
      `update private.pipeline_storage_cleanup_jobs
       set state = 'running', lease_token = gen_random_uuid(),
           lease_expires_at = statement_timestamp() + interval '5 minutes'
       where source_type = 'item_deletion' and source_id = $1`,
      [credited.itemId],
    );

    const second = await seller.client.rpc("delete_item", { p_item_id: credited.itemId });
    expect(second.error).not.toBeNull();
    expect(second.error!.message).toBe("Item was not found");

    const { rows } = await database.query<{ count: number; state: string }>(
      `select count(*)::integer count, min(state) state
       from private.pipeline_storage_cleanup_jobs
       where source_type = 'item_deletion' and source_id = $1`,
      [credited.itemId],
    );
    expect(rows[0]!.count).toBe(1);
    expect(rows[0]!.state).toBe("running");
  });

  it("leaves no stored eBay publish identifier behind for the deleted item", async () => {
    const seller = await provisionTenant("identifiers");
    const credited = await seedCreditedItem(seller.userId);
    await database.query(
      `update public.listings
       set status = 'published', ebay_status = 'published',
           ebay_offer_id = 'OFFER-181', ebay_listing_id = 'EXTERNAL-EBAY-181'
       where item_id = $1 and user_id = $2`,
      [credited.itemId, seller.userId],
    );

    // Counted before as well as after: an assertion that only reads zero once
    // the rows are gone would pass with the whole deletion path reverted.
    expect(await storedEbayIdentifiers(seller.userId)).toBe(1);

    const deleted = await seller.client.rpc("delete_item", { p_item_id: credited.itemId });
    expect(deleted.error).toBeNull();
    expect(deletionOutcome(deleted.data).status).toBe("deleted");

    // The completion proof the retention matrix names for `ebay-publish-receipts`:
    // the eBay-issued identifiers SnapList stored are absent for that tenant.
    // SnapList still does not claim the live listing was deleted — that record
    // is eBay's, and it is reported as retained rather than erased.
    expect(await storedEbayIdentifiers(seller.userId)).toBe(0);
    expect(deletionOutcome(deleted.data).retained_records).toEqual(["ebay-live-listing"]);
  });

  it("deletes a claimed guest item without disturbing the #175 recovery outcome", async () => {
    const seller = await provisionTenant("claimed");
    const credited = await seedCreditedItem(seller.userId);
    const recoveryId = crypto.randomUUID();
    const guestUserId = `guest_${seller.userId}`;
    const reservation = await database.query<{ id: string }>(
      "select id from public.ai_item_credit_reservations where user_id = $1",
      [seller.userId],
    );
    await database.query(
      `insert into private.guest_draft_recoveries (
         id, guest_user_id, pipeline_run_id, item_id, draft_id, reservation_id,
         allowance_period_id, recovery_token_hash, storage_object_count,
         usable_draft_at, expires_at, state, claim_target_user_id, claimed_at,
         claimed_lease_token, claimed_storage_manifest
       )
       select $1::uuid, $2::text, $3::uuid, $4::uuid, listing.id, $5::uuid,
              gen_random_uuid(), $6::text, 1,
              statement_timestamp() - interval '1 hour',
              statement_timestamp() + interval '23 hours',
              'claimed', $7::text, statement_timestamp() - interval '30 minutes',
              gen_random_uuid(), '[]'::jsonb
       from public.listings listing
       where listing.item_id = $4::uuid and listing.user_id = $7::text`,
      [
        recoveryId,
        guestUserId,
        credited.runId,
        credited.itemId,
        reservation.rows[0]!.id,
        "c".repeat(64),
        seller.userId,
      ],
    );

    const before = await guestRecovery(recoveryId);
    expect(before).toMatchObject({ state: "claimed", item_id: credited.itemId });

    const deleted = await seller.client.rpc("delete_item", { p_item_id: credited.itemId });
    expect(deleted.error).toBeNull();
    expect(deletionOutcome(deleted.data).status).toBe("deleted");

    // #181 consumes the claimed outcome; it does not own the guest clock,
    // artifact selection, or expiry. The recovery row carries no foreign key to
    // `items`, and deleting the claimed item must leave the terminal outcome and
    // both deadlines exactly where #175 put them.
    expect(await guestRecovery(recoveryId)).toEqual(before);
  });

  it("translates the executor's own refusal into 409 and its P0002 into 404", async () => {
    const seller = await provisionTenant("transport");
    const credited = await seedCreditedItem(seller.userId, { settle: false });
    const transport = transportForSeller(seller.userId);

    // A refusal is a successful RPC carrying `{"status":"blocked"}`, so a
    // transport that read only `error` would report 200 and a deletion that
    // never happened; one that treated it as unexpected would report 500 and
    // send the seller to support over an item that is merely busy.
    const blocked = await transport(deleteRequest(credited.itemId, seller.token));
    expect(blocked.status).toBe(409);
    const body = (await blocked.json()) as {
      error: { code: string; details?: { blockedBy?: string[] } };
    };
    expect(body.error.code).toBe("conflict");
    expect(body.error.details?.blockedBy).toEqual(["run-in-progress"]);
    expect((await tenantResidue(seller.userId)).items).toBe(1);

    // The other shape: `delete_item` raises P0002 for an item outside the
    // caller's tenant, which reaches the route as a PostgrestError rather than
    // a parsed outcome.
    const foreignItem = await seedItem(owner, ownerId, "transport-guarded");
    const missing = await transport(deleteRequest(foreignItem.itemId, seller.token));
    expect(missing.status).toBe(404);
    const stillThere = await database.query<{ count: number }>(
      "select count(*)::integer count from public.items where id = $1",
      [foreignItem.itemId],
    );
    expect(stillThere.rows[0]!.count).toBe(1);
  });

  it("refuses another tenant's item without disclosing whether it exists", async () => {
    const seller = await provisionTenant("intruder");
    const target = await seedItem(owner, ownerId, "guarded");

    const refused = await seller.client.rpc("delete_item", { p_item_id: target.itemId });
    expect(refused.error).not.toBeNull();
    expect(refused.error!.message).toBe("Item was not found");

    const stillThere = await database.query<{ count: number }>(
      "select count(*)::integer count from public.items where id = $1",
      [target.itemId],
    );
    expect(stillThere.rows[0]!.count).toBe(1);
  });
});
