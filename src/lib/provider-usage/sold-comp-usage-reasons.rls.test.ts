import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { resolveLocalTestDatabaseUrl } from "@/test/exclusive-resource-lock";
import { skipIfStackUnreachable, stackReachable } from "@/test/supabase-stack";
import { providerUsageRecordSchema } from "./schema";

/**
 * Issue #1138 widened the sold-comp usage record with `accepted` and `reason`.
 *
 * The record lives in the existing `sold_comps` jsonb, so no table, column,
 * grant, or policy moved — which is exactly the claim worth proving rather than
 * asserting in a PR body. This suite pins three things against a real database:
 * the widened payload persists through the lease-scoped worker RPC, a tenant can
 * still only read its OWN cost row, and `reason` cannot carry free text.
 *
 * Everything runs inside a rolled-back transaction, so it leaves the shared local
 * stack exactly as it found it.
 */
const OWNER = "user_1138_owner";
const FOREIGN = "user_1138_foreign";
const ITEM_ID = "11110000-0000-4000-8000-000000001138";
const RUN_ID = "22220000-0000-4000-8000-000000001138";
const LEASE = "33330000-0000-4000-8000-000000001138";
const REVISION = "44440000-0000-4000-8000-000000001138";

function usageRecord(soldComps: unknown[]): unknown {
  return {
    schemaVersion: 1,
    modelCalls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    models: [],
    transcriptions: [],
    soldComps,
  };
}

let reachable = false;
let database: Client;

beforeEach((context) => {
  skipIfStackUnreachable(context, reachable);
});

beforeAll(async () => {
  reachable = await stackReachable();
  if (!reachable) return;
  database = new Client({
    application_name: "snaplist-1138-sold-comp-usage",
    connectionString: resolveLocalTestDatabaseUrl(),
    connectionTimeoutMillis: 2_000,
  });
  await database.connect();
  await database.query("set statement_timeout = '10s'");
});

afterAll(async () => {
  if (database) await database.end();
});

async function asServiceRole(): Promise<void> {
  await database.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ role: "service_role" }),
  ]);
  await database.query("set local role service_role");
}

async function asTenant(userId: string): Promise<void> {
  await database.query("set local role postgres");
  await database.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: userId, role: "authenticated" }),
  ]);
  await database.query("set local role authenticated");
}

async function seedLeasedRun(): Promise<void> {
  await database.query("set local role postgres");
  await database.query(
    `insert into public.items (
       id, user_id, photos, attributes, condition, identification,
       review_revision, review_content_revision,
       photo_identity_kind, photo_identity_fingerprint
     )
     values (
       $1::uuid, $2, array[$2 || '/items/photo-0.jpg'], '{"brand":"Apple"}'::jsonb,
       'good', '{"kind":"fixture"}'::jsonb, $3::uuid, $3::uuid, 'legacy_path_v0',
       encode(sha256(convert_to(
         array_to_json(array[$2 || '/items/photo-0.jpg'])::text, 'UTF8'
       )), 'hex')
     )`,
    [ITEM_ID, OWNER, REVISION],
  );
  await database.query(
    `insert into public.pipeline_runs (
       id, user_id, item_id, status, stage, idempotency_key,
       attempt_count, started_at, last_attempted_at, lease_token, lease_expires_at
     )
     values (
       $1::uuid, $2, $3::uuid, 'running', 'generating', 'issue-1138-usage', 1,
       statement_timestamp(), statement_timestamp(), $4::uuid,
       statement_timestamp() + interval '5 minutes'
     )`,
    [RUN_ID, OWNER, ITEM_ID, LEASE],
  );
}

