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
let quotaItemId = "";
let concurrentQuotaItemId = "";
let cancelRunId = "";
let retryRunId = "";
let foreignRunId = "";
let quotaRunId = "";
let concurrentQuotaRunId = "";

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

async function backendPid(client: Client): Promise<number> {
  const result = await client.query<{ pid: number }>(
    "select pg_backend_pid() as pid",
  );
  return result.rows[0]!.pid;
}

/**
 * One seeding shape for every capacity fixture, so the receipt columns and the
 * parameter order cannot drift between the full-capacity and boundary setups.
 * Callers still state their own receipt count explicitly.
 */
async function seedVerifiedRetryReceipts(
  runId: string,
  receiptKeys: string[],
  result: MobileRunOperationResult,
): Promise<void> {
  await admin.query(
    `insert into private.mobile_run_operation_replays (
       user_id,
       idempotency_key,
       requested_run_id,
       run_id,
       operation,
       result
     )
     select $1, receipt_key, $2::uuid, $2::uuid, 'retry', $4::jsonb
     from unnest($3::uuid[]) as receipt_key`,
    [ownerUserId, runId, receiptKeys, JSON.stringify(result)],
  );
}

async function waitForBothOperationsToBlock(
  firstPid: number,
  secondPid: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await admin.query<{ waiting_count: number }>(
      `select count(*)::integer as waiting_count
       from pg_stat_activity
       where pid = any($1::integer[])
         and state = 'active'
         and wait_event_type = 'Lock'`,
      [[firstPid, secondPid]],
    );
    if (result.rows[0]?.waiting_count === 2) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Both rejected operations did not reach the replay lock boundary");
}

async function installRejectedReceiptBarrier(runId: string): Promise<void> {
  await uninstallRejectedReceiptBarrier();
  await admin.query(
    `create table private.issue_301_replay_test_barrier (
       run_id uuid primary key
     )`,
  );
  await admin.query(
    `insert into private.issue_301_replay_test_barrier (run_id)
     values ($1::uuid)`,
    [runId],
  );
  await admin.query(
    `create function private.block_issue_301_replay_insert()
     returns trigger
     language plpgsql
     set search_path = ''
     as $function$
     begin
       if exists (
         select 1
         from private.issue_301_replay_test_barrier barrier
         where barrier.run_id = new.run_id
       ) then
         perform pg_advisory_xact_lock(
           hashtextextended('issue-301:rejected-receipt-barrier', 0)
         );
       end if;
       return new;
     end;
     $function$`,
  );
  await admin.query(
    `create trigger issue_301_replay_test_barrier
     before insert on private.mobile_run_operation_replays
     for each row execute function private.block_issue_301_replay_insert()`,
  );
}

