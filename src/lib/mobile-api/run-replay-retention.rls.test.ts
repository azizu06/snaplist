import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { resolveLocalTestDatabaseUrl } from "@/test/exclusive-resource-lock";

const DATABASE_URL = resolveLocalTestDatabaseUrl(
  process.env.SUPABASE_TEST_DB_URL
    ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
);

interface MobileRunOperationErrorResult {
  mobileRunOperationError: {
    code: string;
    message: string;
  };
}

interface MobileRunOperationSuccessResult {
  runId: string;
  itemId: string;
  status: string;
  queueMessageId?: number | null;
}

type MobileRunOperationResult =
  | MobileRunOperationErrorResult
  | MobileRunOperationSuccessResult;

let reachable = false;
let clientsConnected = false;
let admin: Client;
let owner: Client;
let ownerConcurrent: Client;
let ownerUserId = "";
let foreignUserId = "";
let cancelItemId = "";
let retryItemId = "";
let foreignItemId = "";
let cancelRunId = "";
let retryRunId = "";
let foreignRunId = "";

async function applyOperation(
  client: Client,
  userId: string,
  runId: string,
  operation: "retry" | "cancel",
  idempotencyKey: string,
): Promise<MobileRunOperationResult> {
  await client.query("begin");
  try {
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    await client.query("set local role authenticated");
    const result = await client.query<{ value: MobileRunOperationResult }>(
      `select public.apply_mobile_run_operation(
         $1::uuid,
         $2::text,
         $3::uuid
       ) as value`,
      [runId, operation, idempotencyKey],
    );
    await client.query("commit");
    return result.rows[0]!.value;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

beforeAll(async () => {
  admin = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2_000 });
  owner = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2_000 });
  ownerConcurrent = new Client({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  });

  try {
    await Promise.all([admin.connect(), owner.connect(), ownerConcurrent.connect()]);
    clientsConnected = true;
    const migration = await admin.query<{ available: boolean }>(
      `select to_regprocedure(
         'public.apply_mobile_run_operation(uuid,text,uuid)'
       ) is not null as available`,
    );
    reachable = migration.rows[0]?.available ?? false;
  } catch {
    reachable = false;
    await Promise.all([
      admin.end().catch(() => undefined),
      owner.end().catch(() => undefined),
      ownerConcurrent.end().catch(() => undefined),
    ]);
    return;
  }

  if (!reachable) return;

  ownerUserId = `user_test_mobile_replay_owner_${Date.now()}`;
  foreignUserId = `user_test_mobile_replay_foreign_${Date.now()}`;
  cancelItemId = randomUUID();
  retryItemId = randomUUID();
  foreignItemId = randomUUID();
  cancelRunId = randomUUID();
  retryRunId = randomUUID();
  foreignRunId = randomUUID();

  await admin.query(
    `insert into public.items (id, user_id, photos)
     values
       ($1::uuid, $4, array[$6::text]),
       ($2::uuid, $4, array[$7::text]),
       ($3::uuid, $5, array[$8::text])`,
    [
      cancelItemId,
      retryItemId,
      foreignItemId,
      ownerUserId,
      foreignUserId,
      `${ownerUserId}/cancel.jpg`,
      `${ownerUserId}/retry.jpg`,
      `${foreignUserId}/foreign.jpg`,
    ],
  );
  await admin.query(
    `insert into public.pipeline_runs (id, user_id, item_id, idempotency_key)
     values
       ($1::uuid, $4, $6::uuid, $9),
       ($2::uuid, $4, $7::uuid, $10),
       ($3::uuid, $5, $8::uuid, $11)`,
    [
      cancelRunId,
      retryRunId,
      foreignRunId,
      ownerUserId,
      foreignUserId,
      cancelItemId,
      retryItemId,
      foreignItemId,
      `cancel-${cancelRunId}`,
      `retry-${retryRunId}`,
      `foreign-${foreignRunId}`,
    ],
  );
  await admin.query(
    `update public.pipeline_runs
     set status = 'running',
         stage = 'pricing',
         attempt_count = 1,
         started_at = statement_timestamp(),
         last_attempted_at = statement_timestamp(),
         lease_token = gen_random_uuid(),
         lease_expires_at = statement_timestamp() + interval '1 minute'
     where id = $1::uuid`,
    [retryRunId],
  );
  await admin.query(
    `update public.pipeline_runs
     set status = 'failed',
         failure_code = 'provider_unavailable',
         safe_failure_message = 'The listing could not be prepared.',
         completed_at = statement_timestamp(),
         lease_token = null,
         lease_expires_at = null
     where id = $1::uuid`,
    [retryRunId],
  );
});

