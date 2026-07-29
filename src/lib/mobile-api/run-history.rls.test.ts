import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import {
  cleanupClerkTestUsers,
  mintUserJwt,
} from "@/lib/supabase/test-users";
import { resolveLocalTestDatabaseUrl } from "@/test/exclusive-resource-lock";
import { resolveTenantServerTestApiKey } from "@/test/supabase-test-credentials";
import { createMobileApiHandler } from "./app";
import { createConfiguredSupabaseMobileRunOperations } from "./runs";

const SUPABASE_URL =
  process.env.SUPABASE_URL
  ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  ?? "http://127.0.0.1:54321";
const SECRET_API_KEY = resolveTenantServerTestApiKey();
const CURSOR_SIGNING_SECRET = "offline-run-history-cursor-signing-secret";
const DATABASE_URL = resolveLocalTestDatabaseUrl(
  process.env.SUPABASE_TEST_DB_URL
    ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
);

const OWNER_RUN_NEWER = "37500000-0000-4000-8000-000000000002";
const OWNER_RUN_MUTATED = "37500000-0000-4000-8000-000000000001";
const FOREIGN_RUN = "37500000-0000-4000-8000-000000000999";
const FOREIGN_RUN_OLDER = "37500000-0000-4000-8000-000000000998";
const OWNER_ITEM_NEWER = "37500000-0000-4000-8000-000000000012";
const OWNER_ITEM_MUTATED = "37500000-0000-4000-8000-000000000011";
const FOREIGN_ITEM = "37500000-0000-4000-8000-000000000019";
const FOREIGN_ITEM_OLDER = "37500000-0000-4000-8000-000000000018";
const TRANSFER_RECOVERY_ID = "37500000-0000-4000-8000-000000000021";
const TRANSFER_LEASE_TOKEN = "37500000-0000-4000-8000-000000000022";

let reachable = false;
let admin: SupabaseClient;
let ownerId = "";
let foreignId = "";
let ownerToken = "";
let foreignToken = "";