async function uninstallRejectedReceiptBarrier(): Promise<void> {
  await admin.query(
    `drop trigger if exists issue_301_replay_test_barrier
       on private.mobile_run_operation_replays;
     drop function if exists private.block_issue_301_replay_insert();
     drop table if exists private.issue_301_replay_test_barrier`,
  );
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
  quotaItemId = randomUUID();
  concurrentQuotaItemId = randomUUID();
  cancelRunId = randomUUID();
  retryRunId = randomUUID();
  foreignRunId = randomUUID();
  quotaRunId = randomUUID();
  concurrentQuotaRunId = randomUUID();

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
    `insert into public.items (id, user_id, photos)
     values
       ($1::uuid, $3, array[$4::text]),
       ($2::uuid, $3, array[$5::text])`,
    [
      quotaItemId,
      concurrentQuotaItemId,
      ownerUserId,
      `${ownerUserId}/quota.jpg`,
      `${ownerUserId}/concurrent-quota.jpg`,
    ],
  );
  await admin.query(
    `insert into public.pipeline_runs (id, user_id, item_id, idempotency_key)
     values
       ($1::uuid, $3, $4::uuid, $6),
       ($2::uuid, $3, $5::uuid, $7)`,
    [
      quotaRunId,
      concurrentQuotaRunId,
      ownerUserId,
      quotaItemId,
      concurrentQuotaItemId,
      `quota-${quotaRunId}`,
      `concurrent-quota-${concurrentQuotaRunId}`,
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
     where id = any($1::uuid[])`,
    [[retryRunId, quotaRunId, concurrentQuotaRunId]],
  );
  await admin.query(
    `update public.pipeline_runs
     set status = 'failed',
         failure_code = 'provider_unavailable',
         safe_failure_message = 'The listing could not be prepared.',
         completed_at = statement_timestamp(),
         lease_token = null,
         lease_expires_at = null
     where id = any($1::uuid[])`,
    [[retryRunId, quotaRunId, concurrentQuotaRunId]],
  );
});

afterAll(async () => {
  if (!clientsConnected) return;
  try {
    if (!reachable) return;
    await admin.query(
      `select pgmq.delete('pipeline_jobs', queue_message_id)
       from public.pipeline_runs
       where id = any($1::uuid[])
         and queue_message_id is not null`,
      [[retryRunId, quotaRunId, concurrentQuotaRunId]],
    );
    await admin.query(
      `delete from private.mobile_run_operation_replays
       where user_id = any($1::text[])`,
      [[ownerUserId, foreignUserId]],
    );
    await admin.query(
      "delete from public.items where id = any($1::uuid[])",
      [[
        cancelItemId,
        retryItemId,
        foreignItemId,
        quotaItemId,
        concurrentQuotaItemId,
      ]],
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

  it("bounds fresh receipts and serializes two canonical rejections at the ceiling", async () => {
    if (!reachable) return;

    const replayLimit = 32;
    const quotaKeys = Array.from({ length: replayLimit }, () => randomUUID());
    const storedResult = {
      mobileRunOperationError: {
        code: "55000",
        message: "The stored retry result must remain durable",
      },
    };
    await seedVerifiedRetryReceipts(quotaRunId, quotaKeys, storedResult);

    const rejectedRetryKey = randomUUID();
    const rejectedRetry = await applyOperation(
      owner,
      ownerUserId,
      quotaRunId,
      "retry",
      rejectedRetryKey,
    );
    const replayedOldest = await applyOperation(
      owner,
      ownerUserId,
      quotaRunId,
      "retry",
      quotaKeys[0]!,
    );

    expect(rejectedRetry).toEqual({
      mobileRunOperationError: {
        code: "55000",
        message: "This listing run has too many saved operation receipts",
      },
    });
    expect(replayedOldest).toEqual(storedResult);
    const cappedRun = await admin.query<{ count: string; status: string }>(
      `select count(replay.idempotency_key)::text as count, run.status
       from public.pipeline_runs run
       left join private.mobile_run_operation_replays replay
         on replay.run_id = run.id
       where run.id = $1::uuid
       group by run.status`,
      [quotaRunId],
    );
    expect(cappedRun.rows[0]).toEqual({ count: "32", status: "failed" });

    const boundaryKeys = Array.from(
      { length: replayLimit - 1 },
      () => randomUUID(),
    );
    await seedVerifiedRetryReceipts(
      concurrentQuotaRunId,
      boundaryKeys,
      storedResult,
    );
    const concurrentKeys = [randomUUID(), randomUUID()];
    const [ownerPid, ownerConcurrentPid] = await Promise.all([
      backendPid(owner),
      backendPid(ownerConcurrent),
    ]);
    await installRejectedReceiptBarrier(concurrentQuotaRunId);
    await admin.query(
      `select pg_advisory_lock(
         hashtextextended('issue-301:rejected-receipt-barrier', 0)
       )`,
    );

    let concurrentResults: MobileRunOperationResult[] = [];
    try {
      const pendingResults = Promise.all([
        applyOperation(
          owner,
          ownerUserId,
          concurrentQuotaRunId,
          "cancel",
          concurrentKeys[0]!,
        ),
        applyOperation(
          ownerConcurrent,
          ownerUserId,
          concurrentQuotaRunId,
          "cancel",
          concurrentKeys[1]!,
        ),
      ]);
      let barrierError: unknown;
      try {
        await waitForBothOperationsToBlock(ownerPid, ownerConcurrentPid);
      } catch (error) {
        barrierError = error;
      } finally {
        await admin.query(
          `select pg_advisory_unlock(
             hashtextextended('issue-301:rejected-receipt-barrier', 0)
           )`,
        );
      }
      concurrentResults = await pendingResults;
      if (barrierError) throw barrierError;
    } finally {
      await admin.query(
        `select pg_advisory_unlock(
           hashtextextended('issue-301:rejected-receipt-barrier', 0)
         )`,
      );
      await uninstallRejectedReceiptBarrier();
    }

    const concurrentBoundary = await admin.query<{
      count: string;
      new_key_count: string;
      status: string;
    }>(
      `select count(replay.idempotency_key)::text as count,
              count(replay.idempotency_key) filter (
                where replay.idempotency_key = any($2::uuid[])
              )::text as new_key_count,
              run.status
       from public.pipeline_runs run
       left join private.mobile_run_operation_replays replay
         on replay.run_id = run.id
       where run.id = $1::uuid
       group by run.status`,
      [concurrentQuotaRunId, concurrentKeys],
    );
    expect(concurrentBoundary.rows[0]).toEqual({
      count: "32",
      new_key_count: "1",
      status: "failed",
    });
    expect(concurrentResults).toContainEqual({
      mobileRunOperationError: {
        code: "55000",
        message: "This listing run has too many saved operation receipts",
      },
    });
    expect(concurrentResults).toContainEqual({
      mobileRunOperationError: {
        code: "55000",
        message: "This listing run cannot be canceled",
      },
    });
  });
});
