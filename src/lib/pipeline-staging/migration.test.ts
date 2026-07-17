import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260715035314_durable_upload_staging.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("durable upload staging migration", () => {
  it("adds batch recovery and a bounded safe capture snapshot", () => {
    expect(migration).toMatch(/add column batch_id uuid/i);
    expect(migration).toMatch(/add column batch_position integer/i);
    expect(migration).toMatch(/add column capture_input jsonb/i);
    expect(migration).toMatch(/capture_input is null\s+or/i);
    expect(migration).toMatch(/photo_count/i);
    expect(migration).toMatch(/autopilot_enabled/i);
    expect(migration).toMatch(/source/i);
    expect(migration).toMatch(/pipeline_runs_user_batch_position_idx/i);
  });

  it("reserves daily and minute capacity once per run", () => {
    expect(migration).toMatch(/create table private\.pipeline_run_usage_reservations/i);
    expect(migration).toMatch(/run_id uuid primary key/i);
    expect(migration).toMatch(/pg_advisory_xact_lock/i);
    expect(migration).toMatch(/daily_released_at/i);
  });

  it("retains unresolved private staging paths for guarded cleanup", () => {
    expect(migration).toMatch(/create table private\.pipeline_staging_cleanup_intents/i);
    expect(migration).toMatch(/cleanup_after timestamptz/i);
    expect(migration).toMatch(/create or replace function public\.record_pipeline_staging_cleanup_intent/i);
    expect(migration).toMatch(/create or replace function public\.resolve_pipeline_staging_cleanup_intent/i);
    expect(migration).toMatch(/pipeline-staging/i);
  });

  it("bridges legacy request accounting into the same durable capacity checks", () => {
    expect(migration).toMatch(/create table private\.legacy_pipeline_usage_reservations/i);
    expect(migration).toMatch(/create or replace function public\.reserve_legacy_pipeline_usage/i);
    expect(migration).toMatch(/create or replace function public\.release_legacy_pipeline_usage/i);
    expect(migration).toMatch(/from private\.legacy_pipeline_usage_reservations/i);
  });

  it("stages items, runs, and identifiers-only messages in one RPC transaction", () => {
    expect(migration).toMatch(/create or replace function public\.stage_pipeline_batch/i);
    expect(migration).toMatch(/insert into public\.items/i);
    expect(migration).toMatch(/insert into public\.pipeline_runs/i);
    expect(migration).toMatch(/public\.enqueue_pipeline_message/i);
    expect(migration).not.toMatch(/pgmq\.send\([^;]*(?:photo_paths|user_id)/i);
  });

  it("keeps producer authority service-only and terminal release run-keyed", () => {
    for (const functionName of [
      "find_pipeline_batch_replay",
      "stage_pipeline_batch",
      "release_pipeline_run_daily_reservation",
      "reserve_legacy_pipeline_usage",
      "release_legacy_pipeline_usage",
      "record_pipeline_staging_cleanup_intent",
      "resolve_pipeline_staging_cleanup_intent",
    ]) {
      expect(migration).toMatch(
        new RegExp(`grant execute on function public\\.${functionName}\\([^;]+to service_role`, "i"),
      );
      expect(migration).toMatch(
        new RegExp(`revoke all on function public\\.${functionName}\\([^;]+from public, anon, authenticated`, "i"),
      );
    }
    expect(migration).toMatch(/status not in \('failed', 'canceled'\)/i);
  });
});
