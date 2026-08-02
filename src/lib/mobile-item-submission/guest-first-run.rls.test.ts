import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  acquireExclusiveTestResource,
  type ExclusiveTestResourceLease,
} from "@/test/exclusive-resource-lock";
import {
  cleanupClerkTestUsers,
  mintInvalidVerifiedGuestJwt,
  mintUserJwt,
  mintVerifiedGuestJwt,
} from "@/lib/supabase/test-users";
import type { AppAttestVerificationResult } from "@/lib/app-attest/service";
import { createMobileItemSubmissionHandler } from "./http";
import { createMobileItemSubmissionOperations } from "./service";
import { createSupabaseMobileItemSubmissionStaging } from "./store";
import {
  DATABASE_URL,
  PUBLISHABLE_KEY,
  SUPABASE_URL,
  authorizeRemoveAndCompleteStagingCleanup,
  createSubmissionAdminControl,
  expireAndClaimStagingCleanup,
  fixedWavBytes,
  jpeg,
  localSubmissionStackIsReachable,
  proveVerifiedGuestLostResponseRecovery,
  request,
  singlePhotoMultipart,
} from "./rls-test-fixture";
import { shouldSkipGuestFirstRunForOfflineCi } from "./guest-first-run-test-mode";
import { skipIfStackUnreachable, stackReachable, whenStackReachable } from "@/test/supabase-stack";

vi.mock("server-only", () => ({}));

type VerifiedAssertion = Extract<
  AppAttestVerificationResult,
  { kind: "assertion"; status: "verified" }
>;

interface ObservedGuestRequest {
  apiKey: string | null;
  authorization: string | null;
  method: string;
  path: string;
}

let reachable = false;
let database: Client;
let admin: SupabaseClient;
let lease: ExclusiveTestResourceLease;
let guestId = "";
let foreignId = "";
let activeCapabilityId = "";
let inactiveCapabilityId = "";
let expiredCapabilityId = "";
let revokedCapabilityId = "";
let claimedCapabilityId = "";
let tombstonedCapabilityId = "";

beforeEach((context) => {
  skipIfStackUnreachable(context, reachable);
});

const verifiedAssertion = {
  appId: "TEAMID1234.dev.snaplist.ios",
  bundleVersion: "1",
  counter: 17,
  environment: "production",
  keyId: "issue-332-attested-key",
  kind: "assertion",
  requestHash: "a".repeat(43),
  status: "verified",
  validationCategory: 1,
} satisfies VerifiedAssertion;

function stableGuestPrincipal(assertion: VerifiedAssertion): string {
  return `guest_${createHash("sha256")
    .update(`${assertion.appId}\0${assertion.keyId}`)
    .digest("hex")
    .slice(0, 48)}`;
}

function observedFetch(
  observed: ObservedGuestRequest[],
): typeof fetch {
  return async (input, init) => {
    const outgoing = new Request(input, init);
    observed.push({
      apiKey: outgoing.headers.get("apikey"),
      authorization: outgoing.headers.get("authorization"),
      method: outgoing.method,
      path: new URL(outgoing.url).pathname,
    });
    return fetch(input, init);
  };
}

type PhotoBucket = ReturnType<SupabaseClient["storage"]["from"]>;

function createGuestSubmission(
  tenant: SupabaseClient,
  bucket: PhotoBucket,
  guestBearer: string,
  internalJwt: string,
  hooks: {
    afterDownload?: () => Promise<void>;
    afterRemove?: () => Promise<void>;
  } = {},
) {
  return createMobileItemSubmissionOperations({
    async resolvePrincipal(token) {
      if (token !== guestBearer || verifiedAssertion.status !== "verified") {
        throw new Error("The verified guest capability is invalid.");
      }
      return {
        capabilityId: activeCapabilityId,
        kind: "verifiedGuest",
        mintOperationToken: async () => internalJwt,
        userId: guestId,
      };
    },
    limits: { dailyLimit: 20, perMinuteLimit: 20 },
    staging: createSupabaseMobileItemSubmissionStaging(tenant, {
      authority: "authenticated-self",
    }),
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
        await hooks.afterDownload?.();
        return {
          bytes: new Uint8Array(await data.arrayBuffer()),
          mediaType: data.type,
        };
      },
      async remove(paths) {
        const { error } = await bucket.remove(paths);
        if (error) throw error;
        await hooks.afterRemove?.();
      },
    }),
  });
}

