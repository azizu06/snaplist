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
import { createMobileItemSubmissionHandler } from "@/lib/mobile-item-submission/http";
import { createMobileItemSubmissionOperations } from "@/lib/mobile-item-submission/service";
import { createSupabaseMobileItemSubmissionStaging } from "@/lib/mobile-item-submission/store";
import { MockEbayAdapter } from "@/lib/marketplace/ebay/mock";
import { publishListingToEbay } from "@/lib/marketplace/ebay/publish";
import { runPipelineAndPersist } from "@/lib/pipeline/persist";
import { StubPipeline } from "@/lib/pipeline/stub";
import { skipIfStackUnreachable, stackReachable, whenStackReachable } from "@/test/supabase-stack";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const DATABASE_URL = resolveLocalTestDatabaseUrl();

const ERASURE_STATUSES = [
  "deletion_requested",
  "deletion_in_progress",
  "deletion_completed",
  "deletion_completed_with_retained_records",
  "deletion_needs_attention",
] as const;

interface ErasureStorageObject {
  bucket_id: string;
  object_name: string;
}

interface ErasurePayload {
  generation_id: string;
  status: (typeof ERASURE_STATUSES)[number];
  storage_objects: ErasureStorageObject[];
  retained_records: string[];
  deferrals: string[];
  attention_reasons: string[];
  identity: { clerk_user_id: string; revenuecat_app_user_ids: string[] } | null;
}

let reachable = false;
let database: Client;
let admin: SupabaseClient;
let lease: ExclusiveTestResourceLease;
let ownerId = "";
let foreignId = "";
let ownerToken = "";
let foreignToken = "";
let releaseSecondUpload: () => void = () => {};

beforeEach((context) => {
  skipIfStackUnreachable(context, reachable);
});

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function multipart(): FormData {
  const body = new FormData();
  body.append("photo", new File([jpeg.buffer], "front.jpg", { type: "image/jpeg" }));
  body.append("photo", new File([png.buffer], "back.png", { type: "image/png" }));
  return body;
}

function submissionRequest(token: string, idempotencyKey: string): Request {
  return new Request("http://127.0.0.1:3001/v1/items/runs", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": idempotencyKey,
    },
    body: multipart(),
  });
}

function erasurePayload(value: unknown): ErasurePayload {
  if (!value || typeof value !== "object") throw new Error("Erasure payload is missing.");
  const payload = value as Partial<ErasurePayload>;
  if (
    typeof payload.generation_id !== "string" ||
    !ERASURE_STATUSES.includes(payload.status as (typeof ERASURE_STATUSES)[number]) ||
    !Array.isArray(payload.storage_objects) ||
    !Array.isArray(payload.retained_records) ||
    !Array.isArray(payload.deferrals) ||
    !Array.isArray(payload.attention_reasons)
  ) {
    throw new Error("Erasure payload is invalid.");
  }
  return payload as ErasurePayload;
}

async function advanceErasure(generationId: string): Promise<ErasurePayload> {
  const advanced = await admin.rpc("advance_account_erasure", {
    p_generation_id: generationId,
  });
  expect(advanced.error).toBeNull();
  return erasurePayload(advanced.data);
}

/**
 * Stands in for the provider identity phase, which runs outside Postgres. The
 * absence flags are what the executor observed at Clerk and RevenueCat; Postgres
 * still re-proves everything SnapList owns before writing a terminal status.
 */
async function finalizeErasure(
  generationId: string,
  proof: {
    clerk?: boolean;
    revenueCat?: boolean;
    postHog?: boolean;
    attention?: string[];
  } = {},
): Promise<ErasurePayload> {
  const finalized = await admin.rpc("finalize_account_erasure", {
    p_attention_reasons: proof.attention ?? [],
    p_clerk_identity_absent: proof.clerk ?? true,
    p_generation_id: generationId,
    p_posthog_person_and_events_deletion_confirmed: proof.postHog ?? true,
    p_revenuecat_customer_absent: proof.revenueCat ?? true,
  });
  expect(finalized.error).toBeNull();
  return erasurePayload(finalized.data);
}

/** The scrubbed receipt that must outlive the account it erased. */
async function erasureReceipt(userId: string): Promise<{
  status: string;
  user_id: string | null;
  idempotency_key: string | null;
  clerk_user_id: string | null;
  posthog_person_uuid: string | null;
  posthog_person_and_events_deletion_proved_at: Date | string | null;
  completed_at: Date | string | null;
  retained_records: string[];
} | null> {
  const { rows } = await database.query(
    `select status, user_id, idempotency_key, clerk_user_id,
            posthog_person_uuid,
            posthog_person_and_events_deletion_proved_at,
            completed_at,
            retained_records
     from private.account_erasure_generations
     where user_id_digest = private.account_erasure_user_digest($1)`,
    [userId],
  );
  return rows[0] ?? null;
}