describe("sold-comp usage reasons persist under RLS (#1138)", () => {
  beforeEach(async () => {
    await database.query("begin");
    await seedLeasedRun();
  });

  // Every test runs inside its own transaction and leaves nothing behind, so the
  // suite is safe on the shared local stack other workers are also using.
  afterEach(async () => {
    await database.query("rollback");
  });

  it("stores what the matcher accepted and why nothing survived", async () => {
    await asServiceRole();
    const usage = providerUsageRecordSchema.parse(
      usageRecord([
        {
          strategy: "apify",
          attempts: 2,
          results: 0,
          accepted: 0,
          reason: "provider-error",
          chargedUsd: 0.0002,
        },
        {
          strategy: "ebay-sold",
          attempts: 1,
          results: 0,
          accepted: 0,
          reason: "blocked",
          chargedUsd: null,
        },
      ]),
    );

    const written = await database.query<{ data: boolean }>(
      `select public.record_pipeline_run_provider_usage($1::uuid, $2::uuid, $3::jsonb) as data`,
      [RUN_ID, LEASE, JSON.stringify(usage)],
    );
    expect(written.rows[0]!.data).toBe(true);

    await asTenant(OWNER);
    const read = await database.query<{ sold_comps: unknown }>(
      `select sold_comps from public.pipeline_run_provider_usage where run_id = $1::uuid`,
      [RUN_ID],
    );
    expect(read.rows).toHaveLength(1);
    expect(read.rows[0]!.sold_comps).toEqual([
      {
        strategy: "apify",
        attempts: 2,
        results: 0,
        accepted: 0,
        reason: "provider-error",
        chargedUsd: 0.0002,
      },
      {
        strategy: "ebay-sold",
        attempts: 1,
        results: 0,
        accepted: 0,
        reason: "blocked",
        chargedUsd: null,
      },
    ]);
  });

  it("keeps the cost row readable only by the tenant that owns the run", async () => {
    await asServiceRole();
    await database.query(
      `select public.record_pipeline_run_provider_usage($1::uuid, $2::uuid, $3::jsonb)`,
      [
        RUN_ID,
        LEASE,
        JSON.stringify(
          providerUsageRecordSchema.parse(
            usageRecord([
              {
                strategy: "apify",
                attempts: 1,
                results: 9,
                accepted: 4,
                reason: null,
                chargedUsd: 0.036,
              },
            ]),
          ),
        ),
      ],
    );

    await asTenant(FOREIGN);
    const foreign = await database.query(
      `select run_id from public.pipeline_run_provider_usage where run_id = $1::uuid`,
      [RUN_ID],
    );
    expect(foreign.rows).toEqual([]);

    await asTenant(OWNER);
    const owner = await database.query(
      `select run_id from public.pipeline_run_provider_usage where run_id = $1::uuid`,
      [RUN_ID],
    );
    expect(owner.rows).toHaveLength(1);
  });

  it("refuses a reason outside the closed vocabulary, so telemetry cannot carry content", async () => {
    await asServiceRole();
    await expect(
      database.query(
        `select public.record_pipeline_run_provider_usage($1::uuid, $2::uuid, $3::jsonb)`,
        [
          RUN_ID,
          LEASE,
          JSON.stringify(
            usageRecord([
              {
                strategy: "apify",
                attempts: 1,
                results: 0,
                accepted: 0,
                // What a leak would look like: the seller's own query text.
                reason: "Apple AirPods Pro White charging case Silicone ear tips",
                chargedUsd: null,
              },
            ]),
          ),
        ],
      ),
    ).rejects.toThrow(/Invalid provider usage record/i);
  });

  it("still accepts a record written before the widening, so a queued run keeps its cost", async () => {
    await asServiceRole();
    const written = await database.query<{ data: boolean }>(
      `select public.record_pipeline_run_provider_usage($1::uuid, $2::uuid, $3::jsonb) as data`,
      [
        RUN_ID,
        LEASE,
        JSON.stringify(
          usageRecord([
            { strategy: "apify", attempts: 1, results: 9, chargedUsd: 0.036 },
          ]),
        ),
      ],
    );
    expect(written.rows[0]!.data).toBe(true);
  });
});
