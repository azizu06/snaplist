import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The offline companion to the post-completion half of
 * `supabase/tests/pipeline_run_provider_usage.test.sql` (issue #724).
 *
 * The pgTAP file proves the behavior against a real database. This one runs in
 * `pnpm test` with no stack, so a change that quietly restores a service-role
 * write surface on the cost table, or drops the fence that requires a correction
 * to have actually committed, fails immediately rather than waiting for a
 * DB-gated job.
 */
const MIGRATION_PATH =
  "supabase/migrations/20260813030000_post_completion_provider_usage.sql";

const migration = readFileSync(
  new URL(`../../../${MIGRATION_PATH}`, import.meta.url),
  "utf8",
);

const contract = readFileSync(
  new URL(
    "../../../supabase/tests/pipeline_run_provider_usage.test.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("post-completion provider usage migration", () => {
  it("adds no direct write surface to the cost table for any runtime role", () => {
    // The security property #716 established: `service_role` holds no
    // insert/update on this table, so every write is a run-scoped capability.
    // A grant here would be the bypass, not a fix.
    const tableGrants = migration.match(
      /grant [^;]*on table public\.pipeline_run_provider_usage[^;]*;/gi,
    );
    expect(tableGrants).toBeNull();
    expect(migration).not.toMatch(
      /grant\s+[^;]*\b(insert|update|all)\b[^;]*pipeline_run_provider_usage/i,
    );
  });

  it("exposes the post-completion writer only to the worker identity", () => {
    expect(migration).toMatch(
      /create or replace function public\.record_guided_correction_provider_usage/i,
    );
    expect(migration).toMatch(/security definer[\s\S]*?set search_path = ''/i);
    expect(migration).toMatch(
      /revoke all on function public\.record_guided_correction_provider_usage\(text, jsonb\)\s+from public, anon, authenticated/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.record_guided_correction_provider_usage\(text, jsonb\)\s+to service_role/i,
    );
  });

  it("derives tenant, item, and run from the stored capability rather than the caller", () => {
    const writer = migration.slice(
      migration.indexOf(
        "create or replace function public.record_guided_correction_provider_usage",
      ),
    );
    const signature = writer.slice(0, writer.indexOf("returns boolean"));
    // The writer takes a capability token and a usage record. Nothing else.
    expect(signature).not.toMatch(/p_run_id|p_user_id|p_item_id/i);
    expect(writer).toMatch(/v_cap\.expected_run_id/);
    expect(writer).toMatch(/stored\.user_id = v_cap\.user_id/);
    expect(writer).toMatch(/stored\.item_id = v_cap\.item_id/);
  });

  it("requires a capability whose correction already committed, inside a bounded window", () => {
    expect(migration).toMatch(/v_cap\.consumed_at is null/);
    expect(migration).toMatch(
      /v_cap\.consumed_at \+ interval '5 minutes'/,
    );
    expect(migration).toMatch(
      /v_cap\.provider_usage_recorded_at is not null/,
    );
  });

  it("leaves the lease-fenced running-path writer untouched", () => {
    expect(migration).not.toMatch(
      /create or replace function public\.record_pipeline_run_provider_usage/i,
    );
    expect(migration).not.toMatch(/lease_token/i);
  });

  it("keeps the pgTAP transactional fallback identical to the migration", () => {
    // A shared local stack that is behind this branch installs the migration
    // inside the contract's own transaction. CI runs the real file, so a drifted
    // copy would let a green local run hide a red one — unless the two are held
    // byte-identical here.
    const begin = `-- >>> BEGIN inline copy of ${MIGRATION_PATH}\n`;
    const end = `-- <<< END inline copy of ${MIGRATION_PATH}`;
    const start = contract.indexOf(begin);
    const stop = contract.indexOf(end);

    expect(start).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(start);
    expect(contract.slice(start + begin.length, stop)).toBe(migration);
  });

  it("keeps the initial measurement recoverable instead of summing it away", () => {
    expect(migration).toMatch(/add column initial_usage jsonb/i);
    expect(migration).toMatch(/coalesce\(\s*stored\.initial_usage/i);
    expect(migration).toMatch(
      /pipeline_run_provider_usage_correction_split_check/i,
    );
  });
});
