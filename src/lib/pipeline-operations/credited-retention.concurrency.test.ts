import { randomUUID } from "node:crypto";
import { Client, DatabaseError } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { resolveLocalTestDatabaseUrl } from "@/test/exclusive-resource-lock";

const DATABASE_URL = resolveLocalTestDatabaseUrl(
  process.env.SUPABASE_TEST_DB_URL ??
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
);

interface CreditedRunFixture {
  itemId: string;
  initialPhotos: string[];
  queueMessageId: string;
  reservationBefore: Record<string, unknown>;
  runId: string;
  userId: string;
}

const fixtureItemIds = new Set<string>();
const queueMessageIds = new Set<string>();

async function connect(applicationName: string): Promise<Client> {
  const client = new Client({
    application_name: applicationName,
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 1_000,
  });
  await client.connect();
  await client.query("set statement_timeout = '10s'");
  return client;
}

async function localDatabaseReachable(): Promise<boolean> {
  const client = new Client({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 500,
  });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function assumeRole(
  client: Client,
  role: "authenticated" | "service_role",
  userId?: string,
): Promise<void> {
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ role, ...(userId ? { sub: userId } : {}) }),
  ]);
  await client.query(`set local role ${role}`);
}

async function stageCreditedRun(label: string): Promise<CreditedRunFixture> {
  const client = await connect(`issue-227-stage-${label}`);
  const userId = `issue-227-${label}-${randomUUID()}`;
  const photo = `${userId}/items/front.jpg`;

  try {
    await client.query("begin");
    await assumeRole(client, "service_role");
    const staged = await client.query<{
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
         100,
         100
       )`,
      [userId, randomUUID(), `issue-227-${label}`, photo],
    );
    const row = staged.rows[0];
    if (!row) throw new Error("Credited retention fixture did not stage");

    await client.query("reset role");
    await client.query(
      `update public.pipeline_runs
       set status = 'running',
           stage = 'identifying',
           attempt_count = 1,
           started_at = statement_timestamp(),
           last_attempted_at = statement_timestamp(),
           lease_token = gen_random_uuid(),
           lease_expires_at = statement_timestamp() + interval '5 minutes'
       where id = $1::uuid`,
      [row.run_id],
    );

    const reservation = await client.query<{ value: Record<string, unknown> }>(
      `select to_jsonb(reservation) as value
       from public.ai_item_credit_reservations reservation
       where reservation.pipeline_run_id = $1::uuid`,
      [row.run_id],
    );
    await client.query("commit");

    fixtureItemIds.add(row.item_id);
    queueMessageIds.add(row.queue_message_id);
    return {
      itemId: row.item_id,
      initialPhotos: [photo],
      queueMessageId: row.queue_message_id,
      reservationBefore: reservation.rows[0]?.value ?? {},
      runId: row.run_id,
      userId,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function failAndAgeRun(fixture: CreditedRunFixture): Promise<void> {
  const client = await connect("issue-227-fail-and-age");
  try {
    await client.query("begin");
    await client.query(
      `update public.pipeline_runs
       set status = 'failed',
           failure_code = 'provider_unavailable',
           safe_failure_message = 'The listing could not be prepared.',
           completed_at = statement_timestamp(),
           lease_token = null,
           lease_expires_at = null
       where id = $1::uuid`,
      [fixture.runId],
    );
    await client.query(
      `update public.pipeline_runs
       set completed_at = statement_timestamp() - interval '31 days',
           started_at = statement_timestamp() - interval '31 days',
           last_attempted_at = statement_timestamp() - interval '31 days'
       where id = $1::uuid`,
      [fixture.runId],
    );
    const reservation = await client.query<{ value: Record<string, unknown> }>(
      `select to_jsonb(reservation) as value
       from public.ai_item_credit_reservations reservation
       where reservation.pipeline_run_id = $1::uuid`,
      [fixture.runId],
    );
    fixture.reservationBefore = reservation.rows[0]?.value ?? {};
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function backendPid(client: Client): Promise<number> {
  const result = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
  return result.rows[0]!.pid;
}

async function waitForBlockingLock(
  observer: Client,
  blockedPid: number,
): Promise<{ blockers: number[]; waitEventType: string | null }> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{
      blockers: number[];
      wait_event_type: string | null;
    }>(
      `select pg_blocking_pids($1) as blockers, wait_event_type
       from pg_stat_activity
       where pid = $1`,
      [blockedPid],
    );
    const row = result.rows[0];
    if (row && row.blockers.length > 0) {
      return {
        blockers: row.blockers,
        waitEventType: row.wait_event_type,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Backend ${blockedPid} never entered a blocking lock wait`);
}