beforeAll(async () => {
  reachable = await stackReachable({
    apiKey: PUBLISHABLE_KEY,
    requiredValues: [DATABASE_URL, PUBLISHABLE_KEY],
    url: SUPABASE_URL,
    probe: localSubmissionStackIsReachable,
  });
  await whenStackReachable(reachable, async () => {
  lease = await acquireExclusiveTestResource("pipeline_jobs");
  database = new Client({
    application_name: "issue-332-guest-first-run",
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  });
  await database.connect();
  await database.query("set statement_timeout = '10s'");
  admin = createSubmissionAdminControl();
  guestId = stableGuestPrincipal(verifiedAssertion);
  foreignId = `guest_foreign_${Date.now()}`;
  activeCapabilityId = crypto.randomUUID();
  inactiveCapabilityId = crypto.randomUUID();
  expiredCapabilityId = crypto.randomUUID();
  revokedCapabilityId = crypto.randomUUID();
  claimedCapabilityId = crypto.randomUUID();
  tombstonedCapabilityId = crypto.randomUUID();
  await database.query(
    `insert into private.verified_guest_capabilities (
       capability_id, user_id, bearer_digest, state,
       activated_at, expires_at, revoked_at
     ) values
       ($1::uuid, $7, decode(md5($1::text) || md5('x' || $1::text), 'hex'),
        'active', statement_timestamp() - interval '1 minute',
        statement_timestamp() + interval '30 minutes', null),
       ($2::uuid, $7, decode(md5($2::text) || md5('x' || $2::text), 'hex'),
        'active', statement_timestamp() + interval '5 minutes',
        statement_timestamp() + interval '30 minutes', null),
       ($3::uuid, $7, decode(md5($3::text) || md5('x' || $3::text), 'hex'),
        'active', statement_timestamp() - interval '2 hours',
        statement_timestamp() - interval '1 hour', null),
       ($4::uuid, $7, decode(md5($4::text) || md5('x' || $4::text), 'hex'),
        'active', statement_timestamp() - interval '1 minute',
        statement_timestamp() + interval '30 minutes', statement_timestamp()),
       ($5::uuid, $7, decode(md5($5::text) || md5('x' || $5::text), 'hex'),
        'claimed', statement_timestamp() - interval '1 minute',
        statement_timestamp() + interval '30 minutes', null),
       ($6::uuid, $7, decode(md5($6::text) || md5('x' || $6::text), 'hex'),
        'tombstoned', statement_timestamp() - interval '1 minute',
        statement_timestamp() + interval '30 minutes', null)`,
    [
      activeCapabilityId,
      inactiveCapabilityId,
      expiredCapabilityId,
      revokedCapabilityId,
      claimedCapabilityId,
      tombstonedCapabilityId,
      guestId,
    ],
  );
  });
});

afterAll(async () => {
  await whenStackReachable(reachable, async () => {

  const residue = await database.query<{
    queue_message_id: string | null;
    storage_path: string | null;
  }>(
    `select run.queue_message_id::text queue_message_id, null::text storage_path
     from public.pipeline_runs run
     where run.user_id = $1
     union all
     select null::text, object.name
     from storage.objects object
     where object.bucket_id = 'photos'
       and split_part(object.name, '/', 1) = $1`,
    [guestId],
  );
  await Promise.all(
    residue.rows.flatMap((row) =>
      row.queue_message_id
        ? [admin.rpc("ack_pipeline_message", { p_message_id: row.queue_message_id })]
        : [],
    ),
  );
  const storagePaths = residue.rows.flatMap((row) =>
    row.storage_path ? [row.storage_path] : [],
  );
  if (storagePaths.length > 0) {
    await admin.storage.from("photos").remove(storagePaths);
  }
  await cleanupClerkTestUsers(admin, [guestId, foreignId]);
  await database.query(
    `delete from private.pipeline_staging_cleanup_intents
     where user_id = $1`,
    [guestId],
  );
  await database.query(
    `delete from private.mobile_item_submission_voice_handoffs
     where user_id = $1`,
    [guestId],
  );
  await database.query(
    `delete from private.mobile_item_submissions
     where user_id = $1`,
    [guestId],
  );
  await database.query(
    `delete from private.verified_guest_capabilities
     where capability_id = any($1::uuid[])`,
    [[
      activeCapabilityId,
      inactiveCapabilityId,
      expiredCapabilityId,
      revokedCapabilityId,
      claimedCapabilityId,
      tombstonedCapabilityId,
    ]],
  );
  await database.end();
  await lease.release();
  });
});

const describeVerifiedGuestFirstRun =
  shouldSkipGuestFirstRunForOfflineCi(process.env)
    ? describe.skip
    : describe;

