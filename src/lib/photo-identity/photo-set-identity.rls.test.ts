import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";

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

const PHOTO_SET_KIND = "content_sha256_set_v1";
const PHOTO_SET_FINGERPRINT =
  "2601809a314994324ece98d372ae5f7f546deaa21d430b76331d96dcfd5e75a9";

let reachable = false;
let admin: SupabaseClient;
let seller: ClerkTestUser;
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

async function connectDatabase(applicationName: string): Promise<Client> {
  const client = new Client({
    application_name: applicationName,
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 1_000,
  });
  await client.connect();
  await client.query("set statement_timeout = '10s'");
  return client;
}

async function assumeServiceRole(client: Client): Promise<void> {
  await client.query(
    "select set_config('request.jwt.claims', $1, true)",
    [JSON.stringify({ role: "service_role" })],
  );
  await client.query("set local role service_role");
}

async function waitForAdvisoryBlock(
  observer: Client,
  loserPid: number,
  winnerPid: number,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{
      blockers: number[];
      waiting_on_advisory: boolean;
    }>(
      `select
         pg_blocking_pids($1) as blockers,
         exists (
           select 1 from pg_locks
           where pid = $1
             and locktype = 'advisory'
             and not granted
         ) as waiting_on_advisory`,
      [loserPid],
    );
    const state = result.rows[0];
    if (
      state?.waiting_on_advisory &&
      state.blockers.includes(winnerPid)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Verified staging loser never blocked behind legacy winner");
}

beforeAll(async () => {
  reachable = await stackReachable();
  if (!reachable) return;
  admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  [seller, concurrentSeller] = await Promise.all([
    provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "photo_identity"),
    provisionClerkTestUser(SUPABASE_URL, ANON_KEY!, "photo_identity_concurrent"),
  ]);
});

afterAll(async () => {
  if (!reachable) return;
  for (const queueMessageId of queueMessageIds) {
    await admin.rpc("ack_pipeline_message", { p_message_id: queueMessageId });
  }
  await cleanupClerkTestUsers(admin, [seller.id, concurrentSeller.id]);
});

