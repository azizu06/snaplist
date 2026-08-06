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
import { skipIfStackUnreachable, stackReachable, whenStackReachable } from "@/test/supabase-stack";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const DATABASE_URL = resolveLocalTestDatabaseUrl();

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

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
 * A tenant per behaviour. AI-item allowance is per seller and deliberately
 * consumed by these tests, so sharing one tenant would make each test depend on
 * the order the others ran in.
 */
async function provisionTenant(label: string): Promise<{
  userId: string;
  client: SupabaseClient;
}> {
  const userId = `user_test_item_deletion_${label}_${Date.now()}`;
  tenantIds.add(userId);
  const token = await mintUserJwt(userId);
  return {
    userId,
    client: createClient(SUPABASE_URL, PUBLISHABLE_KEY!, {
      accessToken: async () => token,
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  };
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
  options: { settle?: boolean } = {},
): Promise<{ itemId: string; runId: string; photoPath: string }> {
  await grantIncludedOfferDeviceClaim(admin, userId);
  const photoPath = `${userId}/item-deletion-credited.jpg`;
  const staged = await admin.rpc(
    "stage_pipeline_batch",
    stageArgs(userId, crypto.randomUUID(), photoPath),
  );
  if (staged.error) throw new Error(staged.error.message);
  const row = (staged.data as Array<{ item_id: string; run_id: string }>)[0];
  if (!row) throw new Error("Credited item fixture did not stage.");
  seededItemIds.add(row.item_id);

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

/** The accepted voice note for an item, with its raw audio still present. */
async function seedVoiceHandoff(
  userId: string,
  item: { itemId: string; runId: string },
): Promise<{ cleanupId: string; storagePath: string }> {
  const cleanupId = crypto.randomUUID();
  const storagePath = `${userId}/voice/${cleanupId}.m4a`;
  await database.query(
    `insert into private.mobile_item_submission_voice_handoffs (
       user_id, idempotency_key, request_fingerprint, batch_id, cleanup_id,
       receipt, state, item_id, run_id, accepted_at
     )
     values ($1::text, gen_random_uuid(), $2::text, gen_random_uuid(), $3::uuid,
             jsonb_build_object('storage_path', $4::text), 'accepted',
             $5::uuid, $6::uuid, statement_timestamp())`,
    [userId, "b".repeat(64), cleanupId, storagePath, item.itemId, item.runId],
  );
  return { cleanupId, storagePath };
}

async function voiceHandoff(userId: string): Promise<{
  state: string;
  item_id: string | null;
  run_id: string | null;
  raw_audio_cleanup_queued_at: Date | null;
  raw_audio_deleted_at: Date | null;
} | null> {
  const { rows } = await database.query<{
    state: string;
    item_id: string | null;
    run_id: string | null;
    raw_audio_cleanup_queued_at: Date | null;
    raw_audio_deleted_at: Date | null;
  }>(
    `select state, item_id, run_id, raw_audio_cleanup_queued_at, raw_audio_deleted_at
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
    lease = await acquireExclusiveTestResource("pipeline_jobs");
    database = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2_000 });
    await database.connect();
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
    await cleanupClerkTestUsers(admin, tenants);
    await database.end();
    await lease.release();
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
    const queued = await database.query<{ photo_paths: string[] }>(
      `select photo_paths from private.pipeline_storage_cleanup_jobs
       where source_type = 'raw_voice' and source_id = $1`,
      [voice.cleanupId],
    );
    expect(queued.rows[0]?.photo_paths).toEqual([voice.storagePath]);
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
