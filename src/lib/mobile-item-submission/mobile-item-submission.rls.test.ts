import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  acquireExclusiveTestResource,
  resolveLocalTestDatabaseUrl,
  type ExclusiveTestResourceLease,
} from "@/test/exclusive-resource-lock";
import { cleanupClerkTestUsers, mintUserJwt } from "@/lib/supabase/test-users";
import { createMobileItemSubmissionHandler } from "./http";
import { createMobileItemSubmissionOperations } from "./service";
import { createSupabaseMobileItemSubmissionStaging } from "./store";

vi.mock("server-only", () => ({}));

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const DATABASE_URL = resolveLocalTestDatabaseUrl();

let reachable = false;
let database: Client;
let admin: SupabaseClient;
let lease: ExclusiveTestResourceLease;
let ownerId = "";
let foreignId = "";
let recoveryId = "";
let ownerToken = "";
let foreignToken = "";
let recoveryToken = "";
let itemId = "";
let runId = "";
let queueMessageId = "";
let storagePaths: string[] = [];

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function multipart(costBasis = "12.50", reverse = false): FormData {
  const body = new FormData();
  const photos = reverse
    ? [[png, "back.png", "image/png"], [jpeg, "front.jpg", "image/jpeg"]]
    : [[jpeg, "front.jpg", "image/jpeg"], [png, "back.png", "image/png"]];
  for (const [bytes, name, type] of photos as Array<[Uint8Array, string, string]>) {
    body.append("photo", new File([new Uint8Array(bytes).buffer], name, { type }));
  }
  body.append("costBasis", costBasis);
  return body;
}

function request(token: string, key: string, body: FormData): Request {
  return new Request("http://127.0.0.1:3001/v1/items/runs", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": key,
    },
    body,
  });
}

beforeAll(async () => {
  if (
    !PUBLISHABLE_KEY?.startsWith("sb_publishable_") ||
    !SECRET_KEY?.startsWith("sb_secret_") ||
    !new URL(SUPABASE_URL).hostname.match(/^(127\.0\.0\.1|localhost|::1)$/)
  ) return;
  try {
    const health = await fetch(`${SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: PUBLISHABLE_KEY },
      signal: AbortSignal.timeout(2_000),
    });
    if (!health.ok) return;
  } catch {
    return;
  }

  lease = await acquireExclusiveTestResource("pipeline_jobs");
  database = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2_000 });
  await database.connect();
  admin = createClient(SUPABASE_URL, SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  ownerId = `user_test_mobile_submit_owner_${Date.now()}`;
  foreignId = `user_test_mobile_submit_foreign_${Date.now()}`;
  recoveryId = `user_test_mobile_submit_recovery_${Date.now()}`;
  [ownerToken, foreignToken, recoveryToken] = await Promise.all([
    mintUserJwt(ownerId),
    mintUserJwt(foreignId),
    mintUserJwt(recoveryId),
  ]);
  reachable = true;
});

afterAll(async () => {
  if (!reachable) return;
  const residue = await database.query<{ queue_message_id: string | null; storage_path: string | null }>(
    `select run.queue_message_id::text queue_message_id, null::text storage_path
     from public.pipeline_runs run where run.user_id = any($1::text[])
     union all
     select null::text, object.name
     from storage.objects object
     where object.bucket_id = 'photos'
       and split_part(object.name, '/', 1) = any($1::text[])`,
    [[ownerId, foreignId, recoveryId]],
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
  await cleanupClerkTestUsers(admin, [ownerId, foreignId, recoveryId]);
  await database.query(
    `delete from private.pipeline_staging_cleanup_intents
     where user_id = any($1::text[])`,
    [[ownerId, foreignId, recoveryId]],
  );
  await database.query(
    `delete from private.mobile_item_submissions
     where user_id = any($1::text[])`,
    [[ownerId, foreignId, recoveryId]],
  );
  await database.end();
  await lease.release();
});

describe("authenticated mobile item submission against local Supabase", () => {
  it("binds a failed pre-commit attempt, rejects changed cost, and resumes exact bytes", async () => {
    if (!reachable) return;
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
  });

  it("recovers an ambiguous response with one atomic reservation and queue message", async () => {
    if (!reachable) return;
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

    expect((await handler(request(ownerToken, key, multipart()))).status).toBe(503);
    const replay = await handler(request(ownerToken, key, multipart()));
    expect(replay.status).toBe(200);
    const envelope = await replay.json();
    itemId = envelope.data.itemId;
    runId = envelope.data.runId;
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(envelope.data).not.toHaveProperty("userId");
    expect(JSON.stringify(envelope.data)).not.toContain("pipeline-staging");

    expect((await handler(request(ownerToken, key, multipart("12.50", true)))).status).toBe(409);
    expect((await handler(request(ownerToken, key, multipart("13.00")))).status).toBe(409);
    const changedBytes = multipart();
    changedBytes.delete("photo");
    changedBytes.append("photo", new File([new Uint8Array([...jpeg, 0])], "changed.jpg", {
      type: "image/jpeg",
    }));
    expect((await handler(request(ownerToken, key, changedBytes))).status).toBe(409);

    const durable = await database.query<{
      items: number;
      runs: number;
      credit_reservations: number;
      usage_reservations: number;
      queue_messages: number;
      cleanup_intents: number;
      ledger_rows: number;
      queue_message_id: string;
      photo_paths: string[];
    }>(
      `select
         (select count(*)::integer from public.items where id = $2::uuid and user_id = $1) items,
         (select count(*)::integer from public.pipeline_runs where id = $3::uuid and user_id = $1) runs,
         (select count(*)::integer from public.ai_item_credit_reservations where pipeline_run_id = $3::uuid) credit_reservations,
         (select count(*)::integer from private.pipeline_run_usage_reservations where run_id = $3::uuid) usage_reservations,
         (select count(*)::integer from pgmq.q_pipeline_jobs where message->>'run_id' = $3::text) queue_messages,
         (select count(*)::integer from private.pipeline_staging_cleanup_intents where user_id = $1) cleanup_intents,
         (select count(*)::integer from private.mobile_item_submissions where user_id = $1 and idempotency_key = $4::uuid) ledger_rows,
         (select queue_message_id::text from private.mobile_item_submissions where user_id = $1 and idempotency_key = $4::uuid) queue_message_id,
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
    });
    queueMessageId = durable.rows[0]!.queue_message_id;
    storagePaths = durable.rows[0]!.photo_paths;

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

    const owner = createClient(SUPABASE_URL, PUBLISHABLE_KEY!, {
      accessToken: async () => ownerToken,
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const ownerRead = await owner.storage.from("photos").download(storagePaths[0]!);
    expect(ownerRead.error).toBeNull();
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
  });
});
