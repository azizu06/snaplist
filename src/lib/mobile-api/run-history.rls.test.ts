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

const OWNER_RUN_NEWER = "37500000-0000-4000-8000-000000000002";
const OWNER_RUN_MUTATED = "37500000-0000-4000-8000-000000000001";
const FOREIGN_RUN = "37500000-0000-4000-8000-000000000999";
const OWNER_ITEM_NEWER = "37500000-0000-4000-8000-000000000012";
const OWNER_ITEM_MUTATED = "37500000-0000-4000-8000-000000000011";
const FOREIGN_ITEM = "37500000-0000-4000-8000-000000000019";

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
         ($1::uuid, $4, '{"brand":"Canon","model":"AE-1"}'::jsonb, array[$6::text]),
         ($2::uuid, $4, '{"brand":"Vintage Pyrex","model":"bowl set"}'::jsonb, array[$7::text]),
         ($3::uuid, $5, '{"brand":"Foreign","model":"Run"}'::jsonb, array[$8::text])`,
      [
        OWNER_ITEM_NEWER,
        OWNER_ITEM_MUTATED,
        FOREIGN_ITEM,
        ownerId,
        foreignId,
        `${ownerId}/items/newer.jpg`,
        `${ownerId}/items/mutated.jpg`,
        `${foreignId}/items/foreign.jpg`,
      ],
    );
    await database.query(
      `insert into public.pipeline_runs (
         id, user_id, item_id, idempotency_key, updated_at
       ) values
         ($1::uuid, $4, $6::uuid, 'run-history-owner-newer', '2026-07-19T18:01:00.000Z'),
         ($2::uuid, $4, $7::uuid, 'run-history-owner-mutated', '2026-07-19T17:59:00.000Z'),
         ($3::uuid, $5, $8::uuid, 'run-history-foreign', '2026-07-19T18:02:00.000Z')`,
      [
        OWNER_RUN_NEWER,
        OWNER_RUN_MUTATED,
        FOREIGN_RUN,
        ownerId,
        foreignId,
        OWNER_ITEM_NEWER,
        OWNER_ITEM_MUTATED,
        FOREIGN_ITEM,
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
  "authenticated snapshot-stable durable-run collection",
  () => {
    it("continues owned history without repeats or skips after an unseen run updates", async () => {
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

      const firstResponse = await handle(
        new Request("http://localhost/v1/runs?limit=1", {
          headers: { authorization: `Bearer ${ownerToken}` },
        }),
      );
      expect(firstResponse.status).toBe(200);
      const first = await firstResponse.json() as {
        data: { runs: Array<{ id: string }>; nextCursor: string | null };
      };
      expect(first.data.runs.map((run) => run.id)).toEqual([OWNER_RUN_NEWER]);
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
          runs: Array<{ id: string; lastMeaningfulUpdateAt: string }>;
          nextCursor: string | null;
        };
      };

      const returnedIds = [
        ...first.data.runs.map((run) => run.id),
        ...second.data.runs.map((run) => run.id),
      ];
      expect(returnedIds).toEqual([OWNER_RUN_NEWER, OWNER_RUN_MUTATED]);
      expect(new Set(returnedIds).size).toBe(2);
      expect(returnedIds).not.toContain(FOREIGN_RUN);
      expect(second.data.runs[0]?.lastMeaningfulUpdateAt).not.toBe(
        "2026-07-19T17:59:00.000Z",
      );
      expect(second.data.nextCursor).toBeNull();
    });
  },
);