async function stackReachable(): Promise<boolean> {
  if (!SECRET_API_KEY) return false;
  try {
    return (
      await fetch(`${SUPABASE_URL}/auth/v1/health`, {
        headers: { apikey: SECRET_API_KEY },
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

  ownerId = `user_test_run_history_owner_${Date.now()}`;
  foreignId = `user_test_run_history_foreign_${Date.now()}`;
  ownerToken = await mintUserJwt(ownerId);
  foreignToken = await mintUserJwt(foreignId);
  admin = createClient(SUPABASE_URL, SECRET_API_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const database = new Client({ connectionString: DATABASE_URL });
  await database.connect();
  try {
    await database.query("begin");
    await database.query(
      `insert into public.items (id, user_id, attributes, photos)
       values
         ($1::uuid, $4, '{"brand":"Canon","model":"AE-1"}'::jsonb, array[$6::text]),
         ($2::uuid, $4, '{"brand":"Vintage Pyrex","model":"bowl set"}'::jsonb, array[$7::text]),
         ($3::uuid, $5, '{"brand":"Foreign","model":"Run"}'::jsonb, array[$8::text]),
         ($9::uuid, $5, '{"brand":"Foreign","model":"Older run"}'::jsonb, array[$10::text])`,
      [
        OWNER_ITEM_NEWER,
        OWNER_ITEM_MUTATED,
        FOREIGN_ITEM,
        ownerId,
        foreignId,
        `${ownerId}/items/newer.jpg`,
        `${ownerId}/items/mutated.jpg`,
        `${foreignId}/items/foreign.jpg`,
        FOREIGN_ITEM_OLDER,
        `${foreignId}/items/foreign-older.jpg`,
      ],
    );
    await database.query(
      `insert into public.pipeline_runs (
         id, user_id, item_id, idempotency_key, updated_at
       ) values
         ($1::uuid, $4, $6::uuid, 'run-history-owner-newer', '2026-07-19T18:01:00.000Z'),
         ($2::uuid, $4, $7::uuid, 'run-history-owner-mutated', '2026-07-19T17:59:00.000Z'),
         ($3::uuid, $5, $8::uuid, 'run-history-foreign', '2026-07-19T18:02:00.000Z'),
         ($9::uuid, $5, $10::uuid, 'run-history-foreign-older', '2026-07-19T17:58:00.000Z')`,
      [
        OWNER_RUN_NEWER,
        OWNER_RUN_MUTATED,
        FOREIGN_RUN,
        ownerId,
        foreignId,
        OWNER_ITEM_NEWER,
        OWNER_ITEM_MUTATED,
        FOREIGN_ITEM,
        FOREIGN_RUN_OLDER,
        FOREIGN_ITEM_OLDER,
      ],
    );
    await database.query("commit");
  } catch (error) {
    await database.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await database.end();
  }
});

afterAll(async () => {
  if (!reachable) return;
  const database = new Client({ connectionString: DATABASE_URL });
  await database.connect();
  try {
    await database.query(
      "delete from private.guest_draft_recoveries where id = $1::uuid",
      [TRANSFER_RECOVERY_ID],
    );
  } finally {
    await database.end();
  }
  await cleanupClerkTestUsers(admin, [ownerId, foreignId]);
});

function runHistoryHandler() {
  const operations = createConfiguredSupabaseMobileRunOperations({
    supabaseURL: SUPABASE_URL,
    anonKey: SECRET_API_KEY!,
    cursorSigningSecret: CURSOR_SIGNING_SECRET,
  });
  return createMobileApiHandler({
    async authenticate(token) {
      if (token === ownerToken) return { userId: ownerId };
      if (token === foreignToken) return { userId: foreignId };
      throw new Error("forged token");
    },
    runHistory: operations,
    runOperations: operations,
    worker: {
      consume: async () => ({
        claimed: 0,
        succeeded: 0,
        retrying: 0,
        failed: 0,
        skipped: 0,
      }),
    },
    requestId: () => "req_375_run_history",
  });
}

function expectExactInstant(actual: string, expected: string): void {
  const actualInstant = Date.parse(actual);
  const expectedInstant = Date.parse(expected);
  expect(Number.isFinite(actualInstant)).toBe(true);
  expect(Number.isFinite(expectedInstant)).toBe(true);
  expect(actualInstant).toBe(expectedInstant);
}

describe.runIf(await stackReachable())(
  "authenticated snapshot-stable durable-run collection",
  () => {
    it("continues owned history without repeats or skips after an unseen run updates", async () => {
      const handle = runHistoryHandler();

      const firstResponse = await handle(
        new Request("http://localhost/v1/runs?limit=1", {
          headers: { authorization: `Bearer ${ownerToken}` },
        }),
      );
      expect(firstResponse.status).toBe(200);
      const first = await firstResponse.json() as {
        data: {
          entries: Array<{
            run: { id: string };
            logicalIdentity: { idempotencyKey: string };
            orderKey: { lastMeaningfulUpdateAt: string; runId: string };
          }>;
          nextCursor: string | null;
        };
      };
      expect(first.data.entries.map((entry) => entry.run.id)).toEqual([
        OWNER_RUN_NEWER,
      ]);
      expect(first.data.entries[0]?.logicalIdentity).toEqual({
        idempotencyKey: "run-history-owner-newer",
      });
      expect(first.data.entries[0]?.orderKey.runId).toBe(OWNER_RUN_NEWER);
      expectExactInstant(
        first.data.entries[0]!.orderKey.lastMeaningfulUpdateAt,
        "2026-07-19T18:01:00.000Z",
      );
      expect(first.data.nextCursor).toEqual(expect.any(String));

      const database = new Client({ connectionString: DATABASE_URL });
      await database.connect();
      try {
        await database.query(
          `update public.pipeline_runs
           set updated_at = statement_timestamp()
           where id = $1::uuid`,
          [OWNER_RUN_MUTATED],
        );
      } finally {
        await database.end();
      }

      const secondResponse = await handle(
        new Request(
          `http://localhost/v1/runs?limit=1&cursor=${
            encodeURIComponent(first.data.nextCursor!)
          }`,
          { headers: { authorization: `Bearer ${ownerToken}` } },
        ),
      );
      expect(secondResponse.status).toBe(200);
      const second = await secondResponse.json() as {
        data: {
          entries: Array<{
            run: { id: string; lastMeaningfulUpdateAt: string };
            logicalIdentity: { idempotencyKey: string };
            orderKey: { lastMeaningfulUpdateAt: string; runId: string };
          }>;
          nextCursor: string | null;
        };
      };

      const returnedIds = [
        ...first.data.entries.map((entry) => entry.run.id),
        ...second.data.entries.map((entry) => entry.run.id),
      ];
      expect(returnedIds).toEqual([OWNER_RUN_NEWER, OWNER_RUN_MUTATED]);
      expect(new Set(returnedIds).size).toBe(2);
      expect(returnedIds).not.toContain(FOREIGN_RUN);
      expect(second.data.entries[0]?.run.lastMeaningfulUpdateAt).not.toBe(
        "2026-07-19T17:59:00.000Z",
      );
      expect(second.data.entries[0]?.orderKey.runId).toBe(OWNER_RUN_MUTATED);
      expectExactInstant(
        second.data.entries[0]!.orderKey.lastMeaningfulUpdateAt,
        "2026-07-19T17:59:00.000Z",
      );
      expect(second.data.entries[0]?.logicalIdentity.idempotencyKey).toBe(
        "run-history-owner-mutated",
      );
      expect(second.data.nextCursor).toBeNull();
    });

    it("moves run history to the exact new tenant without old-owner visibility", async () => {
      const handle = runHistoryHandler();
      const recipientFirstResponse = await handle(
        new Request("http://localhost/v1/runs?limit=1", {
          headers: { authorization: `Bearer ${foreignToken}` },
        }),
      );
      expect(recipientFirstResponse.status).toBe(200);
      const recipientFirst = await recipientFirstResponse.json() as {
        data: {
          entries: Array<{ run: { id: string } }>;
          nextCursor: string | null;
        };
      };
      expect(recipientFirst.data.entries.map((entry) => entry.run.id)).toEqual([
        FOREIGN_RUN,
      ]);
      expect(recipientFirst.data.nextCursor).toEqual(expect.any(String));

      const database = new Client({ connectionString: DATABASE_URL });
      await database.connect();
      try {
        await database.query("begin");
        await database.query(
          `insert into private.guest_draft_recoveries (
             id, guest_user_id, pipeline_run_id, item_id, draft_id,
             reservation_id, allowance_period_id, recovery_token_hash,
             encrypted_artifact, storage_manifest, storage_object_count,
             usable_draft_at, expires_at, state, claim_target_user_id,
             claim_lease_token, claim_lease_expires_at
           ) values (
             $1::uuid, $3, $2::uuid, $4::uuid,
             '37500000-0000-4000-8000-000000000023'::uuid,
             '37500000-0000-4000-8000-000000000024'::uuid,
             '37500000-0000-4000-8000-000000000025'::uuid,
             repeat('a', 64), '{}'::jsonb, '[]'::jsonb, 1,
             statement_timestamp(), statement_timestamp() + interval '24 hours',
             'copying', $5, $6::uuid, statement_timestamp() + interval '5 minutes'
           )`,
          [
            TRANSFER_RECOVERY_ID,
            OWNER_RUN_MUTATED,
            ownerId,
            OWNER_ITEM_MUTATED,
            foreignId,
            TRANSFER_LEASE_TOKEN,
          ],
        );
        await database.query(
          "select set_config('snaplist.guest_claim_recovery_id', $1, true)",
          [TRANSFER_RECOVERY_ID],
        );
        await database.query(
          "select set_config('snaplist.guest_claim_lease_token', $1, true)",
          [TRANSFER_LEASE_TOKEN],
        );
        await database.query(
          "set constraints public.pipeline_runs_item_user_fkey deferred",
        );
        await database.query(
          `update public.items
           set user_id = $2
           where id = $1::uuid and user_id = $3`,
          [OWNER_ITEM_MUTATED, foreignId, ownerId],
        );
        await database.query(
          `update public.pipeline_runs
           set user_id = $2
           where id = $1::uuid and user_id = $3`,
          [OWNER_RUN_MUTATED, foreignId, ownerId],
        );
        await database.query("commit");
      } catch (error) {
        await database.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        await database.end();
      }

      const recipientContinuationResponse = await handle(
        new Request(
          `http://localhost/v1/runs?limit=1&cursor=${
            encodeURIComponent(recipientFirst.data.nextCursor!)
          }`,
          { headers: { authorization: `Bearer ${foreignToken}` } },
        ),
      );
      const ownerResponse = await handle(
        new Request("http://localhost/v1/runs?limit=50", {
          headers: { authorization: `Bearer ${ownerToken}` },
        }),
      );
      const foreignResponse = await handle(
        new Request("http://localhost/v1/runs?limit=50", {
          headers: { authorization: `Bearer ${foreignToken}` },
        }),
      );
      expect(recipientContinuationResponse.status).toBe(200);
      expect(ownerResponse.status).toBe(200);
      expect(foreignResponse.status).toBe(200);
      const recipientContinuation = await recipientContinuationResponse.json() as {
        data: {
          entries: Array<{ run: { id: string } }>;
          nextCursor: string | null;
        };
      };
      const owner = await ownerResponse.json() as {
        data: { entries: Array<{ run: { id: string } }> };
      };
      const foreign = await foreignResponse.json() as {
        data: { entries: Array<{ run: { id: string } }> };
      };
      expect(
        recipientContinuation.data.entries.map((entry) => entry.run.id),
      ).toEqual([FOREIGN_RUN_OLDER]);
      expect(recipientContinuation.data.nextCursor).toBeNull();
      expect(
        recipientContinuation.data.entries.map((entry) => entry.run.id),
      ).not.toContain(OWNER_RUN_MUTATED);
      expect(owner.data.entries.map((entry) => entry.run.id)).not.toContain(
        OWNER_RUN_MUTATED,
      );
      expect(foreign.data.entries.map((entry) => entry.run.id)).toContain(
        OWNER_RUN_MUTATED,
      );

      const ledger = new Client({ connectionString: DATABASE_URL });
      await ledger.connect();
      try {
        const ownership = await ledger.query(
          `select user_id, count(*)::integer as version_count
           from public.pipeline_run_history_order_versions
           where run_id = $1::uuid
           group by user_id`,
          [OWNER_RUN_MUTATED],
        );
        expect(ownership.rows).toEqual([
          { user_id: foreignId, version_count: 1 },
        ]);
      } finally {
        await ledger.end();
      }
    });
  },
);