describeVerifiedGuestFirstRun(
  "verified guest first-run submission against local Supabase",
  () => {
  it("serializes concurrent guest voice runs and replays only the winner through publishable-key RLS", async () => {
    const guestBearer = `guestcap_${crypto.randomUUID().replaceAll("-", "")}`;
    const internalJwt = await mintVerifiedGuestJwt(guestId, activeCapabilityId);
    const recovery = await proveVerifiedGuestLostResponseRecovery({
      admin,
      database,
    });
    expect(recovery).toEqual({
      activeRows: 2,
      atWindowIssued: true,
      concurrentIssued: 2,
      concurrentResolved: 1,
      firstDigestActive: false,
      firstState: "tombstoned",
      foreignActiveRows: 1,
      longLivedActiveRows: 1,
      repeatedIssued: true,
      replacementDigestActive: true,
      replacementIssued: true,
    });
    const channelRejectedTokens = [
      {
        label: "missing operation channel",
        token: await mintInvalidVerifiedGuestJwt(guestId, {
          actor: "verified_guest",
          capabilityId: activeCapabilityId,
          operationChannel: null,
        }),
      },
      {
        label: "wrong operation channel",
        token: await mintInvalidVerifiedGuestJwt(guestId, {
          actor: "verified_guest",
          capabilityId: activeCapabilityId,
          operationChannel: "verified_guest_private",
        }),
      },
      {
        label: "tampered operation channel",
        token: await mintInvalidVerifiedGuestJwt(guestId, {
          actor: "verified_guest",
          capabilityId: activeCapabilityId,
          operationChannel: "tampered",
        }),
      },
    ];
    const rejectedTokens = [
      {
        label: "ordinary Clerk JWT",
        token: await mintUserJwt(guestId),
      },
      ...channelRejectedTokens,
      {
        label: "missing actor",
        token: await mintInvalidVerifiedGuestJwt(guestId, {
          capabilityId: activeCapabilityId,
        }),
      },
      {
        label: "wrong actor",
        token: await mintInvalidVerifiedGuestJwt(guestId, {
          actor: "clerk_user",
          capabilityId: activeCapabilityId,
        }),
      },
      {
        label: "missing cap_id",
        token: await mintInvalidVerifiedGuestJwt(guestId, {
          actor: "verified_guest",
        }),
      },
      {
        label: "tampered cap_id",
        token: await mintInvalidVerifiedGuestJwt(guestId, {
          actor: "verified_guest",
          capabilityId: "tampered",
        }),
      },
      {
        label: "unknown cap_id",
        token: await mintVerifiedGuestJwt(guestId, crypto.randomUUID()),
      },
      {
        label: "wrong subject",
        token: await mintVerifiedGuestJwt(foreignId, activeCapabilityId),
      },
      {
        label: "expired capability",
        token: await mintVerifiedGuestJwt(guestId, expiredCapabilityId),
      },
      {
        label: "inactive capability",
        token: await mintVerifiedGuestJwt(guestId, inactiveCapabilityId),
      },
      {
        label: "revoked capability",
        token: await mintVerifiedGuestJwt(guestId, revokedCapabilityId),
      },
      {
        label: "claimed capability",
        token: await mintVerifiedGuestJwt(guestId, claimedCapabilityId),
      },
      {
        label: "tombstoned capability",
        token: await mintVerifiedGuestJwt(guestId, tombstonedCapabilityId),
      },
    ];
    for (const rejected of rejectedTokens) {
      const rejectedRequests: ObservedGuestRequest[] = [];
      const rejectedClient = createClient(SUPABASE_URL, PUBLISHABLE_KEY!, {
        accessToken: async () => rejected.token,
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: observedFetch(rejectedRequests) },
      });
      const { data, error } = await rejectedClient.rpc(
        "find_mobile_item_submission",
        {
          p_idempotency_key: crypto.randomUUID(),
          p_request_fingerprint: "0".repeat(64),
        },
      );
      expect(data, rejected.label).toBeNull();
      expect(error?.code, rejected.label).toBe("42501");
      expect(
        rejectedRequests.map((entry) => entry.path),
        rejected.label,
      ).toEqual([
        expect.stringMatching(/\/rpc\/find_mobile_item_submission$/),
      ]);
      expect(
        rejectedRequests.some((entry) => entry.path.includes("/storage/v1/")),
        rejected.label,
      ).toBe(false);
    }
    const rejectedKey = crypto.randomUUID();
    const rejectedCleanupId = crypto.randomUUID();
    const rejectedReceipt = {
      byte_length: 4,
      content_sha256: "0".repeat(64),
      media_type: "image/jpeg",
      ordinal: 0,
      storage_path:
        `${guestId}/pipeline-staging/${rejectedKey}/0/0-${"0".repeat(64)}.jpg`,
    };
    const guestRpcCalls = [
      {
        args: {
          p_idempotency_key: rejectedKey,
          p_request_fingerprint: "0".repeat(64),
        },
        name: "find_mobile_item_submission",
      },
      {
        args: {
          p_batch_id: rejectedKey,
          p_cleanup_id: rejectedCleanupId,
          p_cost_basis: 1,
          p_idempotency_key: rejectedKey,
          p_photo_receipts: [rejectedReceipt],
          p_request_fingerprint: "0".repeat(64),
        },
        name: "begin_mobile_item_submission",
      },
      {
        args: {
          p_batch_id: rejectedKey,
          p_cleanup_id: rejectedCleanupId,
          p_cost_basis: 1,
          p_daily_limit: 20,
          p_idempotency_key: rejectedKey,
          p_per_minute_limit: 20,
          p_photo_identity: {
            fingerprint: "0".repeat(64),
            kind: "content_sha256_set_v1",
          },
          p_photo_receipts: [rejectedReceipt],
          p_request_fingerprint: "0".repeat(64),
        },
        name: "commit_mobile_item_submission",
      },
      {
        args: {
          p_batch_id: rejectedKey,
          p_daily_limit: 20,
          p_entries: [],
          p_per_minute_limit: 20,
          p_photo_identities: [],
          p_user_id: guestId,
        },
        name: "stage_pipeline_batch",
      },
      {
        args: { p_cleanup_id: rejectedCleanupId },
        name: "resolve_pipeline_staging_cleanup_intent",
      },
    ] as const;
    for (const rejected of channelRejectedTokens) {
      const rejectedClient = createClient(SUPABASE_URL, PUBLISHABLE_KEY!, {
        accessToken: async () => rejected.token,
        auth: { persistSession: false, autoRefreshToken: false },
      });
      for (const call of guestRpcCalls.slice(1, 4)) {
        const { data, error } = await rejectedClient.rpc(call.name, call.args);
        expect(data, `${rejected.label} ${call.name}`).toBeNull();
        expect(error?.code, `${rejected.label} ${call.name}`).toBe("42501");
      }
    }
    const ordinaryRequests: ObservedGuestRequest[] = [];
    const ordinary = createClient(SUPABASE_URL, PUBLISHABLE_KEY!, {
      accessToken: async () => mintUserJwt(guestId),
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: observedFetch(ordinaryRequests) },
    });
    for (const call of guestRpcCalls) {
      const { data, error } = await ordinary.rpc(call.name, call.args);
      expect(data, `ordinary Clerk ${call.name}`).toBeNull();
      expect(error?.code, `ordinary Clerk ${call.name}`).toBe("42501");
    }
    expect(
      ordinaryRequests.every(
        (entry) =>
          entry.apiKey === PUBLISHABLE_KEY &&
          !entry.path.includes("/storage/v1/"),
      ),
    ).toBe(true);
    for (const call of guestRpcCalls.slice(0, 3)) {
      const { data, error } = await admin.rpc(call.name, call.args);
      expect(data, `secret-key ${call.name}`).toBeNull();
      expect(error?.code, `secret-key ${call.name}`).toBe("42501");
    }
    const preAuthorizedMutation = await database.query<{
      cleanup_intents: number;
      items: number;
      ledger_rows: number;
      runs: number;
      storage_objects: number;
    }>(
      `select
         (select count(*)::integer
          from private.pipeline_staging_cleanup_intents
          where user_id = $1) cleanup_intents,
         (select count(*)::integer from public.items
          where user_id = $1) items,
         (select count(*)::integer from private.mobile_item_submissions
          where user_id = $1) ledger_rows,
         (select count(*)::integer from public.pipeline_runs
          where user_id = $1) runs,
         (select count(*)::integer from storage.objects
          where bucket_id = 'photos'
            and split_part(name, '/', 1) = $1) storage_objects`,
      [guestId],
    );
    expect(preAuthorizedMutation.rows[0]).toEqual({
      cleanup_intents: 0,
      items: 0,
      ledger_rows: 0,
      runs: 0,
      storage_objects: 0,
    });
    const observedRequests: ObservedGuestRequest[] = [];
    const tenant = createClient(SUPABASE_URL, PUBLISHABLE_KEY!, {
      accessToken: async () => internalJwt,
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: observedFetch(observedRequests) },
    });
    const bucket = tenant.storage.from("photos");
    const authenticatedCleanupBypass = await tenant.rpc(
      "resolve_pipeline_staging_cleanup_intent", { p_cleanup_id: crypto.randomUUID() });
    expect(authenticatedCleanupBypass.data).toBeNull();
    expect(authenticatedCleanupBypass.error?.code).toBe("42501");
    const revokedBetweenKey = crypto.randomUUID();
    let revokedBetweenDownload = false;
    const revokedBetweenSubmission = createGuestSubmission(
      tenant,
      bucket,
      guestBearer,
      internalJwt,
      {
        async afterDownload() {
          if (!revokedBetweenDownload) {
            await database.query(
              `update private.verified_guest_capabilities
               set revoked_at = statement_timestamp()
               where capability_id = $1::uuid`,
              [activeCapabilityId],
            );
            revokedBetweenDownload = true;
          }
        },
      },
    );
    const revokedBetweenHandler = createMobileItemSubmissionHandler({
      itemSubmission: revokedBetweenSubmission,
      requestId: () => crypto.randomUUID(),
    });
    const revokedBetweenResponse = await revokedBetweenHandler(
      request(guestBearer, revokedBetweenKey, singlePhotoMultipart()),
    );
    expect(revokedBetweenResponse.status).toBe(503);
    const revokedBetweenAuthority = await database.query<{
      cleanup_id: string;
      cleanup_generation: number;
      cleanup_intents: number;
      credit_reservations: number;
      items: number;
      ledger_rows: number;
      queue_messages: number;
      runs: number;
      storage_objects: number;
      usage_reservations: number;
      photo_paths: string[];
    }>(
      `select
         max(submission.cleanup_id::text) cleanup_id,
         coalesce(max(submission.cleanup_generation), 0)::integer
           cleanup_generation,
         (select count(*)::integer
          from private.pipeline_staging_cleanup_intents intent
          where intent.user_id = $1
            and intent.batch_id = $2::uuid) cleanup_intents,
         (select count(*)::integer from public.ai_item_credit_reservations
          where user_id = $1) credit_reservations,
         (select count(*)::integer from public.items
          where user_id = $1) items,
         count(*)::integer ledger_rows,
         (select count(*)::integer
          from pgmq.q_pipeline_jobs message
          join public.pipeline_runs run
            on run.queue_message_id = message.msg_id
          where run.user_id = $1) queue_messages,
         (select count(*)::integer from public.pipeline_runs
          where user_id = $1) runs,
         (select count(*)::integer from storage.objects
          where bucket_id = 'photos'
            and name like $1 || '/pipeline-staging/' || $2 || '/%')
           storage_objects,
         (select count(*)::integer
          from private.pipeline_run_usage_reservations reservation
          where reservation.user_id = $1) usage_reservations,
         (select intent.photo_paths
          from private.pipeline_staging_cleanup_intents intent
          where intent.user_id = $1
            and intent.batch_id = $2::uuid
          limit 1) photo_paths
       from private.mobile_item_submissions submission
       where submission.user_id = $1
         and submission.idempotency_key = $2::uuid
         and submission.state = 'uploading'`,
      [guestId, revokedBetweenKey],
    );
    expect(revokedBetweenAuthority.rows[0]).toMatchObject({
      cleanup_generation: 1,
      cleanup_intents: 1,
      credit_reservations: 0,
      items: 0,
      ledger_rows: 1,
      queue_messages: 0,
      runs: 0,
      storage_objects: 1,
      usage_reservations: 0,
    });
    expect(revokedBetweenAuthority.rows[0]!.photo_paths).toHaveLength(1);
    const revokedCleanupJob = await expireAndClaimStagingCleanup({
      admin,
      cleanupId: revokedBetweenAuthority.rows[0]!.cleanup_id,
      database,
    });
    await authorizeRemoveAndCompleteStagingCleanup({
      admin,
      expectedPaths: revokedBetweenAuthority.rows[0]!.photo_paths,
      job: revokedCleanupJob,
    });
    await database.query(
      `update private.verified_guest_capabilities
       set revoked_at = null
       where capability_id = $1::uuid`,
      [activeCapabilityId],
    );
    observedRequests.length = 0;
    const submission = createGuestSubmission(
      tenant,
      bucket,
      guestBearer,
      internalJwt,
    );
    const handler = createMobileItemSubmissionHandler({
      itemSubmission: submission,
      requestId: () => crypto.randomUUID(),
    });
    const idempotencyKeys = [crypto.randomUUID(), crypto.randomUUID()];
    const voiceBytes = fixedWavBytes(541);
    const voiceMultipart = () => {
      const body = singlePhotoMultipart();
      body.append(
        "voiceContext",
        new File(
          [Uint8Array.from(voiceBytes).buffer],
          "seller-context.wav",
          { type: "audio/wav" },
        ),
      );
      body.append("voiceContextLocale", "EN-us");
      return body;
    };

    expect(guestBearer).not.toContain(guestId);
    const responses = await Promise.all(
      idempotencyKeys.map((key) =>
        handler(request(guestBearer, key, voiceMultipart())),
      ),
    );
    expect(
      observedRequests.filter((entry) =>
        entry.path.endsWith("/rpc/find_mobile_item_submission_v2"),
      ),
    ).toHaveLength(2);
    expect(
      observedRequests.filter((entry) =>
        entry.path.endsWith("/rpc/begin_mobile_item_submission_v2"),
      ),
    ).toHaveLength(2);
    const storageRequests = observedRequests.filter((entry) =>
      entry.path.includes("/storage/v1/"),
    );
    expect(storageRequests).toHaveLength(8);
    expect(storageRequests.map((entry) => entry.method).sort()).toEqual([
      "GET",
      "GET",
      "GET",
      "GET",
      "POST",
      "POST",
      "POST",
      "POST",
    ]);
    expect(
      observedRequests.filter((entry) =>
        entry.path.endsWith("/rpc/commit_mobile_item_submission_v2"),
      ),
    ).toHaveLength(2);
    expect(observedRequests.filter((entry) =>
      entry.path.endsWith("/rpc/resolve_pipeline_staging_cleanup_intent"),
    )).toHaveLength(0);
    expect(responses.map((response) => response.status).sort()).toEqual([
      202,
      403,
    ]);

    const winnerIndex = responses.findIndex((response) => response.status === 202);
    const loserIndex = 1 - winnerIndex;
    const winner = await responses[winnerIndex]!.json();
    expect(winner.data.voiceContext).toMatchObject({
      version: 1,
      byteLength: voiceBytes.byteLength,
      durationMs: 10,
      mediaType: "audio/wav",
      contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    await expect(responses[loserIndex]!.json()).resolves.toMatchObject({
      error: {
        code: "forbidden",
        details: { reason: "snaplist-pro-required" },
      },
    });

    const requestsBeforeReplay = observedRequests.length;
    const storageBeforeReplay = observedRequests.filter((entry) =>
      entry.path.includes("/storage/v1/"),
    ).length;
    const replay = await handler(
      request(
        guestBearer,
        idempotencyKeys[winnerIndex]!,
        voiceMultipart(),
      ),
    );
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      data: {
        itemId: winner.data.itemId,
        runId: winner.data.runId,
        status: "queued",
      },
    });
    expect(
      observedRequests.filter((entry) =>
        entry.path.endsWith("/rpc/find_mobile_item_submission_v2"),
      ),
    ).toHaveLength(3);
    expect(
      observedRequests.slice(requestsBeforeReplay).map((entry) => entry.path),
    ).toEqual([
      expect.stringMatching(/\/rpc\/find_mobile_item_submission_v2$/),
    ]);
    expect(
      observedRequests.filter((entry) =>
        entry.path.includes("/storage/v1/"),
      ),
    ).toHaveLength(storageBeforeReplay);

    const loserAuthority = await database.query<{
      cleanup_id: string;
      photo_paths: string[];
    }>(
      `select submission.cleanup_id::text, intent.photo_paths
       from private.mobile_item_submissions submission
       join private.pipeline_staging_cleanup_intents intent
         on intent.cleanup_id = submission.cleanup_id
       where submission.user_id = $1
         and submission.idempotency_key = $2::uuid
         and submission.state = 'uploading'`,
      [guestId, idempotencyKeys[loserIndex]],
    );
    expect(loserAuthority.rows).toHaveLength(1);
    const loserJob = await expireAndClaimStagingCleanup({
      admin,
      cleanupId: loserAuthority.rows[0]!.cleanup_id,
      database,
    });
    await authorizeRemoveAndCompleteStagingCleanup({
      admin,
      expectedPaths: loserAuthority.rows[0]!.photo_paths,
      job: loserJob,
    });

    const durable = await database.query<{
      allowance_periods: number;
      cleanup_intents: number;
      credit_reservations: number;
      items: number;
      ledger_rows: number;
      queue_messages: number;
      runs: number;
      storage_objects: number;
      usage_reservations: number;
      photo_paths: string[];
      accepted_voice_handoffs: number;
      staged_voice_handoffs: number;
    }>(
      `select
         (select count(*)::integer from public.ai_item_allowance_periods
          where user_id = $1 and source = 'included') allowance_periods,
         (select count(*)::integer
          from private.pipeline_staging_cleanup_intents
          where user_id = $1) cleanup_intents,
         (select count(*)::integer from public.ai_item_credit_reservations
          where user_id = $1) credit_reservations,
         (select count(*)::integer from public.items
          where user_id = $1) items,
         (select count(*)::integer from private.mobile_item_submissions
          where user_id = $1) ledger_rows,
         (select count(*)::integer
          from pgmq.q_pipeline_jobs message
          join public.pipeline_runs run
            on run.queue_message_id = message.msg_id
          where run.user_id = $1) queue_messages,
         (select count(*)::integer from public.pipeline_runs
          where user_id = $1) runs,
         (select count(*)::integer from storage.objects
          where bucket_id = 'photos'
            and split_part(name, '/', 1) = $1) storage_objects,
         (select count(*)::integer
          from private.pipeline_run_usage_reservations reservation
          join public.pipeline_runs run on run.id = reservation.run_id
          where run.user_id = $1) usage_reservations,
         (select count(*)::integer
          from private.mobile_item_submission_voice_handoffs handoff
          where handoff.user_id = $1
            and handoff.state = 'accepted') accepted_voice_handoffs,
         (select count(*)::integer
          from private.mobile_item_submission_voice_handoffs handoff
          where handoff.user_id = $1
            and handoff.state = 'staged') staged_voice_handoffs,
         (select item.photos from public.items item
          where item.id = $2::uuid and item.user_id = $1) photo_paths`,
      [guestId, winner.data.itemId],
    );
    expect(durable.rows[0]).toMatchObject({
      allowance_periods: 1,
      cleanup_intents: 0,
      credit_reservations: 1,
      items: 1,
      ledger_rows: 1,
      queue_messages: 1,
      runs: 1,
      storage_objects: 3,
      usage_reservations: 1,
      accepted_voice_handoffs: 1,
      staged_voice_handoffs: 1,
    });
    expect(durable.rows[0]!.photo_paths).toHaveLength(1);

    const failedCleanupKey = crypto.randomUUID();
    const failedCleanupSubmission = createGuestSubmission(
      tenant,
      bucket,
      guestBearer,
      internalJwt,
    );
    const failedCleanupHandler = createMobileItemSubmissionHandler({
      itemSubmission: failedCleanupSubmission,
      requestId: () => crypto.randomUUID(),
    });
    const failedCleanupResponse = await failedCleanupHandler(
      request(guestBearer, failedCleanupKey, singlePhotoMultipart()),
    );
    expect(failedCleanupResponse.status).toBe(403);
    const deniedAuthority = await database.query<{
      batch_id: string;
      cleanup_generation: number;
      cleanup_id: string;
      cost_basis: string;
      idempotency_key: string;
      intent_paths: string[];
      photo_receipts: Array<{
        byte_length: number;
        content_sha256: string;
        media_type: "image/jpeg";
        ordinal: number;
        storage_path: string;
      }>;
      request_fingerprint: string;
      state: string;
    }>(
      `select submission.batch_id::text,
         submission.cleanup_generation::integer,
         submission.cleanup_id::text,
         submission.cost_basis::text,
         submission.idempotency_key::text,
         intent.photo_paths intent_paths,
         submission.photo_receipts,
         submission.request_fingerprint,
         submission.state
       from private.mobile_item_submissions submission
       join private.pipeline_staging_cleanup_intents intent
         on intent.cleanup_id = submission.cleanup_id
       where submission.user_id = $1
         and submission.idempotency_key = $2::uuid`,
      [guestId, failedCleanupKey],
    );
    expect(deniedAuthority.rows).toHaveLength(1);
    const denied = deniedAuthority.rows[0]!;
    expect(denied).toMatchObject({
      cleanup_generation: 1,
      state: "uploading",
    });
    expect(denied.intent_paths).toEqual(
      denied.photo_receipts.map((receipt) => receipt.storage_path),
    );
    const removedBeforeRetention = await admin.storage
      .from("photos")
      .download(denied.intent_paths[0]!);
    expect(removedBeforeRetention.error).toBeNull();
    expect(removedBeforeRetention.data).not.toBeNull();

    const claimedJob = await expireAndClaimStagingCleanup({
      admin,
      cleanupId: denied.cleanup_id,
      database,
    });
    expect(claimedJob.photoPaths).toEqual(denied.intent_paths);

    const replayBegin = await tenant.rpc("begin_mobile_item_submission", {
      p_batch_id: denied.batch_id,
      p_cleanup_id: denied.cleanup_id,
      p_cost_basis: denied.cost_basis,
      p_idempotency_key: denied.idempotency_key,
      p_photo_receipts: denied.photo_receipts,
      p_request_fingerprint: denied.request_fingerprint,
    });
    expect(replayBegin.error).toBeNull();
    expect(replayBegin.data).toBe(false);
    const supersededFence = await database.query<{
      cleanup_generation: number;
      cleanup_intents: number;
      cleanup_jobs: number;
    }>(
      `select submission.cleanup_generation::integer,
         (select count(*)::integer
          from private.pipeline_staging_cleanup_intents intent
          where intent.cleanup_id = submission.cleanup_id) cleanup_intents,
         (select count(*)::integer
          from private.pipeline_storage_cleanup_jobs job
          where job.source_type = 'staging'
            and job.source_id = submission.cleanup_id) cleanup_jobs
       from private.mobile_item_submissions submission
       where submission.user_id = $1
         and submission.idempotency_key = $2::uuid`,
      [guestId, failedCleanupKey],
    );
    expect(supersededFence.rows[0]).toEqual({
      cleanup_generation: 2,
      cleanup_intents: 1,
      cleanup_jobs: 0,
    });

    const retryPath = denied.photo_receipts[0]!.storage_path;
    const retryUpload = await bucket.upload(retryPath, jpeg, {
      contentType: "image/jpeg",
      upsert: false,
    });
    expect(retryUpload.error).not.toBeNull();
    const staleAuthorization = await admin.rpc(
      "authorize_pipeline_storage_cleanup",
      {
        p_job_id: claimedJob.jobId,
        p_lease_token: claimedJob.leaseToken,
      },
    );
    expect(staleAuthorization.error).toBeNull();
    expect(staleAuthorization.data).toEqual({ kind: "stale" });
    const retryObject = await bucket.download(retryPath);
    expect(retryObject.error).toBeNull();

    const retryFingerprint = createHash("sha256")
      .update(
        denied.photo_receipts
          .map((receipt) => receipt.content_sha256)
          .sort()
          .join("\n"),
      )
      .digest("hex");
    const deniedRetryCommit = await tenant.rpc(
      "commit_mobile_item_submission",
      {
        p_batch_id: denied.batch_id,
        p_cleanup_id: denied.cleanup_id,
        p_cost_basis: denied.cost_basis,
        p_daily_limit: 20,
        p_idempotency_key: denied.idempotency_key,
        p_per_minute_limit: 20,
        p_photo_identity: {
          fingerprint: retryFingerprint,
          kind: "content_sha256_set_v1",
        },
        p_photo_receipts: denied.photo_receipts,
        p_request_fingerprint: denied.request_fingerprint,
      },
    );
    expect(deniedRetryCommit.error).toBeNull();
    expect(deniedRetryCommit.data).toEqual([
      expect.objectContaining({
        denial_reason: "snaplist-pro-required",
        item_id: null,
        run_id: null,
      }),
    ]);
    const retryEffects = await database.query<{
      credit_reservations: number;
      queue_messages: number;
      runs: number;
      usage_reservations: number;
    }>(
      `select
         (select count(*)::integer
          from public.ai_item_credit_reservations credit
          join public.pipeline_runs run on run.id = credit.pipeline_run_id
          where run.user_id = $1
            and run.idempotency_key = $2) credit_reservations,
         (select count(*)::integer
          from pgmq.q_pipeline_jobs message
          join public.pipeline_runs run
            on run.queue_message_id = message.msg_id
          where run.user_id = $1
            and run.idempotency_key = $2) queue_messages,
         (select count(*)::integer from public.pipeline_runs run
          where run.user_id = $1
            and run.idempotency_key = $2) runs,
         (select count(*)::integer
          from private.pipeline_run_usage_reservations reservation
          join public.pipeline_runs run on run.id = reservation.run_id
          where run.user_id = $1
            and run.idempotency_key = $2) usage_reservations`,
      [guestId, failedCleanupKey],
    );
    expect(retryEffects.rows[0]).toEqual({
      credit_reservations: 0,
      queue_messages: 0,
      runs: 0,
      usage_reservations: 0,
    });
    const retryCleanupJob = await expireAndClaimStagingCleanup({
      admin,
      cleanupId: denied.cleanup_id,
      database,
    });
    await authorizeRemoveAndCompleteStagingCleanup({
      admin,
      expectedPaths: [retryPath],
      job: retryCleanupJob,
    });
    const deniedResidue = await database.query<{ residue: number }>(
      `select (
         (select count(*) from private.mobile_item_submissions
          where user_id = $1 and idempotency_key = $2::uuid)
         + (select count(*) from private.pipeline_staging_cleanup_intents
            where cleanup_id = $3::uuid)
         + (select count(*) from private.pipeline_storage_cleanup_jobs
            where source_type = 'staging' and source_id = $3::uuid)
       )::integer residue`,
      [guestId, failedCleanupKey, denied.cleanup_id],
    );
    expect(deniedResidue.rows[0]!.residue).toBe(0);

    const foreignJwt = await mintUserJwt(foreignId);
    const foreign = createClient(SUPABASE_URL, PUBLISHABLE_KEY!, {
      accessToken: async () => foreignJwt,
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const [ownedItems, foreignItems, foreignPhoto] = await Promise.all([
      tenant.from("items").select("id").eq("id", winner.data.itemId),
      foreign.from("items").select("id").eq("id", winner.data.itemId),
      foreign.storage
        .from("photos")
        .download(durable.rows[0]!.photo_paths[0]!),
    ]);
    expect(ownedItems.data).toEqual([{ id: winner.data.itemId }]);
    expect(foreignItems.data).toEqual([]);
    expect(foreignPhoto.data).toBeNull();
    expect(foreignPhoto.error).not.toBeNull();

    expect(observedRequests.length).toBeGreaterThan(0);
    expect(new Set(observedRequests.map((entry) => entry.apiKey))).toEqual(
      new Set([PUBLISHABLE_KEY]),
    );
    expect(
      observedRequests.every(
        (entry) =>
          entry.authorization === `Bearer ${internalJwt}` &&
          !entry.apiKey?.startsWith("sb_secret_"),
      ),
    ).toBe(true);
  });
  },
);
