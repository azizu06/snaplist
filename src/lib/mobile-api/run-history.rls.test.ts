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
const DATABASE_URL = resolveLocalTestDatabaseUrl(
  process.env.SUPABASE_TEST_DB_URL
    ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
);

const OWNED_RUN_HIGH = "34200000-0000-4000-8000-000000000002";
const OWNED_RUN_LOW = "34200000-0000-4000-8000-000000000001";
const FOREIGN_RUN = "34200000-0000-4000-8000-000000000999";
const OWNER_ITEM_HIGH = "34200000-0000-4000-8000-000000000012";
const OWNER_ITEM_LOW = "34200000-0000-4000-8000-000000000011";
const FOREIGN_ITEM = "34200000-0000-4000-8000-000000000019";
const UNCOMMITTED_RUN = "34200000-0000-4000-8000-000000000998";
const UNCOMMITTED_ITEM = "34200000-0000-4000-8000-000000000018";
const SHARED_UPDATED_AT = "2026-07-20T20:00:00.000Z";

let reachable = false;
let admin: SupabaseClient;
let ownerId = "";
let foreignId = "";
let ownerToken = "";

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
         ($1::uuid, $4, $6::jsonb, array[$9::text]),
         ($2::uuid, $4, $7::jsonb, array[$10::text]),
         ($3::uuid, $5, $8::jsonb, array[$11::text])`,
      [
        OWNER_ITEM_HIGH,
        OWNER_ITEM_LOW,
        FOREIGN_ITEM,
        ownerId,
        foreignId,
        JSON.stringify({ brand: "Canon", model: "AE-1" }),
        JSON.stringify({ brand: "Nikon", model: "FM2" }),
        JSON.stringify({ brand: "Foreign", model: "Run" }),
        `${ownerId}/items/high.jpg`,
        `${ownerId}/items/low.jpg`,
        `${foreignId}/items/foreign.jpg`,
      ],
    );
    await database.query(
      `insert into public.pipeline_runs (
         id, user_id, item_id, idempotency_key, updated_at
       ) values
         ($1::uuid, $4, $6::uuid, 'run-history-owner-high', $9::timestamptz),
         ($2::uuid, $4, $7::uuid, 'run-history-owner-low', $9::timestamptz),
         ($3::uuid, $5, $8::uuid, 'run-history-foreign', $9::timestamptz)`,
      [
        OWNED_RUN_HIGH,
        OWNED_RUN_LOW,
        FOREIGN_RUN,
        ownerId,
        foreignId,
        OWNER_ITEM_HIGH,
        OWNER_ITEM_LOW,
        FOREIGN_ITEM,
        SHARED_UPDATED_AT,
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
  await cleanupClerkTestUsers(admin, [ownerId, foreignId]);
});

describe.runIf(await stackReachable())(
  "authenticated durable-run history HTTP/RLS boundary",
  () => {
    it("returns only owned equal-timestamp runs and continues without repeats or skips", async () => {
      const operations = createConfiguredSupabaseMobileRunOperations({
        supabaseURL: SUPABASE_URL,
        anonKey: SECRET_API_KEY!,
      });
      const handle = createMobileApiHandler({
        async authenticate(token) {
          if (token !== ownerToken) throw new Error("forged token");
          return { userId: ownerId };
        },
        runHistory: operations,
        runOperations: operations,
        worker: { consume: async () => ({
          claimed: 0,
          succeeded: 0,
          retrying: 0,
          failed: 0,
          skipped: 0,
        }) },
        requestId: () => "req_342_history",
      });

      const firstResponse = await handle(
        new Request("http://localhost/v1/runs?limit=1", {
          headers: { authorization: `Bearer ${ownerToken}` },
        }),
      );
      expect(firstResponse.status).toBe(200);
      const first = await firstResponse.json() as {
        data: { runs: Array<{ id: string } & Record<string, unknown>>; nextCursor: string | null };
      };
      expect(first.data.runs.map((run) => run.id)).toEqual([OWNED_RUN_HIGH]);
      expect(first.data.nextCursor).toEqual(expect.any(String));
      await expect(operations.get({
        runId: OWNED_RUN_HIGH,
        userId: ownerId,
        bearerToken: ownerToken,
      })).resolves.toEqual(first.data.runs[0]);

      const secondResponse = await handle(
        new Request(
          `http://localhost/v1/runs?limit=1&cursor=${encodeURIComponent(first.data.nextCursor!)}`,
          { headers: { authorization: `Bearer ${ownerToken}` } },
        ),
      );
      expect(secondResponse.status).toBe(200);
      const second = await secondResponse.json() as {
        data: { runs: Array<{ id: string }>; nextCursor: string | null };
      };

      const returnedIds = [
        ...first.data.runs.map((run) => run.id),
        ...second.data.runs.map((run) => run.id),
      ];
      expect(returnedIds).toEqual([OWNED_RUN_HIGH, OWNED_RUN_LOW]);
      expect(new Set(returnedIds).size).toBe(2);
      expect(returnedIds).not.toContain(FOREIGN_RUN);
      expect(second.data.nextCursor).toBeNull();
    });

    it("never exposes a run before its acceptance transaction commits", async () => {
      const database = new Client({ connectionString: DATABASE_URL });
      await database.connect();
      await database.query("begin");
      try {
        await database.query(
          `insert into public.items (id, user_id, attributes, photos)
           values ($1::uuid, $2, '{"brand":"Hidden"}'::jsonb, array[$3::text])`,
          [UNCOMMITTED_ITEM, ownerId, `${ownerId}/items/uncommitted.jpg`],
        );
        await database.query(
          `insert into public.pipeline_runs (
             id, user_id, item_id, idempotency_key, updated_at
           ) values (
             $1::uuid, $2, $3::uuid, 'run-history-uncommitted',
             $4::timestamptz + interval '1 hour'
           )`,
          [UNCOMMITTED_RUN, ownerId, UNCOMMITTED_ITEM, SHARED_UPDATED_AT],
        );

        const operations = createConfiguredSupabaseMobileRunOperations({
          supabaseURL: SUPABASE_URL,
          anonKey: SECRET_API_KEY!,
        });
        const handle = createMobileApiHandler({
          async authenticate(token) {
            if (token !== ownerToken) throw new Error("forged token");
            return { userId: ownerId };
          },
          runHistory: operations,
          runOperations: operations,
          worker: { consume: async () => ({
            claimed: 0,
            succeeded: 0,
            retrying: 0,
            failed: 0,
            skipped: 0,
          }) },
          requestId: () => "req_342_uncommitted",
        });

        const response = await handle(
          new Request("http://localhost/v1/runs?limit=50", {
            headers: { authorization: `Bearer ${ownerToken}` },
          }),
        );
        expect(response.status).toBe(200);
        const history = await response.json() as {
          data: { runs: Array<{ id: string }> };
        };
        expect(history.data.runs.map((run) => run.id)).toEqual([
          OWNED_RUN_HIGH,
          OWNED_RUN_LOW,
        ]);
        expect(history.data.runs.map((run) => run.id)).not.toContain(UNCOMMITTED_RUN);
      } finally {
        await database.query("rollback").catch(() => undefined);
        await database.end();
      }
    });
  },
);