describe("versioned photo-set identity persistence", () => {
  it("binds one server-verified content identity to the item, run, and credit reservation", async () => {
    if (!reachable) return;
    const idempotencyKey = `photo-identity-${crypto.randomUUID()}`;
    const entry = {
      idempotency_key: idempotencyKey,
      source: "single",
      autopilot_enabled: false,
      photo_paths: [
        `${seller.id}/verified/front.jpg`,
        `${seller.id}/verified/detail.jpg`,
        `${seller.id}/verified/back.jpg`,
      ],
      cost_basis: null,
    };
    const stageArgs = {
      p_user_id: seller.id,
      p_batch_id: crypto.randomUUID(),
      p_entries: [entry],
      p_daily_limit: 10,
      p_per_minute_limit: 10,
      p_photo_identities: [
        {
          idempotency_key: idempotencyKey,
          photo_identity_kind: PHOTO_SET_KIND,
          photo_identity_fingerprint: PHOTO_SET_FINGERPRINT,
        },
      ],
    };
    const staged = await admin.rpc("stage_pipeline_batch", stageArgs);

    expect(staged.error).toBeNull();
    const receipt = (staged.data as Array<{
      item_id: string;
      run_id: string;
      queue_message_id: string | number;
    }>)[0];
    queueMessageIds.add(String(receipt.queue_message_id));

    const replay = await admin.rpc("stage_pipeline_batch", stageArgs);
    expect(replay).toMatchObject({ error: null, data: staged.data });

    const orderedRequestConflict = await admin.rpc("stage_pipeline_batch", {
      ...stageArgs,
      p_entries: [{ ...entry, photo_paths: [...entry.photo_paths].reverse() }],
    });
    expect(orderedRequestConflict.error).toMatchObject({ code: "23514" });

    const [{ data: item }, { data: run }, { data: reservation }] = await Promise.all([
      seller.client
        .from("items")
        .select("photo_identity_kind, photo_identity_fingerprint")
        .eq("id", receipt.item_id)
        .single(),
      seller.client
        .from("pipeline_runs")
        .select("photo_identity_kind, photo_identity_fingerprint")
        .eq("id", receipt.run_id)
        .single(),
      seller.client
        .from("ai_item_credit_reservations")
        .select("photo_identity_kind, photo_identity_fingerprint")
        .eq("pipeline_run_id", receipt.run_id)
        .single(),
    ]);

    const expectedIdentity = {
      photo_identity_kind: PHOTO_SET_KIND,
      photo_identity_fingerprint: PHOTO_SET_FINGERPRINT,
    };
    expect(item).toEqual(expectedIdentity);
    expect(run).toEqual(expectedIdentity);
    expect(reservation).toEqual(expectedIdentity);

    const mutation = await seller.client
      .from("items")
      .update({ photo_identity_fingerprint: "f".repeat(64) })
      .eq("id", receipt.item_id);
    expect(mutation.error).toMatchObject({ code: "23514" });
  });

  it("rejects a verified replay after it blocks behind an uncommitted legacy winner", async () => {
    if (!reachable) return;
    const idempotencyKey = `photo-identity-race-${crypto.randomUUID()}`;
    const batchId = crypto.randomUUID();
    const photoPath = `${concurrentSeller.id}/verified/race.jpg`;
    const winner = await connectDatabase("issue-333-legacy-winner");
    const loser = await connectDatabase("issue-333-verified-loser");
    const observer = await connectDatabase("issue-333-lock-observer");

    try {
      await winner.query("begin");
      await assumeServiceRole(winner);
      const winnerPid = (
        await winner.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]!.pid;
      const staged = await winner.query<{
        item_id: string;
        queue_message_id: string;
        run_id: string;
      }>(
        `select item_id, queue_message_id::text, run_id
         from public.stage_pipeline_batch(
           $1,
           $2::uuid,
           jsonb_build_array(jsonb_build_object(
             'idempotency_key', $3::text,
             'source', 'single',
             'autopilot_enabled', false,
             'photo_paths', jsonb_build_array($4::text),
             'cost_basis', null
           )),
           10,
           10
         )`,
        [concurrentSeller.id, batchId, idempotencyKey, photoPath],
      );
      const receipt = staged.rows[0]!;
      queueMessageIds.add(receipt.queue_message_id);

      await loser.query("begin");
      await assumeServiceRole(loser);
      const loserPid = (
        await loser.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]!.pid;
      const loserOutcome = loser.query(
        `select * from public.stage_pipeline_batch(
           $1,
           $2::uuid,
           jsonb_build_array(jsonb_build_object(
             'idempotency_key', $3::text,
             'source', 'single',
             'autopilot_enabled', false,
             'photo_paths', jsonb_build_array($4::text),
             'cost_basis', null
           )),
           10,
           10,
           jsonb_build_array(jsonb_build_object(
             'idempotency_key', $3::text,
             'photo_identity_kind', 'content_sha256_set_v1',
             'photo_identity_fingerprint', $5::text
           ))
         )`,
        [
          concurrentSeller.id,
          batchId,
          idempotencyKey,
          photoPath,
          PHOTO_SET_FINGERPRINT,
        ],
      ).then(
        (value) => ({ error: null, value }),
        (error: unknown) => ({ error, value: null }),
      );

      await waitForAdvisoryBlock(observer, loserPid, winnerPid);
      await winner.query("commit");

      const loserResult = await loserOutcome;
      expect(loserResult.value).toBeNull();
      expect(loserResult.error).toMatchObject({ code: "23514" });
      await loser.query("rollback");

      const durable = await observer.query<{
        items: number;
        legacy_runs: number;
        queue_messages: number;
        reservations: number;
        usage_reservations: number;
      }>(
        `select
           (select count(*)::integer from public.items
            where user_id = $1) as items,
           (select count(*)::integer from public.pipeline_runs
            where user_id = $1
              and idempotency_key = $2
              and photo_identity_kind = 'legacy_path_v0') as legacy_runs,
           (select count(*)::integer from pgmq.q_pipeline_jobs
            where msg_id = $3::bigint) as queue_messages,
           (select count(*)::integer
            from public.ai_item_credit_reservations
            where pipeline_run_id = $4::uuid) as reservations,
           (select count(*)::integer
            from private.pipeline_run_usage_reservations
            where run_id = $4::uuid) as usage_reservations`,
        [
          concurrentSeller.id,
          idempotencyKey,
          receipt.queue_message_id,
          receipt.run_id,
        ],
      );
      expect(durable.rows[0]).toEqual({
        items: 1,
        legacy_runs: 1,
        queue_messages: 1,
        reservations: 1,
        usage_reservations: 1,
      });
    } finally {
      await winner.query("rollback").catch(() => undefined);
      await loser.query("rollback").catch(() => undefined);
      await Promise.all([winner.end(), loser.end(), observer.end()]);
    }
  });
});
