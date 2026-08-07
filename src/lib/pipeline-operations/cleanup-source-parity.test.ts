import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveLocalTestDatabaseUrl } from "@/test/exclusive-resource-lock";
import {
  skipIfStackUnreachable,
  stackReachable,
  whenStackReachable,
} from "@/test/supabase-stack";
import { PIPELINE_CLEANUP_SOURCE_TYPES } from "./store";

/**
 * The executor parses a claimed job with `z.enum(PIPELINE_CLEANUP_SOURCE_TYPES)`,
 * so that constant is a second copy of the database's
 * `pipeline_storage_cleanup_source_check`. Two copies drift, and this one drifts
 * expensively: `claim_pipeline_storage_cleanup` mints the lease and increments
 * `attempt_count` before the response is parsed, and the parse failure escapes
 * `runPipelineMaintenance` entirely — so a source the constant does not name
 * blocks every other pending cleanup job behind it and parks its own row in
 * `running` once the attempts run out.
 *
 * Asserting the constant against itself cannot catch that. This reads the
 * constraint the database actually enforces and compares the two sets.
 */

const DATABASE_URL = resolveLocalTestDatabaseUrl();

let reachable = false;
let database: Client;

async function localDatabaseReachable(): Promise<boolean> {
  const probe = new Client({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  });
  try {
    await probe.connect();
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => undefined);
  }
}

beforeAll(async () => {
  reachable = await stackReachable({
    probe: localDatabaseReachable,
    requiredValues: [],
  });
  await whenStackReachable(reachable, async () => {
    database = new Client({
      connectionString: DATABASE_URL,
      connectionTimeoutMillis: 2_000,
    });
    await database.connect();
  });
});

afterAll(async () => {
  await whenStackReachable(reachable, () => database.end());
});

beforeEach((context) => {
  skipIfStackUnreachable(context, reachable);
});

describe("pipeline storage cleanup source types", () => {
  it("names exactly the sources the database CHECK constraint accepts", async () => {
    const { rows } = await database.query<{ definition: string }>(
      `select pg_get_constraintdef(source_check.oid) definition
       from pg_constraint source_check
       where source_check.conname = 'pipeline_storage_cleanup_source_check'
         and source_check.conrelid
             = 'private.pipeline_storage_cleanup_jobs'::regclass`,
    );
    expect(rows).toHaveLength(1);

    // `pg_get_constraintdef` normalises both `in (...)` and `= any (array[...])`
    // to the same quoted-literal list, so the parse holds across either spelling.
    const accepted = [...rows[0]!.definition.matchAll(/'([a-z_]+)'::text/g)]
      .map((match) => match[1]!);
    expect(accepted.length).toBeGreaterThan(0);

    expect([...accepted].sort()).toEqual([...PIPELINE_CLEANUP_SOURCE_TYPES].sort());
  });
});
