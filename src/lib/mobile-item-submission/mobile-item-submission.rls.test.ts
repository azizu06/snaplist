import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  acquireExclusiveTestResource,
  type ExclusiveTestResourceLease,
} from "@/test/exclusive-resource-lock";
import {
  cleanupClerkTestUsers,
  grantIncludedOfferDeviceClaim,
  mintUserJwt,
} from "@/lib/supabase/test-users";
import { canonicalizeVerifiedPhotoSet } from "@/lib/photo-identity/photo-set";
import { prepareMobileItemSubmission } from "./contract";
import { createMobileItemSubmissionHandler } from "./http";
import { createMobileItemSubmissionOperations } from "./service";
import { createSupabaseMobileItemSubmissionStaging } from "./store";
import { runPipelineMaintenance } from "@/lib/pipeline-operations/maintenance";
import { createSupabasePipelineOperationsStore } from "@/lib/pipeline-operations/store";
import { createDurableVisionPipelineProcessor } from "@/lib/pipeline-queue/durable-processor";
import { createSupabasePipelineWorkerStore } from "@/lib/pipeline-queue/worker-store";
import type { CanonicalLanguageTag } from "@/lib/llm/seller-context";
import type { VisionPipelineStages } from "@/lib/vision";
import {
  DATABASE_URL,
  PUBLISHABLE_KEY,
  SECRET_KEY,
  SUPABASE_URL,
  connectDatabase,
  fixedWavBytes,
  fiveJpegs,
  fivePhotoMultipart,
  jpeg,
  multipart,
  request,
} from "./rls-test-fixture";
import { skipIfStackUnreachable, stackReachable, whenStackReachable } from "@/test/supabase-stack";

vi.mock("server-only", () => ({}));

let reachable = false;
let database: Client;
let admin: SupabaseClient;
let lease: ExclusiveTestResourceLease;
let ownerId = "";
let foreignId = "";
let recoveryId = "";
let abandonedId = "";
let preparationFirstId = "";
let replayFirstId = "";
let concurrentId = "";
let legacyReplayId = "";
let voiceJourneyId = "";
let ownerToken = "";
let foreignToken = "";
let recoveryToken = "";
let abandonedToken = "";
let preparationFirstToken = "";
let replayFirstToken = "";
let concurrentToken = "";
let legacyReplayToken = "";
let voiceJourneyToken = "";
let itemId = "";
let runId = "";
let queueMessageId = "";
let storagePaths: string[] = [];

beforeEach((context) => {
  skipIfStackUnreachable(context, reachable);
});

async function assumeServiceRole(client: Client): Promise<void> {
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ role: "service_role" }),
  ]);
  await client.query("set local role service_role");
}

interface ExpiredUploadingSubmission {
  key: string;
  batchId: string;
  cleanupId: string;
  costBasis: string;
  photoReceipts: Array<{ storage_path: string }>;
  requestFingerprint: string;
}

interface AcceptedVoiceSubmission {
  itemId: string;
  runId: string;
  queueMessageId: string;
}

async function createAcceptedVoiceSubmission(
  userId: string,
  token: string,
): Promise<AcceptedVoiceSubmission> {
  const { createConfiguredMobileItemSubmissionOperations } = await import("./configured");
  const submitter = createConfiguredMobileItemSubmissionOperations({
    supabaseURL: SUPABASE_URL,
    publishableKey: PUBLISHABLE_KEY!,
    secretKey: SECRET_KEY!,
  });
  const handler = createMobileItemSubmissionHandler({
    requestId: () => crypto.randomUUID(),
    itemSubmission: {
      async resolvePrincipal(bearerToken) {
        if (bearerToken !== token) throw new Error("invalid test principal");
        return { kind: "clerk", userId, bearerToken };
      },
      submit: (input) => submitter.submit(input),
    },
  });
  const response = await handler(request(
    token,
    crypto.randomUUID(),
    fivePhotoMultipart("12.50", [0, 1, 2, 3, 4], null, {
      bytes: fixedWavBytes(774),
      locale: "en-US",
    }),
  ));
  expect(response.status).toBe(202);
  const envelope = await response.json();
  const authority = await database.query<{ queue_message_id: string }>(
    `select run.queue_message_id::text
     from public.pipeline_runs run
     where run.id = $1::uuid
       and run.item_id = $2::uuid
       and run.user_id = $3`,
    [envelope.data.runId, envelope.data.itemId, userId],
  );
  expect(authority.rows).toHaveLength(1);
  return {
    itemId: envelope.data.itemId,
    runId: envelope.data.runId,
    queueMessageId: authority.rows[0]!.queue_message_id,
  };
}