async function stageCreditedRun(userId: string): Promise<{
  runId: string;
  queueMessageId: string;
  allowancePeriodId: string;
}> {
  await grantIncludedOfferDeviceClaim(admin, userId);
  const idempotencyKey = crypto.randomUUID();
  const staged = await admin.rpc("stage_pipeline_batch", {
    p_batch_id: crypto.randomUUID(),
    p_daily_limit: 1_000,
    p_entries: [{
      idempotency_key: idempotencyKey,
      source: "single",
      autopilot_enabled: false,
      photo_paths: [`${userId}/account-erasure/credit.jpg`],
      cost_basis: null,
    }],
    p_per_minute_limit: 1_000,
    p_photo_identities: [{
      idempotency_key: idempotencyKey,
      photo_identity_kind: "content_sha256_set_v1",
      photo_identity_fingerprint: "a".repeat(64),
    }],
    p_user_id: userId,
  });
  if (staged.error) throw new Error(staged.error.message);
  const row = (staged.data as Array<{
    run_id: string;
    queue_message_id: string | number;
  }>)[0];
  if (!row) throw new Error("Credited account-erasure run was not staged.");
  const allowancePeriod = await database.query<{ id: string }>(
    `select id from public.ai_item_allowance_periods
     where user_id = $1
       and source = 'included'
       and period_key = 'included-first-run'`,
    [userId],
  );
  if (allowancePeriod.rowCount !== 1) {
    throw new Error("Credited account-erasure allowance period was not staged.");
  }
  return {
    runId: row.run_id,
    queueMessageId: String(row.queue_message_id),
    allowancePeriodId: allowancePeriod.rows[0]!.id,
  };
}

async function foreignState(): Promise<{
  settings: unknown;
  objectRow: unknown;
  objectBytes: Uint8Array;
}> {
  const rows = await database.query<{ settings: unknown; object_row: unknown }>(
    `select
       (select to_jsonb(settings)
        from public.user_settings settings
        where settings.user_id = $1) settings,
       (select to_jsonb(object)
        from storage.objects object
        where object.bucket_id = 'photos'
          and object.name = $2) object_row`,
    [foreignId, `${foreignId}/account-erasure-foreign.jpg`],
  );
  const stored = await admin.storage
    .from("photos")
    .download(`${foreignId}/account-erasure-foreign.jpg`);
  if (stored.error || !stored.data) {
    throw new Error(`Foreign Storage fixture is unavailable: ${stored.error?.message}`);
  }
  return {
    settings: rows.rows[0]!.settings,
    objectRow: rows.rows[0]!.object_row,
    objectBytes: new Uint8Array(await stored.data.arrayBuffer()),
  };
}

