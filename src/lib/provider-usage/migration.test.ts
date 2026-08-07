import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The offline companion to `supabase/tests/pipeline_run_provider_usage.test.sql`
 * (issue #716).
 *
 * The pgTAP file proves the behavior against a real database; this one runs in
 * `pnpm test` with no stack, so a change that quietly weakens the tenancy or
 * lease contract fails immediately instead of waiting for a DB-gated job that
 * skips when keys are absent.
 */
const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260806140000_pipeline_run_provider_usage.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("pipeline run provider usage migration", () => {
  it("makes the cost table tenant-owned and readable only by its owner", () => {
    expect(migration).toMatch(
      /create table public\.pipeline_run_provider_usage[\s\S]+user_id text not null/i,
    );
    expect(migration).toMatch(
      /alter table public\.pipeline_run_provider_usage enable row level security/i,
    );
    expect(migration).toMatch(
      /revoke all on table public\.pipeline_run_provider_usage\s+from public, anon, authenticated, service_role/i,
    );
    expect(migration).toMatch(
      /using \(\(select public\.clerk_user_id\(\)\) = user_id\)/i,
    );
  });

  it("gives the worker identity no direct table surface, only the run-scoped writer", () => {
    // The single grant on the table is SELECT to authenticated. A grant to
    // service_role here would be the service-role bypass ADR-0007 forbids.
    const tableGrants = migration.match(
      /grant [^;]*on table public\.pipeline_run_provider_usage[^;]*;/gi,
    );
    expect(tableGrants).toEqual([
      "grant select on table public.pipeline_run_provider_usage to authenticated;",
    ]);
    expect(migration).toMatch(
      /grant execute on function public\.record_pipeline_run_provider_usage\(uuid, uuid, jsonb\)\s+to service_role/i,
    );
  });

  it("fences the writer on the worker JWT and a live lease", () => {
    expect(migration).toMatch(
      /create or replace function public\.record_pipeline_run_provider_usage/i,
    );
    expect(migration).toMatch(/security definer[\s\S]*?set search_path = ''/i);
    expect(migration).toMatch(
      /auth\.jwt\(\)->>'role', ''\) <> 'service_role'/i,
    );
    expect(migration).toMatch(/pr\.lease_token = p_lease_token/i);
    expect(migration).toMatch(/pr\.lease_expires_at > now\(\)/i);
  });

  it("derives ownership from the stored run instead of trusting the caller", () => {
    // The writer takes no user_id or item_id parameter at all: the only way in
    // is the run it just proved a lease on.
    const signature = migration.slice(
      migration.indexOf("create or replace function public.record_pipeline_run_provider_usage"),
      migration.indexOf("returns boolean"),
    );
    expect(signature).not.toMatch(/p_user_id|p_item_id/i);
    expect(migration).toMatch(
      /select pr\.user_id, pr\.item_id\s+into v_user_id, v_item_id\s+from public\.pipeline_runs pr/i,
    );
  });

  it("refuses a payload carrying anything the record does not name", () => {
    expect(migration).toMatch(
      /p_usage - array\[[\s\S]*?'schemaVersion'[\s\S]*?'soldComps'[\s\S]*?\] <> '\{\}'::jsonb/i,
    );
    expect(migration).toMatch(/private\.provider_usage_entries_coarse/i);
  });

  it("cannot double-count a redelivered run", () => {
    expect(migration).toMatch(/on conflict \(run_id\) do nothing/i);
  });

  it("reports percentiles over completed runs and grants them to no runtime role", () => {
    expect(migration).toMatch(
      /create or replace function public\.pipeline_run_provider_usage_percentiles/i,
    );
    expect(migration).toMatch(/security invoker/i);
    expect(migration).toMatch(/r\.status = 'succeeded'/i);
    expect(migration).toMatch(/percentile_cont\(0\.5\) within group/i);
    expect(migration).toMatch(/percentile_cont\(0\.95\) within group/i);
    expect(migration).toMatch(
      /revoke all on function public\.pipeline_run_provider_usage_percentiles\(timestamptz, timestamptz\)\s+from public, anon, authenticated, service_role/i,
    );
    expect(migration).not.toMatch(
      /grant execute on function public\.pipeline_run_provider_usage_percentiles/i,
    );
  });

  it("brings the cost table under account erasure", () => {
    // A tenant table erasure neither fences nor counts is one erasure reports
    // completion over while its rows survive (#384).
    expect(migration).toMatch(
      /create trigger zzz_fence_account_erasure_tenant_mutation\s+before insert or update or delete on public\.pipeline_run_provider_usage/i,
    );
    expect(migration).toMatch(
      /create or replace function private\.account_erasure_owned_row_count[\s\S]+from public\.pipeline_run_provider_usage where user_id = p_user_id/i,
    );
  });
});
