import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260728190000_trophy_wall_run_history_snapshot.sql",
  "utf8",
);

describe("Trophy Wall run-history snapshot migration", () => {
  it("records one committed ordering frontier per tenant and durable run update", () => {
    expect(migration).toMatch(
      /create table public\.pipeline_run_history_order_versions[\s\S]*revision bigint generated always as identity[\s\S]*run_id uuid not null[\s\S]*user_id text not null[\s\S]*last_meaningful_update_at timestamptz not null/i,
    );
    expect(migration).toMatch(
      /record_pipeline_run_history_order_version[\s\S]*pg_advisory_xact_lock\([\s\S]*trophy-run-order:[\s\S]*insert into public\.pipeline_run_history_order_versions/i,
    );
    expect(migration).toMatch(
      /lock table public\.pipeline_runs in share row exclusive mode[\s\S]*insert into public\.pipeline_run_history_order_versions[\s\S]*create trigger pipeline_runs_record_history_order_version[\s\S]*after insert or update on public\.pipeline_runs/i,
    );

    const transaction = migration.indexOf("\nbegin;\n");
    const ledger = migration.indexOf(
      "create table public.pipeline_run_history_order_versions",
    );
    const lock = migration.indexOf(
      "lock table public.pipeline_runs in share row exclusive mode;",
    );
    const backfill = migration.indexOf(
      "insert into public.pipeline_run_history_order_versions (",
      lock,
    );
    const trigger = migration.indexOf(
      "create trigger pipeline_runs_record_history_order_version",
    );
    const publicRpc = migration.indexOf(
      "create or replace function public.list_mobile_run_history_page",
    );
    const authenticatedGrant = migration.indexOf(
      "grant execute on function public.list_mobile_run_history_page",
    );
    const commit = migration.indexOf("\ncommit;\n");

    expect(transaction).toBeGreaterThan(-1);
    expect([...migration.matchAll(/\nbegin;\n/gu)]).toHaveLength(1);
    expect([...migration.matchAll(/\ncommit;\n/gu)]).toHaveLength(1);
    expect(ledger).toBeGreaterThan(transaction);
    expect(lock).toBeGreaterThan(transaction);
    expect(backfill).toBeGreaterThan(lock);
    expect(trigger).toBeGreaterThan(backfill);
    expect(publicRpc).toBeGreaterThan(trigger);
    expect(authenticatedGrant).toBeGreaterThan(publicRpc);
    expect(commit).toBeGreaterThan(authenticatedGrant);
    expect(migration.slice(commit + "\ncommit;\n".length).trim()).toBe("");
  });

  it("keeps ledger reads tenant-owned without granting mutation authority", () => {
    expect(migration).toMatch(
      /alter table public\.pipeline_run_history_order_versions enable row level security/i,
    );
    expect(migration).toMatch(
      /create policy pipeline_run_history_order_versions_select_own[\s\S]*to authenticated[\s\S]*public\.clerk_user_id\(\)[\s\S]*user_id/i,
    );
    expect(migration).toMatch(
      /revoke all on table public\.pipeline_run_history_order_versions[\s\S]*from public, anon, authenticated, service_role[\s\S]*grant select on table public\.pipeline_run_history_order_versions[\s\S]*to authenticated/i,
    );
    expect(migration).not.toMatch(
      /grant (insert|update|delete|all)[\s\S]*pipeline_run_history_order_versions[\s\S]*authenticated/i,
    );
  });

  it("reissues one fresh recipient version without rewriting an open snapshot", () => {
    const ownershipTransfer = migration.indexOf(
      "new.user_id is distinct from old.user_id",
    );
    const unchangedTimestampReturn = migration.indexOf(
      "new.updated_at is not distinct from old.updated_at",
    );

    expect(ownershipTransfer).toBeGreaterThan(-1);
    expect(ownershipTransfer).toBeLessThan(unchangedTimestampReturn);
    expect(migration).toMatch(
      /new\.user_id is distinct from old\.user_id[\s\S]*unnest\(array\[old\.user_id, new\.user_id\]\)[\s\S]*order by value[\s\S]*pg_advisory_xact_lock\([\s\S]*trophy-run-order:/i,
    );
    expect(migration).toMatch(
      /delete from public\.pipeline_run_history_order_versions[\s\S]*where run_id = new\.id[\s\S]*and user_id = old\.user_id/i,
    );
    expect(migration).toMatch(
      /new\.updated_at is not distinct from old\.updated_at[\s\S]*new\.user_id is not distinct from old\.user_id[\s\S]*insert into public\.pipeline_run_history_order_versions[\s\S]*new\.user_id/i,
    );
    expect(migration).not.toMatch(
      /update public\.pipeline_run_history_order_versions[\s\S]*set user_id = new\.user_id/i,
    );
  });

  it("freezes membership and order at the caller's opaque snapshot revision", () => {
    expect(migration).toMatch(
      /create or replace function public\.list_mobile_run_history_page\([\s\S]*p_snapshot_revision text[\s\S]*security invoker/i,
    );
    expect(migration).toMatch(
      /returns table \([\s\S]*run_id uuid,[\s\S]*logical_idempotency_key text,[\s\S]*last_meaningful_update_at timestamptz/i,
    );
    expect(migration).toMatch(
      /v_user_id text := public\.clerk_user_id\(\)/i,
    );
    expect(migration).not.toMatch(/p_user_id/i);
    expect(migration).toMatch(
      /select max\(version\.revision\)[\s\S]*where version\.user_id = v_user_id/i,
    );
    expect(migration).toMatch(
      /select distinct on \(version\.run_id\)[\s\S]*version\.revision <= v_snapshot_revision[\s\S]*order by version\.run_id, version\.revision desc/i,
    );
    expect(migration).toMatch(
      /frozen\.run_id,[\s\S]*run\.idempotency_key,[\s\S]*join public\.pipeline_runs as run[\s\S]*run\.user_id = v_user_id/i,
    );
    expect(migration).toMatch(
      /frozen\.last_meaningful_update_at < p_before_updated_at[\s\S]*frozen\.run_id < p_before_run_id[\s\S]*order by frozen\.last_meaningful_update_at desc, frozen\.run_id desc[\s\S]*limit p_limit/i,
    );
    expect(migration).toMatch(
      /revoke all on function public\.list_mobile_run_history_page[\s\S]*from public, anon, service_role[\s\S]*grant execute on function public\.list_mobile_run_history_page[\s\S]*to authenticated/i,
    );
  });
});