async function mandatoryOwnerResidue(): Promise<number> {
  const result = await database.query<{ count: number }>(
    `select coalesce(sum(residue.count), 0)::integer count
     from (
       select count(*)::integer count from public.items where user_id = $1
       union all select count(*)::integer from public.listings where user_id = $1
       union all select count(*)::integer from public.messages where user_id = $1
       union all select count(*)::integer from public.embeddings where user_id = $1
       union all select count(*)::integer from public.prediction_logs where user_id = $1
       union all select count(*)::integer from public.user_settings where user_id = $1
       union all select count(*)::integer from public.ebay_connections where user_id = $1
       union all select count(*)::integer from public.subscriptions where user_id = $1
       union all select count(*)::integer from public.notifications where user_id = $1
       union all select count(*)::integer from public.reprice_suggestions where user_id = $1
       union all select count(*)::integer from public.ebay_message_sync_state where user_id = $1
       union all select count(*)::integer from public.ebay_unresolved_questions where user_id = $1
       union all select count(*)::integer from public.message_policy_decisions where user_id = $1
       union all select count(*)::integer from public.message_attachments where user_id = $1
       union all select count(*)::integer from public.billing_customers where user_id = $1
       union all select count(*)::integer from public.billing_checkout_reservations where user_id = $1
       union all select count(*)::integer from public.ai_item_allowance_periods where user_id = $1
       union all select count(*)::integer from public.ai_item_credit_reservations where user_id = $1
       union all select count(*)::integer from public.revenuecat_customer_bindings where user_id = $1
       union all select count(*)::integer from public.pipeline_runs where user_id = $1
       union all select count(*)::integer from public.pricing_evidence_snapshots where user_id = $1
       union all select count(*)::integer from public.ebay_oauth_sessions where user_id = $1
       union all select count(*)::integer from private.ebay_messaging_account_generations where user_id = $1
       union all select count(*)::integer from private.ebay_seller_account_generations where user_id = $1
       union all select count(*)::integer from private.ebay_provider_dispatch_leases where user_id = $1
       union all select count(*)::integer from private.ebay_buyer_identity_provenance where user_id = $1
       union all select count(*)::integer from private.ebay_buyer_identity_observations where user_id = $1
       union all select count(*)::integer from private.ebay_erased_buyer_generation_tombstones where user_id = $1
       union all select count(*)::integer from private.ebay_sandbox_fallback_bindings where user_id = $1
       union all select count(*)::integer from private.ebay_unmappable_connection_quarantines where user_id = $1
       union all select count(*)::integer from private.ebay_seller_identity_tenants where user_id = $1
       union all select count(*)::integer from private.pipeline_run_usage_reservations where user_id = $1
       union all select count(*)::integer from private.pipeline_staging_cleanup_intents where user_id = $1
       union all select count(*)::integer from private.legacy_pipeline_usage_reservations where user_id = $1
       union all select count(*)::integer from private.mobile_item_submissions where user_id = $1
       union all select count(*)::integer from private.mobile_run_operation_replays where user_id = $1
       union all select count(*)::integer from private.guided_correction_completion_capabilities where user_id = $1
       union all select count(*)::integer from private.storekit_ai_item_period_events where user_id = $1
       union all select count(*)::integer from private.revenuecat_webhook_events where user_id = $1
       union all select count(*)::integer
         from private.guest_draft_recoveries
         where $1 in (guest_user_id, claim_idempotency_user_id, claim_target_user_id)
       union all select count(*)::integer
         from private.pipeline_storage_cleanup_jobs job
         where exists (
           select 1 from unnest(job.photo_paths) path
           where split_part(path, '/', 1) = $1
         )
       union all select count(*)::integer
         from private.message_photo_object_deletion_queue
         where split_part(storage_path, '/', 1) = $1
       union all select count(*)::integer
         from storage.objects
         where bucket_id in ('photos', 'message-photos')
           and split_part(name, '/', 1) = $1
     ) residue`,
    [ownerId],
  );
  return result.rows[0]!.count;
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
  ownerId = `user_test_account_erasure_owner_${Date.now()}`;
  foreignId = `user_test_account_erasure_foreign_${Date.now()}`;
  [ownerToken, foreignToken] = await Promise.all([
    mintUserJwt(ownerId),
    mintUserJwt(foreignId),
  ]);
  const foreign = createClient(SUPABASE_URL, PUBLISHABLE_KEY!, {
    accessToken: async () => foreignToken,
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const owner = createClient(SUPABASE_URL, PUBLISHABLE_KEY!, {
    accessToken: async () => ownerToken,
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const [foreignSettings, ownerSettings, foreignObject] = await Promise.all([
    foreign.from("user_settings").insert({ user_id: foreignId }),
    owner.from("user_settings").insert({ user_id: ownerId }),
    foreign.storage
      .from("photos")
      .upload(`${foreignId}/account-erasure-foreign.jpg`, jpeg, {
        contentType: "image/jpeg",
        upsert: false,
      }),
  ]);
  expect(foreignSettings.error).toBeNull();
  expect(ownerSettings.error).toBeNull();
  expect(foreignObject.error).toBeNull();
  });
});

afterAll(async () => {
  releaseSecondUpload();
  await whenStackReachable(reachable, async () => {

  const objects = await database.query<{ bucket_id: string; name: string }>(
    `select bucket_id, name
     from storage.objects
     where bucket_id in ('photos', 'message-photos')
       and split_part(name, '/', 1) = any($1::text[])`,
    [[ownerId, foreignId]],
  );
  for (const bucketId of ["photos", "message-photos"]) {
    const names = objects.rows
      .filter((row) => row.bucket_id === bucketId)
      .map((row) => row.name);
    if (names.length > 0) await admin.storage.from(bucketId).remove(names);
  }

  await database.query(
    "delete from private.mobile_item_submissions where user_id = any($1::text[])",
    [[ownerId, foreignId]],
  );
  await database.query(
    "delete from private.pipeline_staging_cleanup_intents where user_id = any($1::text[])",
    [[ownerId, foreignId]],
  );
  await database.query(
    "delete from private.account_erasure_generations where user_id = any($1::text[])",
    [[ownerId, foreignId]],
  ).catch(() => undefined);
  await cleanupClerkTestUsers(admin, [ownerId, foreignId]);
  await database.end();
  await lease.release();
  });
});

describe("durable account erasure against local Supabase", () => {
  it("fences an active upload, resumes one generation, and preserves foreign bytes", async () => {

    const foreignBefore = await foreignState();
    const owner = createClient(SUPABASE_URL, PUBLISHABLE_KEY!, {
      accessToken: async () => ownerToken,
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const bucket = owner.storage.from("photos");
    let uploadCount = 0;
    let secondUploadPath = "";
    let reportSecondUpload: () => void = () => {};
    const secondUploadStarted = new Promise<void>((resolve) => {
      reportSecondUpload = resolve;
    });
    const holdSecondUpload = new Promise<void>((resolve) => {
      releaseSecondUpload = resolve;
    });
    const submitter = createMobileItemSubmissionOperations({
      async resolvePrincipal(bearerToken) {
        return { kind: "clerk", userId: ownerId, bearerToken };
      },
      // Keep a no-fence RED from creating a pipeline run after the paused upload.
      limits: { dailyLimit: 0, perMinuteLimit: 20 },
      staging: createSupabaseMobileItemSubmissionStaging(admin),
      storageFor: () => ({
        async upload(path, bytes, mediaType) {
          uploadCount += 1;
          if (uploadCount === 2) {
            secondUploadPath = path;
            reportSecondUpload();
            await holdSecondUpload;
          }
          const { error } = await bucket.upload(path, bytes, {
            contentType: mediaType,
            upsert: false,
          });
          if (error) throw error;
        },
        async download(path) {
          const { data, error } = await bucket.download(path);
          if (error) throw error;
          return {
            bytes: new Uint8Array(await data.arrayBuffer()),
            mediaType: data.type,
          };
        },
      }),
    });
    const submission = createMobileItemSubmissionHandler({
      requestId: () => crypto.randomUUID(),
      itemSubmission: submitter,
    });
    const uploadKey = crypto.randomUUID();
    const uploadResponse = submission(submissionRequest(ownerToken, uploadKey));
    await secondUploadStarted;

    const erasureKey = crypto.randomUUID();
    console.info("account-erasure fixture", JSON.stringify({
      ownerId,
      foreignId,
      uploadKey,
      erasureKey,
      secondUploadPath,
      foreignObjectPath: `${foreignId}/account-erasure-foreign.jpg`,
    }));
    const unauthorized = await owner.rpc("begin_account_erasure", {
      p_idempotency_key: erasureKey,
      p_user_id: ownerId,
    });
    expect(unauthorized.error).not.toBeNull();
    const first = await admin.rpc("begin_account_erasure", {
      p_idempotency_key: erasureKey,
      p_user_id: ownerId,
    });
    if (first.error) {
      releaseSecondUpload();
      await uploadResponse;
      expect(first.error).toBeNull();
      return;
    }
    const started = erasurePayload(first.data);
    expect(started.status).toBe("deletion_requested");
    expect(started.storage_objects).toHaveLength(1);
    expect(started.storage_objects[0]).toMatchObject({ bucket_id: "photos" });

    releaseSecondUpload();
    expect((await uploadResponse).status).toBe(503);
    const escapedSecondObject = await database.query<{ count: number }>(
      `select count(*)::integer count
       from storage.objects
       where bucket_id = 'photos' and name = $1`,
      [secondUploadPath],
    );
    expect(escapedSecondObject.rows[0]!.count).toBe(0);

    // Simulate process loss after the first delete but before durable absence is recorded.
    const selected = started.storage_objects[0]!;
    const removed = await admin.storage.from(selected.bucket_id).remove([selected.object_name]);
    expect(removed.error).toBeNull();

    const replay = await admin.rpc("begin_account_erasure", {
      p_idempotency_key: erasureKey,
      p_user_id: ownerId,
    });
    expect(replay.error).toBeNull();
    const resumed = erasurePayload(replay.data);
    expect(resumed.generation_id).toBe(started.generation_id);
    expect(resumed.storage_objects).toEqual(started.storage_objects);
    const conflictingReplay = await admin.rpc("begin_account_erasure", {
      p_idempotency_key: crypto.randomUUID(),
      p_user_id: ownerId,
    });
    expect(conflictingReplay.error).not.toBeNull();
    const generationCount = await database.query<{ count: number }>(
      `select count(*)::integer count
       from private.account_erasure_generations
       where user_id = $1`,
      [ownerId],
    );
    expect(generationCount.rows[0]!.count).toBe(1);

    const removedAgain = await admin.storage
      .from(selected.bucket_id)
      .remove([selected.object_name]);
    expect(removedAgain.error).toBeNull();
    const confirmed = await admin.rpc("confirm_account_erasure_storage_absence", {
      p_bucket_id: selected.bucket_id,
      p_generation_id: started.generation_id,
      p_object_name: selected.object_name,
    });
    expect(confirmed.error).toBeNull();
    expect(confirmed.data).toBe(true);

    const advanced = await advanceErasure(started.generation_id);
    expect(advanced).toMatchObject({
      generation_id: started.generation_id,
      status: "deletion_in_progress",
      storage_objects: [],
      deferrals: [],
    });
    // The provider identity work Postgres cannot do is handed out, not guessed at.
    expect(advanced.identity).toMatchObject({ clerk_user_id: ownerId });
    expect(await mandatoryOwnerResidue()).toBe(0);

    // The PostHog completion proof is a receipt gate, not advisory metadata.
    // Withhold it and no terminal receipt may be written.
    const postHogUnproved = await admin.rpc("finalize_account_erasure", {
      p_attention_reasons: [],
      p_clerk_identity_absent: true,
      p_generation_id: started.generation_id,
      p_posthog_person_and_events_deletion_confirmed: false,
      p_revenuecat_customer_absent: true,
    });
    expect(postHogUnproved.error).not.toBeNull();
    expect(await erasureReceipt(ownerId)).toMatchObject({
      status: "deletion_in_progress",
      completed_at: null,
      posthog_person_and_events_deletion_proved_at: null,
    });

    // Provider-owned deletion is not SnapList deletion: without observed
    // absence there is no completion to report.
    const unproved = await admin.rpc("finalize_account_erasure", {
      p_attention_reasons: [],
      p_clerk_identity_absent: false,
      p_generation_id: started.generation_id,
      p_posthog_person_and_events_deletion_confirmed: true,
      p_revenuecat_customer_absent: true,
    });
    expect(unproved.error).not.toBeNull();
    expect(await erasureReceipt(ownerId)).toMatchObject({
      status: "deletion_in_progress",
    });

    const completed = await finalizeErasure(started.generation_id);
    expect(completed).toMatchObject({
      generation_id: started.generation_id,
      status: "deletion_completed",
      storage_objects: [],
      retained_records: [],
      identity: null,
    });

    // The receipt survives so replay and the fence stay truthful, but it keeps
    // no raw identifier of the account it erased.
    expect(await erasureReceipt(ownerId)).toMatchObject({
      status: "deletion_completed",
      user_id: null,
      idempotency_key: null,
      clerk_user_id: null,
      posthog_person_uuid: null,
      posthog_person_and_events_deletion_proved_at: expect.anything(),
      completed_at: expect.anything(),
      retained_records: [],
    });
    const manifestResidue = await database.query<{ count: number }>(
      `select count(*)::integer count
       from private.account_erasure_storage_manifest
       where generation_id = $1`,
      [started.generation_id],
    );
    expect(manifestResidue.rows[0]!.count).toBe(0);
    expect(await mandatoryOwnerResidue()).toBe(0);

    // A replay after completion resolves to the one generation, not a new one.
    const terminalReplay = await admin.rpc("begin_account_erasure", {
      p_idempotency_key: erasureKey,
      p_user_id: ownerId,
    });
    expect(terminalReplay.error).toBeNull();
    expect(erasurePayload(terminalReplay.data)).toMatchObject({
      generation_id: started.generation_id,
      status: "deletion_completed",
    });

    const foreignAfter = await foreignState();
    expect(foreignAfter.settings).toEqual(foreignBefore.settings);
    expect(foreignAfter.objectRow).toEqual(foreignBefore.objectRow);
    expect(foreignAfter.objectBytes).toEqual(foreignBefore.objectBytes);
  });

  it("blocks a new eBay publish before the adapter and never treats an existing listing as ended", async () => {

    const publishOwnerId = `user_test_account_erasure_ebay_${Date.now()}`;
    const publishOwnerToken = await mintUserJwt(publishOwnerId);
    const publishOwner = createClient(SUPABASE_URL, PUBLISHABLE_KEY!, {
      accessToken: async () => publishOwnerToken,
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const publishOwnerServer = createClient(SUPABASE_URL, SECRET_KEY!, {
      accessToken: async () => publishOwnerToken,
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const paths = [
      `${publishOwnerId}/account-erasure-existing.jpg`,
      `${publishOwnerId}/account-erasure-draft.jpg`,
      `${publishOwnerId}/account-erasure-in-flight.jpg`,
    ];
    const inFlightClaimId = crypto.randomUUID();
    let generationId = "";

    try {
      for (const path of paths) {
        const uploaded = await publishOwner.storage.from("photos").upload(path, jpeg, {
          contentType: "image/jpeg",
          upsert: false,
        });
        expect(uploaded.error).toBeNull();
      }
      const [existing, draft, inFlight] = await Promise.all([
        runPipelineAndPersist(
          publishOwner,
          { userId: publishOwnerId, photos: [paths[0]!] },
          new StubPipeline(),
        ),
        runPipelineAndPersist(
          publishOwner,
          { userId: publishOwnerId, photos: [paths[1]!] },
          new StubPipeline(),
        ),
        runPipelineAndPersist(
          publishOwner,
          { userId: publishOwnerId, photos: [paths[2]!] },
          new StubPipeline(),
        ),
      ]);
      await database.query(
        `update public.listings
         set status = 'published',
             ebay_status = 'published',
             ebay_listing_id = 'EXTERNAL-EBAY-384'
         where id = $1 and user_id = $2`,
        [existing.listingId, publishOwnerId],
      );
      const fallback = await publishOwnerServer.rpc("bind_ebay_sandbox_fallback", {
        p_seller_id: `account-erasure-${publishOwnerId}`,
      });
      expect(fallback.error).toBeNull();
      const accountGeneration = fallback.data as string;
      await database.query(
        `update public.listings
         set ebay_status = 'publishing',
             ebay_publish_claim_id = $1,
             ebay_publish_claimed_at = statement_timestamp()
         where id = $2 and user_id = $3`,
        [inFlightClaimId, inFlight.listingId, publishOwnerId],
      );
      const startedDispatch = await publishOwnerServer.rpc(
        "begin_ebay_transactional_dispatch",
        {
          p_connection_generation: null,
          p_operation: "publish",
          p_publish_binding: null,
          p_publish_claim_id: inFlightClaimId,
          p_resource_id: inFlight.listingId,
        },
      );
      expect(startedDispatch.error).toBeNull();
      const dispatch = startedDispatch.data as {
        account_generation: string;
        attempt_token: string;
      };
      expect(dispatch.account_generation).toBe(accountGeneration);
      const inFlightDispatchToken = dispatch.attempt_token;

      const startedResult = await admin.rpc("begin_account_erasure", {
        p_idempotency_key: crypto.randomUUID(),
        p_user_id: publishOwnerId,
      });
      expect(startedResult.error).toBeNull();
      const started = erasurePayload(startedResult.data);
      generationId = started.generation_id;
      console.info("account-erasure eBay fixture", JSON.stringify({
        publishOwnerId,
        generationId,
        existingListingId: existing.listingId,
        draftListingId: draft.listingId,
        inFlightListingId: inFlight.listingId,
        inFlightClaimId,
        inFlightAttemptToken: inFlightDispatchToken,
        accountGeneration,
        paths,
      }));

      const adapter = new MockEbayAdapter();
      await expect(
        publishListingToEbay(publishOwner, draft.listingId, adapter),
      ).rejects.toThrow();
      expect(adapter.requests).toHaveLength(0);
      expect(adapter.reviseRequests).toHaveLength(0);

      const deletedInFlight = await publishOwner
        .from("listings")
        .delete()
        .eq("id", inFlight.listingId);
      expect(deletedInFlight.error).not.toBeNull();
      const inFlightBeforeCompletion = await database.query<{ count: number }>(
        "select count(*)::integer count from public.listings where id = $1 and ebay_status = 'publishing'",
        [inFlight.listingId],
      );
      expect(inFlightBeforeCompletion.rows[0]!.count).toBe(1);

      for (const object of started.storage_objects) {
        const removed = await admin.storage.from(object.bucket_id).remove([object.object_name]);
        expect(removed.error).toBeNull();
        const confirmed = await admin.rpc("confirm_account_erasure_storage_absence", {
          p_bucket_id: object.bucket_id,
          p_generation_id: generationId,
          p_object_name: object.object_name,
        });
        expect(confirmed.error).toBeNull();
      }

      // A dispatch is already with eBay. Deleting the local record that explains
      // it would erase SnapList's own account of an action eBay is still
      // performing, so erasure waits instead.
      const pendingAuthority = await advanceErasure(generationId);
      expect(pendingAuthority).toMatchObject({
        status: "deletion_in_progress",
        deferrals: ["ebay-provider-authority-pending"],
      });

      const acknowledged = await publishOwnerServer.rpc("complete_ebay_publish_dispatch", {
        p_account_generation: accountGeneration,
        p_attempt_token: inFlightDispatchToken,
        p_claim_id: inFlightClaimId,
        p_connection_generation: null,
        p_ebay_listing_id: "EXTERNAL-EBAY-IN-FLIGHT-384",
        p_ebay_offer_id: "EXTERNAL-EBAY-OFFER-384",
        p_listed_price: 42,
        p_listing_id: inFlight.listingId,
        p_priced_at: "2026-07-22T21:00:00Z",
      });
      expect(acknowledged.error).toBeNull();
      const acknowledgedListing = await database.query<{
        ebay_listing_id: string | null;
        ebay_status: string | null;
      }>(
        "select ebay_listing_id, ebay_status from public.listings where id = $1",
        [inFlight.listingId],
      );
      expect(acknowledgedListing.rows[0]).toEqual({
        ebay_listing_id: "EXTERNAL-EBAY-IN-FLIGHT-384",
        ebay_status: "published",
      });

      // The provider round trip has landed, so the local rows go — but the live
      // eBay listings do not, and erasure records exactly that.
      const advanced = await advanceErasure(generationId);
      expect(advanced).toMatchObject({
        status: "deletion_in_progress",
        deferrals: [],
        retained_records: ["ebay-live-listing"],
      });
      const stillLocal = await database.query<{ count: number }>(
        "select count(*)::integer count from public.listings where id = any($1::uuid[])",
        [[existing.listingId, inFlight.listingId]],
      );
      expect(stillLocal.rows[0]!.count).toBe(0);

      const completed = await finalizeErasure(generationId);
      // Not a flat `deletion_completed`: two listings are still live on eBay,
      // and SnapList must not report deleting a record eBay owns.
      expect(completed).toMatchObject({
        status: "deletion_completed_with_retained_records",
        retained_records: ["ebay-live-listing"],
      });
      // Erasure ends no listing. Nothing was sent to eBay at any point.
      expect(adapter.requests).toHaveLength(0);
      expect(adapter.reviseRequests).toHaveLength(0);
    } finally {
      const ownedObjects = await database.query<{ bucket_id: string; name: string }>(
        `select bucket_id, name from storage.objects
         where bucket_id in ('photos', 'message-photos')
           and split_part(name, '/', 1) = $1`,
        [publishOwnerId],
      );
      for (const bucketId of ["photos", "message-photos"]) {
        const names = ownedObjects.rows
          .filter((row) => row.bucket_id === bucketId)
          .map((row) => row.name);
        if (names.length > 0) await admin.storage.from(bucketId).remove(names);
      }
      await cleanupClerkTestUsers(admin, [publishOwnerId]);
      if (generationId) {
        await database.query(
          "delete from private.account_erasure_generations where generation_id = $1",
          [generationId],
        );
      }
    }
  });

  it("reconciles an active credit and removes exact live and archived queue identities", async () => {

    const creditOwnerId = `user_test_account_erasure_credit_${Date.now()}`;
    const creditForeignId = `user_test_account_erasure_credit_foreign_${Date.now()}`;
    let generationId = "";
    let ownerMessageId = "";
    let foreignMessageId = "";
    let foreignAllowancePeriodId = "";

    try {
      const [ownerRun, foreignRun] = await Promise.all([
        stageCreditedRun(creditOwnerId),
        stageCreditedRun(creditForeignId),
      ]);
      ownerMessageId = ownerRun.queueMessageId;
      foreignMessageId = foreignRun.queueMessageId;
      foreignAllowancePeriodId = foreignRun.allowancePeriodId;
      await database.query(
        `insert into pgmq.a_pipeline_jobs
           (msg_id, read_ct, enqueued_at, archived_at, vt, message, headers)
         select msg_id, read_ct, enqueued_at, statement_timestamp(), vt, message, headers
         from pgmq.q_pipeline_jobs where msg_id = $1`,
        [ownerMessageId],
      );
      const foreignBefore = await database.query<{ state: unknown }>(
        `select jsonb_build_object(
           'run', (select to_jsonb(run) from public.pipeline_runs run where run.id = $1),
           'reservation', (select to_jsonb(reservation) from public.ai_item_credit_reservations reservation where reservation.pipeline_run_id = $1),
           'period', (select to_jsonb(period) from public.ai_item_allowance_periods period where period.user_id = $2),
           'queue', (select to_jsonb(message) from pgmq.q_pipeline_jobs message where message.msg_id = $3)
         ) state`,
        [foreignRun.runId, creditForeignId, foreignMessageId],
      );

      const startedResult = await admin.rpc("begin_account_erasure", {
        p_idempotency_key: crypto.randomUUID(),
        p_user_id: creditOwnerId,
      });
      expect(startedResult.error).toBeNull();
      generationId = erasurePayload(startedResult.data).generation_id;
      console.info("account-erasure credit fixture", JSON.stringify({
        creditOwnerId,
        creditForeignId,
        generationId,
        ownerRunId: ownerRun.runId,
        ownerMessageId,
        ownerAllowancePeriodId: ownerRun.allowancePeriodId,
        foreignRunId: foreignRun.runId,
        foreignMessageId,
        foreignAllowancePeriodId,
      }));

      const advanced = await advanceErasure(generationId);
      expect(advanced.deferrals).toEqual([]);
      const completed = await finalizeErasure(generationId);
      expect(completed.status).toBe("deletion_completed");

      const ownerResidue = await database.query<{ count: number }>(
        `select (
           (select count(*) from public.pipeline_runs where user_id = $1)
           + (select count(*) from public.ai_item_credit_reservations where user_id = $1)
           + (select count(*) from public.ai_item_allowance_periods where user_id = $1)
           + (select count(*) from pgmq.q_pipeline_jobs where msg_id = $2)
           + (select count(*) from pgmq.a_pipeline_jobs where msg_id = $2)
         )::integer count`,
        [creditOwnerId, ownerMessageId],
      );
      expect(ownerResidue.rows[0]!.count).toBe(0);

      const foreignAfter = await database.query<{ state: unknown }>(
        `select jsonb_build_object(
           'run', (select to_jsonb(run) from public.pipeline_runs run where run.id = $1),
           'reservation', (select to_jsonb(reservation) from public.ai_item_credit_reservations reservation where reservation.pipeline_run_id = $1),
           'period', (select to_jsonb(period) from public.ai_item_allowance_periods period where period.user_id = $2),
           'queue', (select to_jsonb(message) from pgmq.q_pipeline_jobs message where message.msg_id = $3)
         ) state`,
        [foreignRun.runId, creditForeignId, foreignMessageId],
      );
      expect(foreignAfter.rows[0]!.state).toEqual(foreignBefore.rows[0]!.state);
    } finally {
      for (const messageId of [ownerMessageId, foreignMessageId].filter(Boolean)) {
        await admin.rpc("ack_pipeline_message", { p_message_id: messageId });
        await database.query("delete from pgmq.a_pipeline_jobs where msg_id = $1", [messageId]);
      }
      await cleanupClerkTestUsers(admin, [creditOwnerId, creditForeignId]);
      if (foreignAllowancePeriodId) {
        await database.query(
          `delete from public.ai_item_allowance_periods
           where id = $1
             and user_id = $2
             and source = 'included'
             and period_key = 'included-first-run'`,
          [foreignAllowancePeriodId, creditForeignId],
        );
      }
      if (generationId) {
        await database.query(
          "delete from private.account_erasure_generations where generation_id = $1",
          [generationId],
        );
      }
    }
  });

  it("refuses to create an erasure generation until a pre-existing guest copy is released", async () => {

    const targetUserId = `user_test_account_erasure_preclaim_${Date.now()}`;
    const guestUserId = `guest_test_account_erasure_preclaim_${Date.now()}`;
    const recoveryId = crypto.randomUUID();
    const claimKey = crypto.randomUUID();
    const erasureKey = crypto.randomUUID();
    let claimLeaseToken = "";
    let generationId = "";

    try {
      await database.query(
        `insert into private.guest_draft_recoveries (
           id, guest_user_id, pipeline_run_id, item_id, draft_id,
           reservation_id, allowance_period_id, recovery_token_hash,
           encrypted_artifact, storage_manifest, storage_object_count,
           usable_draft_at, expires_at
         ) values (
           $1, $2, $3, $4, $5, $6, $7, $8,
           '{}'::jsonb, '[{}]'::jsonb, 1,
           statement_timestamp(), statement_timestamp() + interval '24 hours'
         )`,
        [
          recoveryId,
          guestUserId,
          crypto.randomUUID(),
          crypto.randomUUID(),
          crypto.randomUUID(),
          crypto.randomUUID(),
          crypto.randomUUID(),
          "c".repeat(64),
        ],
      );
      const claim = await admin.rpc("begin_guest_draft_claim", {
        p_claim_lease_seconds: 300,
        p_guest_user_id: guestUserId,
        p_idempotency_key: claimKey,
        p_recovery_id: recoveryId,
        p_recovery_token_hash: "c".repeat(64),
        p_target_user_id: targetUserId,
      });
      expect(claim.error).toBeNull();
      const claimPayload = claim.data as { outcome?: unknown; claimLeaseToken?: unknown };
      expect(claimPayload.outcome).toBe("copy_required");
      expect(typeof claimPayload.claimLeaseToken).toBe("string");
      claimLeaseToken = claimPayload.claimLeaseToken as string;
      console.info("account-erasure pre-existing guest claim fixture", JSON.stringify({
        targetUserId,
        guestUserId,
        recoveryId,
        claimKey,
        claimLeaseToken,
        erasureKey,
      }));

      const blockedStart = await admin.rpc("begin_account_erasure", {
        p_idempotency_key: erasureKey,
        p_user_id: targetUserId,
      });
      expect(blockedStart.error?.message).toMatch(/guest claim must settle/i);
      const generationsBeforeRelease = await database.query<{ count: number }>(
        "select count(*)::integer count from private.account_erasure_generations where user_id = $1",
        [targetUserId],
      );
      expect(generationsBeforeRelease.rows[0]!.count).toBe(0);

      const released = await admin.rpc("release_guest_draft_claim", {
        p_claim_lease_token: claimLeaseToken,
        p_recovery_id: recoveryId,
        p_recovery_token_hash: "c".repeat(64),
        p_target_user_id: targetUserId,
      });
      expect(released.error).toBeNull();
      expect(released.data).toMatchObject({ outcome: "released" });

      const started = await admin.rpc("begin_account_erasure", {
        p_idempotency_key: erasureKey,
        p_user_id: targetUserId,
      });
      expect(started.error).toBeNull();
      generationId = erasurePayload(started.data).generation_id;
      const advanced = await advanceErasure(generationId);
      expect(advanced.deferrals).toEqual([]);
      const completed = await finalizeErasure(generationId);
      expect(completed.status).toBe("deletion_completed");
    } finally {
      if (claimLeaseToken) {
        await database.query(
          "delete from private.pipeline_storage_cleanup_jobs where source_type = 'guest_claim_copy' and source_id = $1",
          [claimLeaseToken],
        );
      }
      await database.query(
        "delete from private.guest_draft_recoveries where id = $1",
        [recoveryId],
      );
      if (generationId) {
        await database.query(
          "delete from private.account_erasure_generations where generation_id = $1",
          [generationId],
        );
      }
    }
  });

  it("rejects a guest claim before binding or copying into an erasing tenant", async () => {

    const targetUserId = `user_test_account_erasure_claim_${Date.now()}`;
    const guestUserId = `guest_test_account_erasure_claim_${Date.now()}`;
    const recoveryId = crypto.randomUUID();
    let generationId = "";

    try {
      const started = await admin.rpc("begin_account_erasure", {
        p_idempotency_key: crypto.randomUUID(),
        p_user_id: targetUserId,
      });
      expect(started.error).toBeNull();
      generationId = erasurePayload(started.data).generation_id;
      await database.query(
        `insert into private.guest_draft_recoveries (
           id, guest_user_id, pipeline_run_id, item_id, draft_id,
           reservation_id, allowance_period_id, recovery_token_hash,
           encrypted_artifact, storage_manifest, storage_object_count,
           usable_draft_at, expires_at
         ) values (
           $1, $2, $3, $4, $5, $6, $7, $8,
           '{}'::jsonb, '[{}]'::jsonb, 1,
           statement_timestamp(), statement_timestamp() + interval '24 hours'
         )`,
        [
          recoveryId,
          guestUserId,
          crypto.randomUUID(),
          crypto.randomUUID(),
          crypto.randomUUID(),
          crypto.randomUUID(),
          crypto.randomUUID(),
          "b".repeat(64),
        ],
      );
      console.info("account-erasure claim fixture", JSON.stringify({
        targetUserId,
        guestUserId,
        recoveryId,
        generationId,
      }));

      const claim = await admin.rpc("begin_guest_draft_claim", {
        p_claim_lease_seconds: 300,
        p_guest_user_id: guestUserId,
        p_idempotency_key: crypto.randomUUID(),
        p_recovery_id: recoveryId,
        p_recovery_token_hash: "b".repeat(64),
        p_target_user_id: targetUserId,
      });
      expect(claim.error?.message).toBe("Account erasure has started for this account");
      const recovery = await database.query<{
        state: string;
        claim_idempotency_user_id: string | null;
        claim_target_user_id: string | null;
      }>(
        `select state, claim_idempotency_user_id, claim_target_user_id
         from private.guest_draft_recoveries where id = $1`,
        [recoveryId],
      );
      expect(recovery.rows[0]).toEqual({
        state: "claimable",
        claim_idempotency_user_id: null,
        claim_target_user_id: null,
      });

      const advanced = await advanceErasure(generationId);
      expect(advanced.deferrals).toEqual([]);
      const completed = await finalizeErasure(generationId);
      expect(completed.status).toBe("deletion_completed");
    } finally {
      if (generationId) {
        await database.query(
          "delete from private.account_erasure_generations where generation_id = $1",
          [generationId],
        );
      }
      await database.query(
        "delete from private.guest_draft_recoveries where id = $1",
        [recoveryId],
      );
    }
  });
});