async function readFixtureState(fixture: CreditedRunFixture) {
  const client = await connect("issue-227-read-state");
  try {
    const result = await client.query<{
      photos: string[];
      reservation: Record<string, unknown>;
      retention_cleaned_at: string | null;
      status: string;
    }>(
      `select
         item.photos,
         to_jsonb(reservation) as reservation,
         run.retention_cleaned_at,
         run.status
       from public.pipeline_runs run
       join public.items item on item.id = run.item_id
       join public.ai_item_credit_reservations reservation
         on reservation.pipeline_run_id = run.id
       where run.id = $1::uuid`,
      [fixture.runId],
    );
    return result.rows[0]!;
  } finally {
    await client.end();
  }
}

afterAll(async () => {
  if (!(await localDatabaseReachable())) return;
  const client = await connect("issue-227-cleanup");
  try {
    await client.query("begin");
    await assumeRole(client, "service_role");
    for (const messageId of queueMessageIds) {
      await client.query("select public.ack_pipeline_message($1::bigint)", [
        messageId,
      ]);
    }
    await client.query("reset role");
    await client.query(
      `delete from private.pipeline_storage_cleanup_jobs
       where source_id = any($1::uuid[])`,
      [[...fixtureItemIds]],
    );
    await client.query("delete from public.items where id = any($1::uuid[])", [
      [...fixtureItemIds],
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
});

describe.runIf(await localDatabaseReachable())(
  "credited pipeline retention transaction fencing",
  () => {
    it("lets a locked retry win and makes retention preserve the photo set", async () => {
      const fixture = await stageCreditedRun("retry-wins");
      await failAndAgeRun(fixture);
      const retry = await connect("issue-227-retry-wins");
      const retention = await connect("issue-227-retention-skips");

      try {
        await retry.query("begin");
        await retry.query(
          `select pg_advisory_xact_lock(
             hashtextextended('snaplist:pipeline-retention', 0)
           )`,
        );

        await retention.query("begin");
        await assumeRole(retention, "service_role");
        const retained = await retention.query<{ value: Record<string, unknown> }>(
          "select public.prepare_pipeline_retention(100) as value",
        );
        await retention.query("commit");
        expect(retained.rows[0]?.value.skippedForLock).toBe(true);
        expect(retained.rows[0]?.value.storageJobsQueued).toBe(0);

        await assumeRole(retry, "authenticated", fixture.userId);
        const retried = await retry.query<{ value: Record<string, unknown> }>(
          "select public.retry_pipeline_run($1::uuid) as value",
          [fixture.runId],
        );
        const retryMessageId = String(retried.rows[0]?.value.queueMessageId);
        queueMessageIds.add(retryMessageId);
        await retry.query("commit");

        const state = await readFixtureState(fixture);
        expect(state.status).toBe("queued");
        expect(state.photos).toEqual(fixture.initialPhotos);
        expect(state.retention_cleaned_at).toBeNull();
        expect(state.reservation).toEqual(fixture.reservationBefore);
      } finally {
        await retry.query("rollback").catch(() => undefined);
        await retention.query("rollback").catch(() => undefined);
        await Promise.all([retry.end(), retention.end()]);
      }
    });

    it("lets retention win once and makes the waiting retry fail closed", async () => {
      const fixture = await stageCreditedRun("retention-wins");
      await failAndAgeRun(fixture);
      const retention = await connect("issue-227-retention-wins");
      const retry = await connect("issue-227-retry-waits");
      const observer = await connect("issue-227-lock-observer");

      try {
        await retention.query("begin");
        await assumeRole(retention, "service_role");
        const retained = await retention.query<{ value: Record<string, unknown> }>(
          "select public.prepare_pipeline_retention(100) as value",
        );
        expect(retained.rows[0]?.value.storageJobsQueued).toBe(1);

        await retry.query("begin");
        await assumeRole(retry, "authenticated", fixture.userId);
        const retryPid = await backendPid(retry);
        const retryPromise = retry
          .query("select public.retry_pipeline_run($1::uuid)", [fixture.runId])
          .then(
            () => null,
            (error: unknown) => error,
          );
        const lockEvidence = await waitForBlockingLock(observer, retryPid);
        expect(lockEvidence.waitEventType).toBe("Lock");
        expect(lockEvidence.blockers).not.toHaveLength(0);

        await retention.query("commit");
        const retryError = await retryPromise;
        expect(retryError).toBeInstanceOf(DatabaseError);
        if (!(retryError instanceof DatabaseError)) {
          throw new Error("Waiting retry unexpectedly succeeded");
        }
        expect(retryError.code).toBe("55000");
        expect(retryError.message).toBe(
          "This saved run has expired. Start a new capture.",
        );
        await retry.query("rollback");

        const state = await readFixtureState(fixture);
        expect(state.status).toBe("failed");
        expect(state.photos).toEqual([]);
        expect(state.retention_cleaned_at).not.toBeNull();
        expect(state.reservation).toEqual(fixture.reservationBefore);
      } finally {
        await retention.query("rollback").catch(() => undefined);
        await retry.query("rollback").catch(() => undefined);
        await Promise.all([retention.end(), retry.end(), observer.end()]);
      }
    });

    it("allows an in-flight settlement while retention sees the active run and no-ops", async () => {
      const fixture = await stageCreditedRun("settlement-overlap");
      const settlement = await connect("issue-227-settlement");
      const retention = await connect("issue-227-settlement-retention");
      const listingId = randomUUID();

      try {
        await settlement.query("begin");
        await settlement.query(
          `update public.items
           set attributes = '{"brand":"protected"}'::jsonb,
               condition = 'good',
               identification = '{"label":"Protected item","confident":true}'::jsonb
           where id = $1::uuid`,
          [fixture.itemId],
        );
        await settlement.query(
          `insert into public.prediction_logs (
             user_id, item_id, run_id, extracted_attrs, price, price_range,
             confidence, tier_fired, model, listing_model, sources,
             autopilot_enabled, autopilot_eligible
           ) values (
             $1, $2::uuid, $3::uuid, '{"brand":"protected"}'::jsonb,
             100, '{"min":90,"max":110}'::jsonb, 0.9, 'llm-only',
             'test-vision', 'test-listing', '[]'::jsonb, false, false
           )`,
          [fixture.userId, fixture.itemId, fixture.runId],
        );
        await settlement.query(
          `insert into public.listings (
             id, user_id, item_id, platform, title, description, copy, status, run_id
           ) values (
             $1::uuid, $2, $3::uuid, 'ebay', 'Protected item',
             'Protected successful listing retained by issue 227.',
             '{"itemSpecifics":{"Brand":"protected"}}'::jsonb,
             'draft', $4::uuid
           )`,
          [listingId, fixture.userId, fixture.itemId, fixture.runId],
        );
        await settlement.query(
          "update public.pipeline_runs set listing_id = $1::uuid where id = $2::uuid",
          [listingId, fixture.runId],
        );
        await settlement.query(
          `update public.pipeline_runs
           set status = 'succeeded',
               stage = 'completed',
               completed_at = statement_timestamp(),
               lease_token = null,
               lease_expires_at = null
           where id = $1::uuid`,
          [fixture.runId],
        );

        await retention.query("begin");
        await assumeRole(retention, "service_role");
        const retained = await retention.query<{ value: Record<string, unknown> }>(
          "select public.prepare_pipeline_retention(100) as value",
        );
        await retention.query("commit");
        expect(retained.rows[0]?.value.storageJobsQueued).toBe(0);

        await settlement.query("commit");
        const state = await readFixtureState(fixture);
        expect(state.status).toBe("succeeded");
        expect(state.photos).toEqual(fixture.initialPhotos);
        expect(state.retention_cleaned_at).toBeNull();
        expect(state.reservation.state).toBe("settled");
        expect(state.reservation.photo_set_fingerprint).toBe(
          fixture.reservationBefore.photo_set_fingerprint,
        );
      } finally {
        await settlement.query("rollback").catch(() => undefined);
        await retention.query("rollback").catch(() => undefined);
        await Promise.all([settlement.end(), retention.end()]);
      }
    });

    it("allows an in-flight restoration while retention sees the active run and no-ops", async () => {
      const fixture = await stageCreditedRun("restoration-overlap");
      const restoration = await connect("issue-227-restoration");
      const retention = await connect("issue-227-restoration-retention");

      try {
        await restoration.query("begin");
        await restoration.query(
          `update public.pipeline_runs
           set status = 'failed',
               failure_code = 'provider_unavailable',
               safe_failure_message = 'The listing could not be prepared.',
               completed_at = statement_timestamp() - interval '31 days',
               started_at = statement_timestamp() - interval '31 days',
               last_attempted_at = statement_timestamp() - interval '31 days',
               lease_token = null,
               lease_expires_at = null
           where id = $1::uuid`,
          [fixture.runId],
        );

        await retention.query("begin");
        await assumeRole(retention, "service_role");
        const retained = await retention.query<{ value: Record<string, unknown> }>(
          "select public.prepare_pipeline_retention(100) as value",
        );
        await retention.query("commit");
        expect(retained.rows[0]?.value.storageJobsQueued).toBe(0);

        await restoration.query("commit");
        const state = await readFixtureState(fixture);
        expect(state.status).toBe("failed");
        expect(state.photos).toEqual(fixture.initialPhotos);
        expect(state.retention_cleaned_at).toBeNull();
        expect(state.reservation.state).toBe("restored");
        expect(state.reservation.photo_set_fingerprint).toBe(
          fixture.reservationBefore.photo_set_fingerprint,
        );
      } finally {
        await restoration.query("rollback").catch(() => undefined);
        await retention.query("rollback").catch(() => undefined);
        await Promise.all([restoration.end(), retention.end()]);
      }
    });
  },
);
