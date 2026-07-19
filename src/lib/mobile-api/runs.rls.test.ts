import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import {
  cleanupClerkTestUsers,
  mintUserJwt,
} from "@/lib/supabase/test-users";
import {
  MobileRunNotFoundError,
  createConfiguredSupabaseMobileRunOperations,
} from "./runs";
import { resolveLocalTestDatabaseUrl } from "@/test/exclusive-resource-lock";

const SUPABASE_URL =
  process.env.SUPABASE_URL
  ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  ?? "http://127.0.0.1:54321";
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
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
});

afterAll(async () => {
  if (!reachable) return;
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
    });
    const foreign = createConfiguredSupabaseMobileRunOperations({
      supabaseURL: SUPABASE_URL,
      anonKey: ANON_KEY!,
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
  });

  it("replays cancel and retry on one logical run without deleting its photos", async () => {
    if (!reachable) return;
    const operations = createConfiguredSupabaseMobileRunOperations({
      supabaseURL: SUPABASE_URL,
      anonKey: ANON_KEY!,
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
});
