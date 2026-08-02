import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { resolveLocalTestDatabaseUrl } from "@/test/exclusive-resource-lock";
import { skipIfStackUnreachable, stackReachable, whenStackReachable } from "@/test/supabase-stack";

/**
 * The tree-filtered half of the erasure coverage guard.
 *
 * Account erasure is only as complete as its table list, and that list is the
 * one thing a future migration can silently invalidate: add a tenant table,
 * forget the fence, and erasure keeps reporting completion while the new rows
 * survive. Neither reviewers nor the behaviour suites catch that, because a
 * table nobody wrote a test for produces no failing assertion.
 *
 * supabase/tests/account_erasure.test.sql makes the same claim against the bare
 * catalog, which is exact in CI because CI builds the database from this
 * branch's migrations alone. A long-lived local database shared between
 * worktrees is not exact — it also carries tables from branches this tree has
 * never seen — so this variant intersects the catalog with what this tree
 * actually declares, and stays meaningful while you work.
 */

const DATABASE_URL = resolveLocalTestDatabaseUrl();

const TENANT_COLUMNS = [
  "user_id",
  "guest_user_id",
  "claim_target_user_id",
  "claim_idempotency_user_id",
  "storage_path",
  "photo_paths",
];

/**
 * The erasure receipt is not tenant domain data. It is erasure's own record of
 * itself: it deliberately outlives the account so replay and the fence keep
 * answering truthfully, holds a raw user id only while erasure is unfinished,
 * and is removed by its own retention job rather than by the deletion it
 * describes. Fencing or counting it would make erasure unable to finish.
 */
const NOT_TENANT_DATA = new Set(["private.account_erasure_generations"]);

/**
 * The local database is shared with other worktrees, so it can hold tables from
 * branches this tree has never seen. Only tables this tree actually declares
 * are in scope — otherwise an unrelated in-flight migration turns this suite red
 * for a table #384 could not have known about.
 */
function tablesDeclaredInThisTree(): Set<string> {
  const declared = new Set<string>();
  const pattern = /create\s+table\s+(?:if\s+not\s+exists\s+)?(public|private)\.([a-z0-9_]+)/gi;
  for (const file of readdirSync("supabase/migrations")) {
    if (!file.endsWith(".sql")) continue;
    const sql = readFileSync(`supabase/migrations/${file}`, "utf8");
    for (const match of sql.matchAll(pattern)) {
      declared.add(`${match[1].toLowerCase()}.${match[2].toLowerCase()}`);
    }
  }
  return declared;
}

let reachable = false;
let database: Client;

beforeEach((context) => {
  skipIfStackUnreachable(context, reachable);
});

beforeAll(async () => {
  reachable = await stackReachable({
    requiredValues: [DATABASE_URL],
    probe: async () => {
      database = new Client({ connectionString: DATABASE_URL });
      await database.connect();
      return true;
    },
  });
});

afterAll(async () => {
  await whenStackReachable(reachable, () => database.end());
});

describe.runIf(DATABASE_URL)("account erasure fence coverage", () => {
  it("fences and counts every tenant table this tree declares", async () => {
    const declared = tablesDeclaredInThisTree();

    const { rows: tenantTables } = await database.query<{ qualified: string }>(
      `select distinct c.table_schema || '.' || c.table_name as qualified
       from information_schema.columns c
       join information_schema.tables t
         on t.table_schema = c.table_schema
        and t.table_name = c.table_name
        and t.table_type = 'BASE TABLE'
       where c.table_schema in ('public', 'private')
         and c.column_name = any($1::text[])
       order by 1`,
      [TENANT_COLUMNS],
    );
    const inScope = tenantTables
      .map((row) => row.qualified)
      .filter((qualified) => declared.has(qualified) && !NOT_TENANT_DATA.has(qualified));

    // A positive control: an empty set would make every assertion below pass
    // while proving nothing at all.
    expect(inScope.length).toBeGreaterThan(20);

    const { rows: fenced } = await database.query<{ qualified: string }>(
      `select n.nspname || '.' || c.relname as qualified
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
       where t.tgname = 'zzz_fence_account_erasure_tenant_mutation'`,
    );
    const fencedTables = new Set(fenced.map((row) => row.qualified));

    const { rows: [proof] } = await database.query<{ definition: string }>(
      `select pg_get_functiondef(p.oid) as definition
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'private'
         and p.proname = 'account_erasure_owned_row_count'`,
    );
    expect(proof).toBeDefined();

    const unfenced = inScope.filter((qualified) => !fencedTables.has(qualified));
    const uncounted = inScope.filter(
      (qualified) => !proof.definition.includes(`from ${qualified}`),
    );

    expect({ unfenced, uncounted }).toEqual({ unfenced: [], uncounted: [] });
  });

});