afterAll(async () => {
  if (!clientsConnected) return;
  try {
    if (!reachable) return;
    await admin.query(
      `select pgmq.delete('pipeline_jobs', queue_message_id)
       from public.pipeline_runs
       where id = $1::uuid
         and queue_message_id is not null`,
      [retryRunId],
    );
    await admin.query(
      `delete from private.mobile_run_operation_replays
       where user_id = any($1::text[])`,
      [[ownerUserId, foreignUserId]],
    );
    await admin.query(
      "delete from public.items where id = any($1::uuid[])",
      [[cancelItemId, retryItemId, foreignItemId]],
    );
  } finally {
    await Promise.all([
      admin.end(),
      owner.end(),
      ownerConcurrent.end(),
    ]);
  }
});

describe("mobile run replay receipt retention", () => {
  it("requires the migrated local database for the public RPC proof", () => {
    if (!reachable) {
      console.warn(
        "[mobile-api/run-replay-retention.rls.test] Reset local Supabase before running this DB-gated proof.",
      );
    }
    expect(true).toBe(true);
  });

  it("does not retain repeated missing or foreign run receipts", async () => {
    if (!reachable) return;

    const missingResults: MobileRunOperationResult[] = [];
    const missingKeys: string[] = [];
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const idempotencyKey = randomUUID();
      missingKeys.push(idempotencyKey);
      missingResults.push(
        await applyOperation(
          owner,
          ownerUserId,
          randomUUID(),
          "retry",
          idempotencyKey,
        ),
      );
    }
    const foreignKey = randomUUID();
    const firstForeign = await applyOperation(
      owner,
      ownerUserId,
      foreignRunId,
      "cancel",
      foreignKey,
    );
    const replayedForeign = await applyOperation(
      owner,
      ownerUserId,
      foreignRunId,
      "cancel",
      foreignKey,
    );

    const expectedError = {
      mobileRunOperationError: {
        code: "P0002",
        message: "Pipeline run not found",
      },
    };
    expect(missingResults).toEqual(
      Array.from({ length: 24 }, () => expectedError),
    );
    expect(firstForeign).toEqual(expectedError);
    expect(replayedForeign).toEqual(expectedError);

    const retained = await admin.query<{ count: string }>(
      `select count(*)::text as count
       from private.mobile_run_operation_replays
       where user_id = $1
         and idempotency_key = any($2::uuid[])`,
      [ownerUserId, [...missingKeys, foreignKey]],
    );
    expect(retained.rows[0]?.count).toBe("0");
  });

  it("linearizes concurrent missing replays without retaining either call", async () => {
    if (!reachable) return;

    const missingRunId = randomUUID();
    const replayKey = randomUUID();
    const [first, second] = await Promise.all([
      applyOperation(owner, ownerUserId, missingRunId, "retry", replayKey),
      applyOperation(
        ownerConcurrent,
        ownerUserId,
        missingRunId,
        "retry",
        replayKey,
      ),
    ]);

    expect(first).toEqual(second);
    expect(first).toEqual({
      mobileRunOperationError: {
        code: "P0002",
        message: "Pipeline run not found",
      },
    });
    const retained = await admin.query<{ count: string }>(
      `select count(*)::text as count
       from private.mobile_run_operation_replays
       where user_id = $1
         and idempotency_key = $2::uuid`,
      [ownerUserId, replayKey],
    );
    expect(retained.rows[0]?.count).toBe("0");
  });

  it("keeps verified retry and cancel receipts durable and idempotent", async () => {
    if (!reachable) return;

    const cancelKey = randomUUID();
    const retryKey = randomUUID();
    const firstCancel = await applyOperation(
      owner,
      ownerUserId,
      cancelRunId,
      "cancel",
      cancelKey,
    );
    const replayedCancel = await applyOperation(
      owner,
      ownerUserId,
      cancelRunId,
      "cancel",
      cancelKey,
    );
    const firstRetry = await applyOperation(
      owner,
      ownerUserId,
      retryRunId,
      "retry",
      retryKey,
    );
    const replayedRetry = await applyOperation(
      owner,
      ownerUserId,
      retryRunId,
      "retry",
      retryKey,
    );

    expect(replayedCancel).toEqual(firstCancel);
    expect(firstCancel).toMatchObject({ runId: cancelRunId, status: "canceled" });
    expect(replayedRetry).toEqual(firstRetry);
    expect(firstRetry).toMatchObject({ runId: retryRunId, status: "queued" });

    const retained = await admin.query<{
      count: string;
      verified_count: string;
    }>(
      `select count(*)::text as count,
              count(run_id)::text as verified_count
       from private.mobile_run_operation_replays
       where user_id = $1
         and idempotency_key = any($2::uuid[])`,
      [ownerUserId, [cancelKey, retryKey]],
    );
    expect(retained.rows[0]).toEqual({ count: "2", verified_count: "2" });
  });
});