async function createExpiredUploadingSubmission(
  userId: string,
  token: string,
): Promise<ExpiredUploadingSubmission> {
  const staging = createSupabaseMobileItemSubmissionStaging(admin);
  const tenant = createClient(SUPABASE_URL, PUBLISHABLE_KEY!, {
    accessToken: async () => token,
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const bucket = tenant.storage.from("photos");
  const submitter = createMobileItemSubmissionOperations({
    async resolvePrincipal(bearerToken) {
      return { kind: "clerk", userId, bearerToken };
    },
    limits: { dailyLimit: 0, perMinuteLimit: 20 },
    staging,
    storageFor: () => ({
      async upload(path, bytes, mediaType) {
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
  const handler = createMobileItemSubmissionHandler({
    requestId: () => crypto.randomUUID(),
    itemSubmission: submitter,
  });
  const key = crypto.randomUUID();

  expect((await handler(request(token, key, multipart()))).status).toBe(503);
  const expired = await database.query<{
    batch_id: string;
    cleanup_id: string;
    cost_basis: string;
    photo_receipts: Array<{ storage_path: string }>;
    request_fingerprint: string;
  }>(
    `update private.pipeline_staging_cleanup_intents intent
     set created_at = statement_timestamp() - interval '25 hours',
         cleanup_after = statement_timestamp() - interval '1 hour'
     from private.mobile_item_submissions submission
     where submission.user_id = $1
       and submission.idempotency_key = $2::uuid
       and intent.cleanup_id = submission.cleanup_id
     returning submission.batch_id,
       submission.cleanup_id,
       submission.cost_basis::text,
       submission.photo_receipts,
       submission.request_fingerprint`,
    [userId, key],
  );
  const bound = expired.rows[0]!;
  return {
    key,
    batchId: bound.batch_id,
    cleanupId: bound.cleanup_id,
    costBasis: bound.cost_basis,
    photoReceipts: bound.photo_receipts,
    requestFingerprint: bound.request_fingerprint,
  };
}

async function beginExactReplay(
  client: Client,
  userId: string,
  submission: ExpiredUploadingSubmission,
): Promise<boolean> {
  const result = await client.query<{ began: boolean }>(
    `select public.begin_mobile_item_submission_v3(
       $1::text,
       $2::uuid,
       $3::text,
       null::text,
       $4::uuid,
       $5::uuid,
       $6::numeric,
       $7::jsonb,
       null::jsonb,
       null::uuid,
       null::text
     ) as began`,
    [
      userId,
      submission.key,
      submission.requestFingerprint,
      submission.batchId,
      submission.cleanupId,
      submission.costBasis,
      JSON.stringify(submission.photoReceipts),
    ],
  );
  return result.rows[0]!.began;
}

async function waitForDatabaseBlock(
  observer: Client,
  waitingPid: number,
  blockingPid: number,
  requiredLockType?: "advisory",
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{
      blockers: number[];
      waiting_on_required_lock: boolean;
    }>(
      `select
         pg_blocking_pids($1) as blockers,
         $2::text is null or exists (
           select 1
           from pg_locks lock
           where lock.pid = $1
             and lock.locktype = $2
             and not lock.granted
         ) as waiting_on_required_lock`,
      [waitingPid, requiredLockType ?? null],
    );
    const row = result.rows[0]!;
    if (row.blockers.includes(blockingPid) && row.waiting_on_required_lock) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Backend ${waitingPid} never waited on ${requiredLockType ?? "a database lock"} behind ${blockingPid}`,
  );
}

async function waitForPipelineRunFence(
  observer: Client,
  waitingPid: number,
  blockingPid: number,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{
      blockers: number[];
      has_pipeline_runs_lock: boolean;
    }>(
      `select
         pg_blocking_pids(activity.pid) as blockers,
         exists (
           select 1
           from pg_locks lock
           where lock.pid = activity.pid
             and lock.locktype = 'relation'
             and lock.relation = 'public.pipeline_runs'::regclass
             and lock.mode = 'RowShareLock'
             and lock.granted
         ) as has_pipeline_runs_lock
       from pg_stat_activity activity
       where activity.pid = $1`,
      [waitingPid],
    );
    const row = result.rows[0];
    if (
      row?.blockers.includes(blockingPid)
      && row.has_pipeline_runs_lock
    ) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Backend ${waitingPid} never queued behind ${blockingPid} on the pipeline run fence`,
  );
}

async function readContentSafeProviderUsage(
  observer: Client,
  runId: string,
) {
  return observer.query<{
    model_calls: number;
    transcription_count: number;
    transcription_role: string | null;
    transcription_provider: string | null;
    transcription_model: string | null;
    transcription_calls: string | null;
    charged_usd_unknown: boolean;
    only_allowed_transcription_fields: boolean;
  }>(
    `select
       usage.model_calls,
       jsonb_array_length(usage.transcriptions)::integer transcription_count,
       usage.transcriptions->0->>'role' transcription_role,
       usage.transcriptions->0->>'provider' transcription_provider,
       usage.transcriptions->0->>'model' transcription_model,
       usage.transcriptions->0->>'calls' transcription_calls,
       jsonb_typeof(usage.transcriptions->0->'chargedUsd') = 'null'
         charged_usd_unknown,
       (usage.transcriptions->0) - array[
         'role', 'provider', 'model', 'calls', 'chargedUsd'
       ] = '{}'::jsonb only_allowed_transcription_fields
     from public.pipeline_run_provider_usage usage
     where usage.run_id = $1::uuid`,
    [runId],
  );
}

async function waitForGrantedAdvisory(
  observer: Client,
  holderPid: number,
  boundary: string,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ holds_boundary: boolean }>(
      `select exists (
         select 1
         from pg_locks lock
         where lock.pid = $1
           and lock.locktype = 'advisory'
           and lock.granted
           and (
             lock.classid::bigint::bit(32)
               || lock.objid::bigint::bit(32)
           ) = hashtextextended($2, 0)::bit(64)
       ) as holds_boundary`,
      [holderPid, boundary],
    );
    if (result.rows[0]!.holds_boundary) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Backend ${holderPid} never held the expected advisory boundary`);
}

async function waitForCleanupFence(
  observer: Client,
  replayPid: number,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{
      blockers: number[];
      waiting_on_advisory: boolean;
    }>(
      `select
         pg_blocking_pids(activity.pid) as blockers,
         exists (
           select 1
           from pg_locks lock
           where lock.pid = activity.pid
             and lock.locktype = 'advisory'
             and not lock.granted
         ) as waiting_on_advisory
       from pg_stat_activity activity
       where activity.pid <> pg_backend_pid()
         and activity.query ilike '%authorize_pipeline_storage_cleanup%'
       order by activity.query_start desc`,
    );
    if (result.rows.some((row) => (
      row.waiting_on_advisory && row.blockers.includes(replayPid)
    ))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Claimed cleanup never blocked at the mobile submission fence");
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
  ownerId = `user_test_mobile_submit_owner_${Date.now()}`;
  foreignId = `user_test_mobile_submit_foreign_${Date.now()}`;
  recoveryId = `user_test_mobile_submit_recovery_${Date.now()}`;
  abandonedId = `user_test_mobile_submit_abandoned_${Date.now()}`;
  preparationFirstId = `user_test_mobile_submit_prepare_first_${Date.now()}`;
  replayFirstId = `user_test_mobile_submit_replay_first_${Date.now()}`;
  concurrentId = `user_test_mobile_submit_concurrent_${Date.now()}`;
  legacyReplayId = `user_test_mobile_submit_legacy_replay_${Date.now()}`;
  voiceJourneyId = `user_test_mobile_submit_voice_journey_${Date.now()}`;
  [
    ownerToken,
    foreignToken,
    recoveryToken,
    abandonedToken,
    preparationFirstToken,
    replayFirstToken,
    concurrentToken,
    legacyReplayToken,
    voiceJourneyToken,
  ] = await Promise.all([
    mintUserJwt(ownerId),
    mintUserJwt(foreignId),
    mintUserJwt(recoveryId),
    mintUserJwt(abandonedId),
    mintUserJwt(preparationFirstId),
    mintUserJwt(replayFirstId),
    mintUserJwt(concurrentId),
    mintUserJwt(legacyReplayId),
    mintUserJwt(voiceJourneyId),
  ]);
  await Promise.all(
    [
      ownerId,
      foreignId,
      recoveryId,
      abandonedId,
      preparationFirstId,
      replayFirstId,
      concurrentId,
      legacyReplayId,
      voiceJourneyId,
    ].map((userId) => grantIncludedOfferDeviceClaim(admin, userId)),
  );
  });
});

afterAll(async () => {
  await whenStackReachable(reachable, async () => {
  const residue = await database.query<{ queue_message_id: string | null; storage_path: string | null }>(
    `select run.queue_message_id::text queue_message_id, null::text storage_path
     from public.pipeline_runs run where run.user_id = any($1::text[])
     union all
     select null::text, object.name
     from storage.objects object
     where object.bucket_id = 'photos'
       and split_part(object.name, '/', 1) = any($1::text[])`,
    [[
      ownerId,
      foreignId,
      recoveryId,
      abandonedId,
      preparationFirstId,
      replayFirstId,
      concurrentId,
      legacyReplayId,
      voiceJourneyId,
    ]],
  );
  const messageIds = new Set([
    ...residue.rows.flatMap((row) => row.queue_message_id ? [row.queue_message_id] : []),
    ...(queueMessageId ? [queueMessageId] : []),
  ]);
  const paths = new Set([
    ...residue.rows.flatMap((row) => row.storage_path ? [row.storage_path] : []),
    ...storagePaths,
  ]);
  await Promise.all(
    [...messageIds].map((messageId) =>
      admin.rpc("ack_pipeline_message", { p_message_id: messageId }),
    ),
  );
  if (paths.size > 0) await admin.storage.from("photos").remove([...paths]);
  const testUserIds = [
    ownerId,
    foreignId,
    recoveryId,
    abandonedId,
    preparationFirstId,
    replayFirstId,
    concurrentId,
    legacyReplayId,
    voiceJourneyId,
  ];
  await cleanupClerkTestUsers(admin, testUserIds);
  await database.query(
    `delete from private.pipeline_storage_cleanup_jobs job
     using private.mobile_item_submission_voice_handoffs handoff
     where job.source_type = 'raw_voice'
       and job.source_id = handoff.cleanup_id
       and handoff.user_id = any($1::text[])`,
    [testUserIds],
  );
  await database.query(
    `delete from private.mobile_item_submission_voice_handoffs
     where user_id = any($1::text[])`,
    [testUserIds],
  );
  await database.query(
    `delete from private.pipeline_staging_cleanup_intents
     where user_id = any($1::text[])`,
    [testUserIds],
  );
  await database.query(
    `delete from private.mobile_item_submissions
     where user_id = any($1::text[])`,
    [testUserIds],
  );
  await database.end();
  await lease.release();
  });
});

describe("authenticated mobile item submission against local Supabase", () => {
  it("supersedes cleanup published by preparation that serialized before replay", async () => {
    const submission = await createExpiredUploadingSubmission(
      preparationFirstId,
      preparationFirstToken,
    );
    const gate = await connectDatabase("issue-346-preparation-gate");
    const preparer = await connectDatabase("issue-346-preparation-first");
    const replay = await connectDatabase("issue-346-preparation-first-replay");
    let gateReleased = false;
    let preparationPromise: Promise<{
      rows: Array<{ prepared: { storageJobsQueued: number } }>;
    }> | undefined;
    let replayPromise: Promise<boolean> | undefined;

    try {
      await gate.query("begin");
      const gatePid = (
        await gate.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]!.pid;
      await gate.query(
        `insert into private.pipeline_storage_cleanup_jobs (
           source_type,
           source_id,
           photo_paths
         ) values ('staging', $1::uuid, $2::text[])`,
        [
          submission.cleanupId,
          submission.photoReceipts.map((receipt) => receipt.storage_path),
        ],
      );

      await preparer.query("begin");
      await assumeServiceRole(preparer);
      const preparerPid = (
        await preparer.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]!.pid;
      preparationPromise = preparer.query<{
        prepared: { storageJobsQueued: number };
      }>("select public.prepare_pipeline_retention(100) as prepared");
      void preparationPromise.catch(() => undefined);
      await waitForDatabaseBlock(database, preparerPid, gatePid);
      await waitForGrantedAdvisory(
        database,
        preparerPid,
        `mobile-item-submission:${preparationFirstId}:${submission.key}`,
      );

      await replay.query("begin");
      await assumeServiceRole(replay);
      const replayPid = (
        await replay.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]!.pid;
      replayPromise = beginExactReplay(replay, preparationFirstId, submission);
      void replayPromise.catch(() => undefined);
      await waitForDatabaseBlock(database, replayPid, preparerPid, "advisory");

      await gate.query("rollback");
      gateReleased = true;
      const prepared = await preparationPromise;
      expect(prepared.rows[0]!.prepared.storageJobsQueued).toBe(1);
      await preparer.query("commit");
      await expect(replayPromise).resolves.toBe(false);
      await replay.query("commit");

      const authority = await database.query<{
        cleanup_generation: number;
        cleanup_jobs: number;
        cleanup_renewed: boolean;
      }>(
        `select
           submission.cleanup_generation::integer,
           (select count(*)::integer
            from private.pipeline_storage_cleanup_jobs job
            where job.source_type = 'staging'
              and job.source_id = submission.cleanup_id) cleanup_jobs,
           exists (
             select 1
             from private.pipeline_staging_cleanup_intents intent
             where intent.cleanup_id = submission.cleanup_id
               and intent.cleanup_after > statement_timestamp()
           ) cleanup_renewed
         from private.mobile_item_submissions submission
         where submission.user_id = $1
           and submission.idempotency_key = $2::uuid`,
        [preparationFirstId, submission.key],
      );
      expect(authority.rows[0]).toEqual({
        cleanup_generation: 2,
        cleanup_jobs: 0,
        cleanup_renewed: true,
      });

      const removedPaths: string[][] = [];
      const cleanupStore = createSupabasePipelineOperationsStore({
        async rpc(functionName, args) {
          const { data, error } = await admin.rpc(functionName, args);
          return { data, error: error ? { message: error.message } : null };
        },
      });
      const cleanup = await runPipelineMaintenance({
        store: cleanupStore,
        storage: {
          async remove(paths) {
            removedPaths.push(paths);
          },
          // Photo cleanup jobs never take the raw seller voice path, so the
          // absence proof is not exercised here.
          async confirmAbsent() {},
        },
      });
      expect(cleanup).toMatchObject({ claimedStorageJobs: 0, deletedObjects: 0 });
      expect(removedPaths).toEqual([]);
      for (const { storage_path: path } of submission.photoReceipts) {
        const preserved = await admin.storage.from("photos").download(path);
        expect(preserved.error).toBeNull();
      }
    } finally {
      if (!gateReleased) await gate.query("rollback").catch(() => undefined);
      const preparationRollback = preparer.query("rollback").catch(() => undefined);
      const replayRollback = replay.query("rollback").catch(() => undefined);
      await Promise.allSettled([
        preparationPromise,
        replayPromise,
        preparationRollback,
        replayRollback,
      ]);
      await Promise.all([gate.end(), preparer.end(), replay.end()]);
    }
  });

  it("makes preparation recheck authority when replay serialized first", async () => {
    const submission = await createExpiredUploadingSubmission(
      replayFirstId,
      replayFirstToken,
    );
    const replay = await connectDatabase("issue-346-replay-first");
    const preparer = await connectDatabase("issue-346-replay-first-preparation");
    let preparationPromise: Promise<{
      rows: Array<{ prepared: { storageJobsQueued: number } }>;
    }> | undefined;

    try {
      await replay.query("begin");
      await assumeServiceRole(replay);
      const replayPid = (
        await replay.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]!.pid;
      await expect(
        beginExactReplay(replay, replayFirstId, submission),
      ).resolves.toBe(false);

      await preparer.query("begin");
      await assumeServiceRole(preparer);
      const preparerPid = (
        await preparer.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]!.pid;
      preparationPromise = preparer.query<{
        prepared: { storageJobsQueued: number };
      }>("select public.prepare_pipeline_retention(100) as prepared");
      void preparationPromise.catch(() => undefined);
      await waitForDatabaseBlock(database, preparerPid, replayPid, "advisory");

      await replay.query("commit");
      const prepared = await preparationPromise;
      expect(prepared.rows[0]!.prepared.storageJobsQueued).toBe(0);
      await preparer.query("commit");

      const authority = await database.query<{
        cleanup_generation: number;
        cleanup_jobs: number;
        cleanup_renewed: boolean;
      }>(
        `select
           submission.cleanup_generation::integer,
           (select count(*)::integer
            from private.pipeline_storage_cleanup_jobs job
            where job.source_type = 'staging'
              and job.source_id = submission.cleanup_id) cleanup_jobs,
           exists (
             select 1
             from private.pipeline_staging_cleanup_intents intent
             where intent.cleanup_id = submission.cleanup_id
               and intent.cleanup_after > statement_timestamp()
           ) cleanup_renewed
         from private.mobile_item_submissions submission
         where submission.user_id = $1
           and submission.idempotency_key = $2::uuid`,
        [replayFirstId, submission.key],
      );
      expect(authority.rows[0]).toEqual({
        cleanup_generation: 1,
        cleanup_jobs: 0,
        cleanup_renewed: true,
      });
      for (const { storage_path: path } of submission.photoReceipts) {
        const preserved = await admin.storage.from("photos").download(path);
        expect(preserved.error).toBeNull();
      }
    } finally {
      const replayRollback = replay.query("rollback").catch(() => undefined);
      const preparationRollback = preparer.query("rollback").catch(() => undefined);
      await Promise.allSettled([
        preparationPromise,
        replayRollback,
        preparationRollback,
      ]);
      await Promise.all([replay.end(), preparer.end()]);
    }
  });

  it("fences a claimed stale cleanup job when the exact submission resumes", async () => {
    const staging = createSupabaseMobileItemSubmissionStaging(admin);
    const tenant = createClient(SUPABASE_URL, PUBLISHABLE_KEY!, {
      accessToken: async () => recoveryToken,
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const bucket = tenant.storage.from("photos");
    const failingSubmitter = createMobileItemSubmissionOperations({
      async resolvePrincipal(token) {
        return { kind: "clerk", userId: recoveryId, bearerToken: token };
      },
      limits: { dailyLimit: 0, perMinuteLimit: 20 },
      staging,
      storageFor: () => ({
        async upload(path, bytes, mediaType) {
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
    const failingHandler = createMobileItemSubmissionHandler({
      itemSubmission: failingSubmitter,
      requestId: () => crypto.randomUUID(),
    });
    const key = crypto.randomUUID();

    expect((await failingHandler(request(recoveryToken, key, multipart()))).status).toBe(503);
    const abandoned = await database.query<{
      uploading: number;
      committed: number;
      runs: number;
      credit_reservations: number;
      usage_reservations: number;
      queue_messages: number;
      cleanup_intents: number;
      objects: number;
    }>(
      `select
         (select count(*)::integer from private.mobile_item_submissions
          where user_id = $1 and idempotency_key = $2::uuid and state = 'uploading') uploading,
         (select count(*)::integer from private.mobile_item_submissions
          where user_id = $1 and idempotency_key = $2::uuid and state = 'committed') committed,
         (select count(*)::integer from public.pipeline_runs
          where user_id = $1 and idempotency_key = $2::text) runs,
         (select count(*)::integer from public.ai_item_credit_reservations reservation
          join public.pipeline_runs run on run.id = reservation.pipeline_run_id
          where run.user_id = $1 and run.idempotency_key = $2::text) credit_reservations,
         (select count(*)::integer from private.pipeline_run_usage_reservations usage
          join public.pipeline_runs run on run.id = usage.run_id
          where run.user_id = $1 and run.idempotency_key = $2::text) usage_reservations,
         (select count(*)::integer from pgmq.q_pipeline_jobs message
          join public.pipeline_runs run on run.queue_message_id = message.msg_id
          where run.user_id = $1 and run.idempotency_key = $2::text) queue_messages,
         (select count(*)::integer from private.pipeline_staging_cleanup_intents
          where user_id = $1 and batch_id = $2::uuid) cleanup_intents,
         (select count(*)::integer from storage.objects
          where bucket_id = 'photos' and split_part(name, '/', 1) = $1) objects`,
      [recoveryId, key],
    );
    expect(abandoned.rows[0]).toEqual({
      uploading: 1,
      committed: 0,
      runs: 0,
      credit_reservations: 0,
      usage_reservations: 0,
      queue_messages: 0,
      cleanup_intents: 1,
      objects: 2,
    });
    expect((await failingHandler(request(recoveryToken, key, multipart("13.00")))).status).toBe(409);

    const uploading = await database.query<{
      batch_id: string;
      cleanup_id: string;
      cost_basis: string;
      photo_receipts: Array<{ storage_path: string }>;
      request_fingerprint: string;
    }>(
      `update private.pipeline_staging_cleanup_intents intent
       set created_at = statement_timestamp() - interval '25 hours',
           cleanup_after = statement_timestamp() - interval '1 hour'
       from private.mobile_item_submissions submission
       where submission.user_id = $1
         and submission.idempotency_key = $2::uuid
         and intent.cleanup_id = submission.cleanup_id
       returning submission.batch_id,
         submission.cleanup_id,
         submission.cost_basis::text,
         submission.photo_receipts,
         submission.request_fingerprint`,
      [recoveryId, key],
    );
    const bound = uploading.rows[0]!;
    const cleanupStore = createSupabasePipelineOperationsStore({
      async rpc(functionName, args) {
        const { data, error } = await admin.rpc(functionName, args);
        return { data, error: error ? { message: error.message } : null };
      },
    });
    let releaseClaimedCleanup: () => void = () => {};
    let reportClaimedCleanup: () => void = () => {};
    const claimedCleanup = new Promise<void>((resolve) => {
      reportClaimedCleanup = resolve;
    });
    const holdClaimedCleanup = new Promise<void>((resolve) => {
      releaseClaimedCleanup = resolve;
    });
    const removedPaths: string[][] = [];
    const cleanup = runPipelineMaintenance({
      store: {
        ...cleanupStore,
        async claimStorageCleanup(leaseSeconds) {
          const claim = await cleanupStore.claimStorageCleanup(leaseSeconds);
          if (claim.kind === "claimed") {
            expect(claim.job.photoPaths).toEqual(
              bound.photo_receipts.map((receipt) => receipt.storage_path),
            );
            reportClaimedCleanup();
            await holdClaimedCleanup;
          }
          return claim;
        },
      },
      storage: {
        async remove(paths) {
          removedPaths.push(paths);
          const { error } = await admin.storage.from("photos").remove(paths);
          if (error) throw error;
        },
        // Photo cleanup jobs never take the raw seller voice path, so the
        // absence proof is not exercised here.
        async confirmAbsent() {},
      },
    });
    await claimedCleanup;

    const replay = await connectDatabase("issue-346-exact-replay");
    try {
      await replay.query("begin");
      await assumeServiceRole(replay);
      const replayPid = (
        await replay.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]!.pid;
      const resumed = await replay.query<{ began: boolean }>(
        `select public.begin_mobile_item_submission_v3(
           $1::text,
           $2::uuid,
           $3::text,
           null::text,
           $4::uuid,
           $5::uuid,
           $6::numeric,
           $7::jsonb,
           null::jsonb,
           null::uuid,
           null::text
         ) as began`,
        [
          recoveryId,
          key,
          bound.request_fingerprint,
          bound.batch_id,
          bound.cleanup_id,
          bound.cost_basis,
          JSON.stringify(bound.photo_receipts),
        ],
      );
      expect(resumed.rows[0]?.began).toBe(false);

      releaseClaimedCleanup();
      await waitForCleanupFence(database, replayPid);
      await replay.query("commit");
    } finally {
      releaseClaimedCleanup();
      await replay.query("rollback").catch(() => undefined);
      await replay.end();
    }

    await expect(cleanup).resolves.toMatchObject({
      claimedStorageJobs: 1,
      deletedObjects: 0,
      failedObjects: 0,
    });
    expect(removedPaths).toEqual([]);

    const { createConfiguredMobileItemSubmissionOperations } = await import("./configured");
    const recoverySubmitter = createConfiguredMobileItemSubmissionOperations({
      supabaseURL: SUPABASE_URL,
      publishableKey: PUBLISHABLE_KEY!,
      secretKey: SECRET_KEY!,
    });
    const recoveryHandler = createMobileItemSubmissionHandler({
      requestId: () => crypto.randomUUID(),
      itemSubmission: {
        async resolvePrincipal(token) {
          return { kind: "clerk", userId: recoveryId, bearerToken: token };
        },
        submit: recoverySubmitter.submit,
      },
    });
    const recovered = await recoveryHandler(request(recoveryToken, key, multipart()));
    expect(recovered.status).toBe(202);
    await expect(recovered.json()).resolves.toMatchObject({
      data: { runId: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    });
    for (const { storage_path: path } of bound.photo_receipts) {
      const preserved = await admin.storage.from("photos").download(path);
      expect(preserved.error).toBeNull();
    }
  });

  it("deletes an expired mobile upload when no exact replay resumes it", async () => {
    const staging = createSupabaseMobileItemSubmissionStaging(admin);
    const tenant = createClient(SUPABASE_URL, PUBLISHABLE_KEY!, {
      accessToken: async () => abandonedToken,
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const bucket = tenant.storage.from("photos");
    const submitter = createMobileItemSubmissionOperations({
      async resolvePrincipal(token) {
        return { kind: "clerk", userId: abandonedId, bearerToken: token };
      },
      limits: { dailyLimit: 0, perMinuteLimit: 20 },
      staging,
      storageFor: () => ({
        async upload(path, bytes, mediaType) {
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
    const handler = createMobileItemSubmissionHandler({
      requestId: () => crypto.randomUUID(),
      itemSubmission: submitter,
    });
    const key = crypto.randomUUID();

    expect((await handler(request(abandonedToken, key, multipart()))).status).toBe(503);
    const expired = await database.query<{
      photo_receipts: Array<{ storage_path: string }>;
    }>(
      `update private.pipeline_staging_cleanup_intents intent
       set created_at = statement_timestamp() - interval '25 hours',
           cleanup_after = statement_timestamp() - interval '1 hour'
       from private.mobile_item_submissions submission
       where submission.user_id = $1
         and submission.idempotency_key = $2::uuid
         and intent.cleanup_id = submission.cleanup_id
       returning submission.photo_receipts`,
      [abandonedId, key],
    );
    const paths = expired.rows[0]!.photo_receipts.map(
      (receipt) => receipt.storage_path,
    );
    const cleanupStore = createSupabasePipelineOperationsStore({
      async rpc(functionName, args) {
        const { data, error } = await admin.rpc(functionName, args);
        return { data, error: error ? { message: error.message } : null };
      },
    });
    const cleanup = await runPipelineMaintenance({
      store: cleanupStore,
      storage: {
        async remove(photoPaths) {
          const { error } = await admin.storage.from("photos").remove(photoPaths);
          if (error) throw error;
        },
        // Photo cleanup jobs never take the raw seller voice path, so the
        // absence proof is not exercised here.
        async confirmAbsent() {},
      },
    });

    expect(cleanup).toMatchObject({
      claimedStorageJobs: 1,
      deletedObjects: 2,
      failedObjects: 0,
    });
    for (const path of paths) {
      const removed = await admin.storage.from("photos").download(path);
      expect(removed.data).toBeNull();
      expect(removed.error).not.toBeNull();
    }
  });

  it("serializes competing five-photo order under one durable run", async () => {
    const { createConfiguredMobileItemSubmissionOperations } = await import("./configured");
    const submitter = createConfiguredMobileItemSubmissionOperations({
      supabaseURL: SUPABASE_URL,
      publishableKey: PUBLISHABLE_KEY!,
      secretKey: SECRET_KEY!,
    });
    const handler = createMobileItemSubmissionHandler({
      requestId: () => crypto.randomUUID(),
      itemSubmission: {
        async resolvePrincipal(token) {
          if (token !== concurrentToken) throw new Error("invalid test principal");
          return { kind: "clerk", userId: concurrentId, bearerToken: token };
        },
        submit: submitter.submit,
      },
    });
    const key = crypto.randomUUID();
    const orders = [[0, 1, 2, 3, 4], [4, 3, 2, 1, 0]];
    const responses = await Promise.all(orders.map((order) =>
      handler(request(concurrentToken, key, fivePhotoMultipart("12.50", order))),
    ));
    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);

    const acceptedIndex = responses.findIndex((response) => response.status === 202);
    const accepted = await responses[acceptedIndex]!.json();
    expect(accepted.data.photos.map((photo: { ordinal: number }) => photo.ordinal)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    const winningOrder = orders[acceptedIndex]!;
    const durable = await database.query<{
      item_id: string;
      run_id: string;
      items: number;
      runs: number;
      credit_reservations: number;
      usage_reservations: number;
      queue_messages: number;
      cleanup_intents: number;
      ledger_rows: number;
      storage_objects: number;
      photo_paths: string[];
    }>(
      `select
         submission.item_id::text,
         submission.run_id::text,
         (select count(*)::integer from public.items item where item.id = submission.item_id and item.user_id = submission.user_id) items,
         (select count(*)::integer from public.pipeline_runs run where run.id = submission.run_id and run.user_id = submission.user_id) runs,
         (select count(*)::integer from public.ai_item_credit_reservations reservation where reservation.pipeline_run_id = submission.run_id) credit_reservations,
         (select count(*)::integer from private.pipeline_run_usage_reservations reservation where reservation.run_id = submission.run_id) usage_reservations,
         (select count(*)::integer from pgmq.q_pipeline_jobs message where message.message->>'run_id' = submission.run_id::text) queue_messages,
         (select count(*)::integer from private.pipeline_staging_cleanup_intents intent where intent.user_id = submission.user_id) cleanup_intents,
         (select count(*)::integer from private.mobile_item_submissions ledger where ledger.user_id = submission.user_id and ledger.idempotency_key = submission.idempotency_key) ledger_rows,
         (select count(*)::integer from storage.objects object where object.bucket_id = 'photos' and split_part(object.name, '/', 1) = submission.user_id) storage_objects,
         (select item.photos from public.items item where item.id = submission.item_id) photo_paths
       from private.mobile_item_submissions submission
       where submission.user_id = $1 and submission.idempotency_key = $2::uuid`,
      [concurrentId, key],
    );
    expect(durable.rows).toHaveLength(1);
    expect(durable.rows[0]).toMatchObject({
      item_id: accepted.data.itemId,
      run_id: accepted.data.runId,
      items: 1,
      runs: 1,
      credit_reservations: 1,
      usage_reservations: 1,
      queue_messages: 1,
      cleanup_intents: 0,
      ledger_rows: 1,
      storage_objects: 5,
    });
    expect(durable.rows[0]!.photo_paths).toHaveLength(5);

    const tenant = createClient(SUPABASE_URL, PUBLISHABLE_KEY!, {
      accessToken: async () => concurrentToken,
      auth: { persistSession: false, autoRefreshToken: false },
    });
    for (const [ordinal, path] of durable.rows[0]!.photo_paths.entries()) {
      const stored = await tenant.storage.from("photos").download(path);
      expect(stored.error).toBeNull();
      expect(new Uint8Array(await stored.data!.arrayBuffer())).toEqual(
        fiveJpegs[winningOrder[ordinal]!],
      );
    }
  });

  it("replays one committed photo-only legacy binding through the current v3 public handler", async () => {
    const key = crypto.randomUUID();
    const prepared = await prepareMobileItemSubmission(multipart());
    expect(prepared.voice).toBeNull();
    expect(prepared.legacyRequestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const cleanupId = crypto.randomUUID();
    const photoReceipts = prepared.photos.map((photo) => ({
      ordinal: photo.ordinal,
      storage_path: [
        legacyReplayId,
        "pipeline-staging",
        key,
        "0",
        `${photo.ordinal}-${photo.contentSha256}.${
          photo.mediaType === "image/png" ? "png" : "jpg"
        }`,
      ].join("/"),
      content_sha256: photo.contentSha256,
      byte_length: photo.byteLength,
      media_type: photo.mediaType,
    }));
    const began = await admin.rpc("begin_mobile_item_submission_v3", {
      p_user_id: legacyReplayId,
      p_idempotency_key: key,
      p_request_fingerprint: prepared.legacyRequestFingerprint!,
      p_legacy_request_fingerprint: null,
      p_batch_id: key,
      p_cleanup_id: cleanupId,
      p_cost_basis: prepared.costBasis,
      p_photo_receipts: photoReceipts,
      p_voice_receipt: null,
      p_recovery_id: null,
      p_recovery_token_hash: null,
    });
    expect(began).toMatchObject({ data: true, error: null });

    const tenant = createClient(SUPABASE_URL, PUBLISHABLE_KEY!, {
      accessToken: async () => legacyReplayToken,
      auth: { persistSession: false, autoRefreshToken: false },
    });
    for (const [index, receipt] of photoReceipts.entries()) {
      const uploaded = await tenant.storage.from("photos").upload(
        receipt.storage_path,
        prepared.photos[index]!.bytes,
        {
          contentType: receipt.media_type,
          upsert: false,
        },
      );
      expect(uploaded.error).toBeNull();
    }

    const photoIdentity = canonicalizeVerifiedPhotoSet(
      prepared.photos.map((photo) => photo.contentSha256),
    );
    const commitThenLoseResponse = async (): Promise<never> => {
      const committed = await admin.rpc("commit_mobile_item_submission_v3", {
        p_user_id: legacyReplayId,
        p_idempotency_key: key,
        p_request_fingerprint: prepared.legacyRequestFingerprint!,
        p_legacy_request_fingerprint: null,
        p_batch_id: key,
        p_cleanup_id: cleanupId,
        p_cost_basis: prepared.costBasis,
        p_daily_limit: 15,
        p_per_minute_limit: 20,
        p_photo_identity: photoIdentity,
        p_photo_receipts: photoReceipts,
        p_voice_receipt: null,
        p_recovery_id: null,
        p_recovery_token_hash: null,
      });
      if (committed.error) throw committed.error;
      throw new Error("response lost after durable v1 commit");
    };
    await expect(commitThenLoseResponse()).rejects.toThrow(
      "response lost after durable v1 commit",
    );

    const { createConfiguredMobileItemSubmissionOperations } = await import("./configured");
    const submitter = createConfiguredMobileItemSubmissionOperations({
      supabaseURL: SUPABASE_URL,
      publishableKey: PUBLISHABLE_KEY!,
      secretKey: SECRET_KEY!,
    });
    const handler = createMobileItemSubmissionHandler({
      requestId: () => crypto.randomUUID(),
      itemSubmission: {
        async resolvePrincipal(token) {
          if (token !== legacyReplayToken) {
            throw new Error("invalid test principal");
          }
          return {
            kind: "clerk",
            userId: legacyReplayId,
            bearerToken: token,
          };
        },
        submit: submitter.submit,
      },
    });
    const replay = await handler(request(legacyReplayToken, key, multipart()));
    expect(replay.status).toBe(200);
    const envelope = await replay.json();
    expect(envelope.data.voiceContext).toBeNull();

    const durable = await database.query<{
      bound_key: string;
      item_id: string;
      run_id: string;
      request_fingerprint: string;
      items: number;
      runs: number;
      queue_messages: number;
      credit_reservations: number;
      usage_reservations: number;
      ledger_rows: number;
      storage_objects: number;
      storage_paths: string[];
      item_photo_paths: string[];
    }>(
      `select
         submission.idempotency_key::text bound_key,
         submission.item_id::text,
         submission.run_id::text,
         submission.request_fingerprint,
         (select count(*)::integer from public.items item
          where item.id = submission.item_id and item.user_id = submission.user_id) items,
         (select count(*)::integer from public.pipeline_runs run
          where run.id = submission.run_id and run.user_id = submission.user_id) runs,
         (select count(*)::integer from pgmq.q_pipeline_jobs message
          where message.message->>'run_id' = submission.run_id::text) queue_messages,
         (select count(*)::integer from public.ai_item_credit_reservations reservation
          where reservation.pipeline_run_id = submission.run_id) credit_reservations,
         (select count(*)::integer from private.pipeline_run_usage_reservations reservation
          where reservation.run_id = submission.run_id) usage_reservations,
         (select count(*)::integer from private.mobile_item_submissions ledger
          where ledger.user_id = submission.user_id
            and ledger.idempotency_key = submission.idempotency_key) ledger_rows,
         (select count(*)::integer from storage.objects object
          where object.bucket_id = 'photos'
            and split_part(object.name, '/', 1) = submission.user_id) storage_objects,
         (select array_agg(object.name order by object.name)
          from storage.objects object
          where object.bucket_id = 'photos'
            and split_part(object.name, '/', 1) = submission.user_id) storage_paths,
         (select item.photos from public.items item
          where item.id = submission.item_id) item_photo_paths
       from private.mobile_item_submissions submission
       where submission.user_id = $1
         and submission.idempotency_key = $2::uuid`,
      [legacyReplayId, key],
    );
    expect(durable.rows).toHaveLength(1);
    expect(durable.rows[0]).toMatchObject({
      bound_key: key,
      item_id: envelope.data.itemId,
      run_id: envelope.data.runId,
      request_fingerprint: prepared.legacyRequestFingerprint,
      items: 1,
      runs: 1,
      queue_messages: 1,
      credit_reservations: 1,
      usage_reservations: 1,
      ledger_rows: 1,
      storage_objects: 2,
    });
    expect(durable.rows[0]!.storage_paths).toEqual(
      photoReceipts.map((receipt) => receipt.storage_path).sort(),
    );
    expect(durable.rows[0]!.item_photo_paths).toEqual(
      photoReceipts.map((receipt) => receipt.storage_path),
    );
  });

  it("returns one canonical run and matching voice receipt after ambiguous v2 replay", async () => {
    const { createConfiguredMobileItemSubmissionOperations } = await import("./configured");
    const submitter = createConfiguredMobileItemSubmissionOperations({
      supabaseURL: SUPABASE_URL,
      publishableKey: PUBLISHABLE_KEY!,
      secretKey: SECRET_KEY!,
    });
    let loseFirstResponse = true;
    const handler = createMobileItemSubmissionHandler({
      requestId: () => crypto.randomUUID(),
      itemSubmission: {
        async resolvePrincipal(token) {
          if (token !== ownerToken) throw new Error("invalid test principal");
          return { kind: "clerk", userId: ownerId, bearerToken: token };
        },
        async submit(input) {
          const result = await submitter.submit(input);
          if (loseFirstResponse) {
            loseFirstResponse = false;
            throw new Error("response lost after commit");
          }
          return result;
        },
      },
    });
    const key = crypto.randomUUID();
    const voice = { bytes: fixedWavBytes(541), locale: "EN-us" };

    expect((await handler(request(
      ownerToken,
      key,
      fivePhotoMultipart("12.50", [0, 1, 2, 3, 4], null, voice),
    ))).status).toBe(503);
    const replay = await handler(request(
      ownerToken,
      key,
      fivePhotoMultipart("12.50", [0, 1, 2, 3, 4], null, voice),
    ));
    expect(replay.status).toBe(200);
    const envelope = await replay.json();
    itemId = envelope.data.itemId;
    runId = envelope.data.runId;
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(envelope.data.voiceContext).toMatchObject({
      version: 1,
      byteLength: voice.bytes.byteLength,
      durationMs: 10,
      mediaType: "audio/wav",
      contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(envelope.data).not.toHaveProperty("userId");
    expect(JSON.stringify(envelope.data)).not.toContain("pipeline-staging");

    expect((await handler(request(
      ownerToken,
      key,
      fivePhotoMultipart("12.50", [4, 3, 2, 1, 0]),
    ))).status).toBe(409);
    expect((await handler(request(ownerToken, key, fivePhotoMultipart("13.00")))).status).toBe(409);
    expect((await handler(request(
      ownerToken,
      key,
      fivePhotoMultipart("12.50", [0, 1, 2, 3, 4], 2),
    ))).status).toBe(409);
    expect((await handler(request(
      ownerToken,
      key,
      fivePhotoMultipart(
        "12.50",
        [0, 1, 2, 3, 4],
        null,
        { bytes: fixedWavBytes(542), locale: "en-US" },
      ),
    ))).status).toBe(409);
    expect((await handler(request(
      ownerToken,
      key,
      fivePhotoMultipart(
        "12.50",
        [0, 1, 2, 3, 4],
        null,
        { bytes: voice.bytes, locale: "fr-FR" },
      ),
    ))).status).toBe(409);

    const durable = await database.query<{
      items: number;
      runs: number;
      credit_reservations: number;
      usage_reservations: number;
      queue_messages: number;
      cleanup_intents: number;
      ledger_rows: number;
      storage_objects: number;
      queue_message_id: string;
      photo_paths: string[];
      request_fingerprint: string;
      voice_cleanup_bounded: boolean;
      voice_handoffs: number;
      voice_receipt: {
        storage_path: string;
        content_sha256: string;
        locale: string;
      };
      voice_state: string;
      queue_message: Record<string, unknown>;
    }>(
      `select
         (select count(*)::integer from public.items where id = $2::uuid and user_id = $1) items,
         (select count(*)::integer from public.pipeline_runs where id = $3::uuid and user_id = $1) runs,
         (select count(*)::integer from public.ai_item_credit_reservations where pipeline_run_id = $3::uuid) credit_reservations,
         (select count(*)::integer from private.pipeline_run_usage_reservations where run_id = $3::uuid) usage_reservations,
         (select count(*)::integer from pgmq.q_pipeline_jobs where message->>'run_id' = $3::text) queue_messages,
         (select count(*)::integer from private.pipeline_staging_cleanup_intents where user_id = $1) cleanup_intents,
         (select count(*)::integer from private.mobile_item_submissions where user_id = $1 and idempotency_key = $4::uuid) ledger_rows,
         (select count(*)::integer from storage.objects object
          where object.bucket_id = 'photos' and split_part(object.name, '/', 1) = $1) storage_objects,
         (select queue_message_id::text from private.mobile_item_submissions where user_id = $1 and idempotency_key = $4::uuid) queue_message_id,
         (select request_fingerprint from private.mobile_item_submissions where user_id = $1 and idempotency_key = $4::uuid) request_fingerprint,
         (select message from pgmq.q_pipeline_jobs
          where msg_id = (
            select queue_message_id from private.mobile_item_submissions
            where user_id = $1 and idempotency_key = $4::uuid
          )) queue_message,
         (select count(*)::integer
          from private.mobile_item_submission_voice_handoffs
          where user_id = $1 and idempotency_key = $4::uuid) voice_handoffs,
         (select state
          from private.mobile_item_submission_voice_handoffs
          where user_id = $1 and idempotency_key = $4::uuid) voice_state,
         (select receipt
          from private.mobile_item_submission_voice_handoffs
          where user_id = $1 and idempotency_key = $4::uuid) voice_receipt,
         (select cleanup_after <= created_at + interval '24 hours'
          from private.mobile_item_submission_voice_handoffs
          where user_id = $1 and idempotency_key = $4::uuid) voice_cleanup_bounded,
         (select photos from public.items where id = $2::uuid) photo_paths`,
      [ownerId, itemId, runId, key],
    );
    expect(durable.rows[0]).toMatchObject({
      items: 1,
      runs: 1,
      credit_reservations: 1,
      usage_reservations: 1,
      queue_messages: 1,
      cleanup_intents: 0,
      ledger_rows: 1,
      storage_objects: 6,
      voice_handoffs: 1,
      voice_state: "accepted",
      voice_cleanup_bounded: true,
    });
    expect(durable.rows[0]!.voice_receipt).toMatchObject({
      content_sha256: envelope.data.voiceContext.contentSha256,
      locale: "en-US",
    });
    expect(Object.keys(durable.rows[0]!.queue_message).sort()).toEqual([
      "run_id",
      "schema_version",
    ]);
    queueMessageId = durable.rows[0]!.queue_message_id;
    storagePaths = durable.rows[0]!.photo_paths;
    expect(storagePaths).toHaveLength(5);
    expect(storagePaths.map((path) => Number(path.split("/").at(-1)!.split("-")[0]))).toEqual([
      0, 1, 2, 3, 4,
    ]);

    const foreign = createClient(SUPABASE_URL, PUBLISHABLE_KEY!, {
      accessToken: async () => foreignToken,
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const [foreignItems, foreignRuns] = await Promise.all([
      foreign.from("items").select("id").eq("id", itemId),
      foreign.from("pipeline_runs").select("id").eq("id", runId),
    ]);
    expect(foreignItems.data).toEqual([]);
    expect(foreignRuns.data).toEqual([]);
    const foreignReplay = await foreign.rpc("find_mobile_item_submission_v3", {
      p_idempotency_key: key,
      p_legacy_request_fingerprint: null,
      p_request_fingerprint: durable.rows[0]!.request_fingerprint,
      p_recovery_id: null,
      p_recovery_token_hash: null,
    });
    expect(foreignReplay.data).toBeNull();
    expect(foreignReplay.error).toMatchObject({
      code: "42501",
      message: "Active verified guest capability is required",
    });
    const [foreignItemsAfterDenial, foreignRunsAfterDenial] = await Promise.all([
      foreign.from("items").select("id").eq("id", itemId),
      foreign.from("pipeline_runs").select("id").eq("id", runId),
    ]);
    expect(foreignItemsAfterDenial.data).toEqual([]);
    expect(foreignRunsAfterDenial.data).toEqual([]);

    const owner = createClient(SUPABASE_URL, PUBLISHABLE_KEY!, {
      accessToken: async () => ownerToken,
      auth: { persistSession: false, autoRefreshToken: false },
    });
    for (const [ordinal, path] of storagePaths.entries()) {
      const ownerRead = await owner.storage.from("photos").download(path);
      expect(ownerRead.error).toBeNull();
      expect(new Uint8Array(await ownerRead.data!.arrayBuffer())).toEqual(fiveJpegs[ordinal]);
    }
    const foreignRead = await foreign.storage.from("photos").download(storagePaths[0]!);
    expect(foreignRead.data).toBeNull();
    expect(foreignRead.error).not.toBeNull();
    const foreignWrite = await foreign.storage.from("photos").upload(
      `${ownerId}/pipeline-staging/${crypto.randomUUID()}/0/foreign.jpg`,
      jpeg,
      { contentType: "image/jpeg", upsert: false },
    );
    expect(foreignWrite.data).toBeNull();
    expect(foreignWrite.error).not.toBeNull();
    const voicePath = durable.rows[0]!.voice_receipt.storage_path;
    const ownerVoice = await owner.storage.from("photos").download(voicePath);
    expect(ownerVoice.error).toBeNull();
    expect(new Uint8Array(await ownerVoice.data!.arrayBuffer())).toEqual(
      voice.bytes,
    );
    const foreignVoice = await foreign.storage.from("photos").download(
      voicePath,
    );
    expect(foreignVoice.data).toBeNull();
    expect(foreignVoice.error).not.toBeNull();
  });

  it("carries the accepted run voice through the claimed worker context into listing generation", async () => {
    const submission = await createAcceptedVoiceSubmission(
      voiceJourneyId,
      voiceJourneyToken,
    );
    const runs = createSupabasePipelineWorkerStore({
      async rpc(functionName, args) {
        const { data, error } = await admin.rpc(functionName, args);
        return { data, error: error ? { message: error.message } : null };
      },
    });
    const acquisition = await runs.acquire({
      runId: submission.runId,
      messageId: submission.queueMessageId,
      leaseSeconds: 300,
    });
    expect(acquisition.kind).toBe("acquired");
    if (acquisition.kind !== "acquired") return;

    const price = {
      suggested: 149,
      range: { min: 130, max: 170 },
      confidence: 0.8,
      sources: [],
      tier: "llm-only" as const,
    };
    const identifiedCheckpoint = await runs.checkpoint({
      runId: submission.runId,
      leaseToken: acquisition.context.run.lease_token,
      stage: "identifying",
      checkpoint: {
        identified: {
          attributes: { brand: "Sony", model: "WH-1000XM4", condition: "good" },
          identification: {
            label: "Sony WH-1000XM4",
            confident: true,
            evidence: 1,
          },
          model: "vision-fixture",
        },
      },
      leaseSeconds: 300,
    });
    const pricedCheckpoint = await runs.checkpoint({
      runId: submission.runId,
      leaseToken: acquisition.context.run.lease_token,
      stage: "pricing",
      checkpoint: {
        ...identifiedCheckpoint,
        priced: { result: price },
      },
      leaseSeconds: 300,
    });
    acquisition.context.run.stage = "pricing";
    acquisition.context.run.checkpoint = pricedCheckpoint;
    const generate = vi.fn(async ({ sellerContext }) => ({
      copy: {
        platform: "ebay" as const,
        title: "Sony WH-1000XM4 Headphones",
        description: `Seller note (unverified): ${sellerContext.text}`,
        fields: {},
      },
      model: "listing-fixture",
    }));
    const stages: VisionPipelineStages = {
      run: async () => {
        throw new Error("the durable stage seam should be used");
      },
      identify: async () => ({
        attributes: { brand: "Sony", model: "WH-1000XM4", condition: "good" },
        identification: {
          label: "Sony WH-1000XM4",
          confident: true,
          evidence: 1,
        },
        model: "vision-fixture",
      }),
      price: async () => price,
      generate,
      assemble: ({ identified, generated }) => ({
        attributes: identified.attributes,
        identification: identified.identification,
        price,
        confidence: { score: 0.8, band: "high", autopilotEligible: false },
        listing: generated.copy,
        model: identified.model,
        listingModel: generated.model,
      }),
    };
    const voiceBucket = admin.storage.from("photos");
    const processor = createDurableVisionPipelineProcessor(stages, {
      voiceStorage: {
        async download({ path }) {
          const { data, error } = await voiceBucket.download(path);
          if (error) throw error;
          return new Uint8Array(await data.arrayBuffer());
        },
      },
      transcriber: {
        transcriptionAttempt: {
          role: "sellerContext",
          provider: "openai",
          model: "gpt-4o-mini-transcribe",
          calls: 1,
          chargedUsd: null,
        },
        async transcribe() {
          return {
            kind: "transcribed",
            text: "scratch on left hinge",
            language: "en-US" as CanonicalLanguageTag,
            providerContacted: true,
          };
        },
      },
      recordTerminalOutcome: (outcome) => runs.recordVoiceOutcome(outcome),
    });

    const result = await processor.process({
      context: acquisition.context,
      onCheckpoint: (stage, checkpoint) =>
        runs.checkpoint({
          runId: submission.runId,
          leaseToken: acquisition.context.run.lease_token,
          stage,
          checkpoint,
          leaseSeconds: 300,
        }),
    });

    expect(generate).toHaveBeenCalledWith({
      attributes: { brand: "Sony", model: "WH-1000XM4", condition: "good" },
      sellerContext: {
        text: "scratch on left hinge",
        language: "en-US",
        provenance: "seller_voice",
        verification: "unverified",
      },
    });
    expect(result.identification?.label).toBe("Sony WH-1000XM4");
    expect(result.price.suggested).toBe(149);
    expect(result.listing.description).toContain("scratch on left hinge");

    const providerUsage = {
      schemaVersion: 1 as const,
      modelCalls: 1,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      models: [],
      transcriptions: [
        {
          role: "sellerContext" as const,
          provider: "openai" as const,
          model: "gpt-4o-mini-transcribe",
          calls: 1,
          chargedUsd: null,
        },
      ],
      soldComps: [],
    };
    const gate = await connectDatabase("issue-774-provider-usage-gate");
    const usageWriter = await connectDatabase("issue-774-provider-usage-writer");
    const completer = await connectDatabase("issue-774-provider-usage-completer");
    let completion: { listingId: string } | undefined;
    try {
      const gatePid = (await gate.query<{ pid: number }>("select pg_backend_pid() pid"))
        .rows[0]!.pid;
      const usageWriterPid = (
        await usageWriter.query<{ pid: number }>("select pg_backend_pid() pid")
      ).rows[0]!.pid;
      const completerPid = (
        await completer.query<{ pid: number }>("select pg_backend_pid() pid")
      ).rows[0]!.pid;

      await gate.query("begin");
      const gatedRun = await gate.query<{ id: string }>(
        `select id::text
         from public.pipeline_runs
         where id = $1::uuid
         for update`,
        [submission.runId],
      );
      expect(gatedRun.rows).toEqual([{ id: submission.runId }]);
      await usageWriter.query("begin");
      await assumeServiceRole(usageWriter);
      const usageStore = createSupabasePipelineWorkerStore({
        async rpc(functionName, args) {
          if (functionName !== "record_pipeline_run_provider_usage") {
            throw new Error(`Unexpected usage RPC: ${functionName}`);
          }
          const persisted = await usageWriter.query<{ data: boolean }>(
            `select public.record_pipeline_run_provider_usage(
               $1::uuid, $2::uuid, $3::jsonb
             ) as data`,
            [
              args.p_run_id,
              args.p_lease_token,
              JSON.stringify(args.p_usage),
            ],
          );
          return { data: persisted.rows[0]!.data, error: null };
        },
      });
      const usageWrite = usageStore.recordProviderUsage({
        runId: submission.runId,
        leaseToken: acquisition.context.run.lease_token,
        usage: providerUsage,
      });
      await waitForPipelineRunFence(database, usageWriterPid, gatePid);

      await completer.query("begin");
      await assumeServiceRole(completer);
      let markCompletionQueryStarted = () => {};
      const completionQueryStarted = new Promise<void>((resolve) => {
        markCompletionQueryStarted = resolve;
      });
      const completionStore = createSupabasePipelineWorkerStore({
        async rpc(functionName, args) {
          if (functionName !== "complete_pipeline_run_with_guest_recovery") {
            throw new Error(`Unexpected completion RPC: ${functionName}`);
          }
          const guestRecoveryRegistration =
            args.p_guest_recovery_registration;
          expect(guestRecoveryRegistration).toBeNull();
          markCompletionQueryStarted();

          const persisted = await completer.query<{ data: unknown }>(
            `select public.complete_pipeline_run_with_guest_recovery(
               $1::uuid, $2::uuid, $3::jsonb, $4::jsonb
             ) as data`,
            [
              args.p_run_id,
              args.p_lease_token,
              JSON.stringify(args.p_persistence),
              guestRecoveryRegistration === null
                ? null
                : JSON.stringify(guestRecoveryRegistration),
            ],
          );
          return { data: persisted.rows[0]!.data, error: null };
        },
      });
      const completionWrite = completionStore.complete({
        runId: submission.runId,
        leaseToken: acquisition.context.run.lease_token,
        result,
        autopilotEnabled: acquisition.context.run.autopilot_enabled,
      });
      await completionQueryStarted;
      await waitForPipelineRunFence(database, completerPid, usageWriterPid);

      await gate.query("commit");
      await usageWrite;
      await usageWriter.query("commit");
      completion = await completionWrite;
      await completer.query("commit");
    } finally {
      await Promise.allSettled([
        gate.query("rollback"),
        usageWriter.query("rollback"),
        completer.query("rollback"),
      ]);
      await Promise.allSettled([
        gate.end(),
        usageWriter.end(),
        completer.end(),
      ]);
    }

    const retention = await database.query<{
      transcription_outcome: string;
      terminal_voice_outcome: string;
      transcription_provider_contacted: boolean;
      raw_audio_cleanup_queued: boolean;
      cleanup_jobs: number;
      retained_transcript: string;
      retained_language: string;
      durable_transcript: string;
      durable_language: string;
      listing_description: string;
      queue_message: Record<string, unknown>;
      prediction_leaks: number;
      usage_rows: number;
      usage_leaks: number;
    }>(
      `select
         handoff.transcription_outcome,
         handoff.terminal_voice_outcome,
         handoff.transcription_provider_contacted,
         handoff.raw_audio_cleanup_queued_at is not null raw_audio_cleanup_queued,
         (select count(*)::integer
          from private.pipeline_storage_cleanup_jobs job
          where job.source_type = 'raw_voice'
            and job.source_id = handoff.cleanup_id) cleanup_jobs,
         run.checkpoint #>> '{voice,sellerContext,text}' retained_transcript,
         run.checkpoint #>> '{voice,sellerContext,language}' retained_language,
         context.transcript durable_transcript,
         context.language durable_language,
         listing.description listing_description,
         (select message from pgmq.q_pipeline_jobs where msg_id = $2::bigint) queue_message,
         (select count(*)::integer
          from public.prediction_logs prediction
          where prediction.run_id = $1::uuid
            and position($3 in to_jsonb(prediction)::text) > 0) prediction_leaks,
         (select count(*)::integer
          from public.pipeline_run_provider_usage usage
          where usage.run_id = $1::uuid
         ) usage_rows,
         (select count(*)::integer
          from public.pipeline_run_provider_usage usage
          where usage.run_id = $1::uuid
            and position($3 in to_jsonb(usage)::text) > 0) usage_leaks
       from public.pipeline_runs run
       join private.mobile_item_submission_voice_handoffs handoff
         on handoff.run_id = run.id
        and handoff.user_id = run.user_id
        and handoff.item_id = run.item_id
       join private.item_seller_voice_contexts context
         on context.item_id = run.item_id
        and context.user_id = run.user_id
       join public.listings listing
         on listing.id = run.listing_id
        and listing.item_id = run.item_id
        and listing.user_id = run.user_id
       where run.id = $1::uuid`,
      [submission.runId, submission.queueMessageId, "scratch on left hinge"],
    );
    expect(retention.rows[0]).toMatchObject({
      transcription_outcome: "transcribed",
      terminal_voice_outcome: "transcribed",
      transcription_provider_contacted: true,
      raw_audio_cleanup_queued: true,
      cleanup_jobs: 1,
      retained_transcript: "scratch on left hinge",
      retained_language: "en-US",
      durable_transcript: "scratch on left hinge",
      durable_language: "en-US",
      listing_description: "Seller note (unverified): scratch on left hinge",
      prediction_leaks: 0,
      usage_rows: 1,
      usage_leaks: 0,
    });
    expect(Object.keys(retention.rows[0]!.queue_message).sort()).toEqual([
      "run_id",
      "schema_version",
    ]);
    expect(completion?.listingId).toBeTruthy();
    const usageReceipt = await readContentSafeProviderUsage(
      database,
      submission.runId,
    );
    expect(usageReceipt.rows).toEqual([
      {
        model_calls: 1,
        transcription_count: 1,
        transcription_role: "sellerContext",
        transcription_provider: "openai",
        transcription_model: "gpt-4o-mini-transcribe",
        transcription_calls: "1",
        charged_usd_unknown: true,
        only_allowed_transcription_fields: true,
      },
    ]);

    await database.query(
      `update public.pipeline_runs
       set completed_at = statement_timestamp() - interval '31 days'
       where id = $1::uuid`,
      [submission.runId],
    );
    await database.query("begin");
    try {
      await assumeServiceRole(database);
      await database.query("select public.prepare_pipeline_retention(100)");
      await database.query("commit");
    } catch (error) {
      await database.query("rollback");
      throw error;
    }
    const afterPrune = await database.query<{
      checkpoint: Record<string, unknown>;
      transcript: string;
      language: string;
    }>(
      `select run.checkpoint, context.transcript, context.language
       from public.pipeline_runs run
       join private.item_seller_voice_contexts context
         on context.item_id = run.item_id
        and context.user_id = run.user_id
       where run.id = $1::uuid`,
      [submission.runId],
    );
    expect(afterPrune.rows[0]).toEqual({
      checkpoint: {},
      transcript: "scratch on left hinge",
      language: "en-US",
    });
  });
});
