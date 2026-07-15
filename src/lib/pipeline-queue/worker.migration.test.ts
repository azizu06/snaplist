import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260715041327_durable_pipeline_worker.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("durable pipeline worker migration", () => {
  it("adds lease, backoff, checkpoint, and safe configuration state", () => {
    for (const column of [
      "checkpoint",
      "lease_token",
      "lease_expires_at",
      "next_attempt_at",
      "autopilot_enabled",
    ]) {
      expect(migration).toMatch(new RegExp(`add column(?: if not exists)? ${column}`, "i"));
    }
  });

  it("pairs every attempt with the stored queue message before tenant access", () => {
    expect(migration).toMatch(/create or replace function public\.claim_pipeline_run_attempt/i);
    expect(migration).toMatch(/queue_message_id\s*(?:=|is not distinct from)\s*p_message_id/i);
    expect(migration).toMatch(/for update/i);
  });

  it("uses a lease fence for checkpoints, retries, and atomic completion", () => {
    for (const functionName of [
      "checkpoint_pipeline_run",
      "finish_pipeline_run_attempt",
      "complete_pipeline_run",
    ]) {
      expect(migration).toMatch(new RegExp(`create or replace function public\\.${functionName}`, "i"));
    }
    expect(migration.match(/lease_token\s*=\s*p_lease_token/gi)?.length).toBeGreaterThanOrEqual(3);
    expect(migration).toMatch(/lease_expires_at\s*>\s*now\(\)/i);
  });

  it("makes listing and prediction persistence idempotent by run id", () => {
    expect(migration).toMatch(/create unique index[\s\S]+listings[\s\S]+\(run_id\)/i);
    expect(migration).toMatch(/create unique index[\s\S]+prediction_logs[\s\S]+\(run_id\)/i);
    expect(migration).toMatch(/insert into public\.listings/i);
    expect(migration).toMatch(/insert into public\.prediction_logs/i);
  });

  it("honors the #159 capture snapshot and quota-release seam without a hard migration dependency", () => {
    expect(migration).toMatch(/to_jsonb\(run\)[\s\S]+capture_input,autopilot_enabled/i);
    expect(migration).toMatch(
      /to_regprocedure\('public\.release_pipeline_run_daily_reservation\(uuid\)'\)/i,
    );
    expect(migration).toMatch(/release_pipeline_run_quota_if_available/i);
  });

  it("keeps the expanded capabilities private and never uses pgmq.pop", () => {
    for (const functionName of [
      "defer_pipeline_message",
      "claim_pipeline_run_attempt",
      "checkpoint_pipeline_run",
      "finish_pipeline_run_attempt",
      "complete_pipeline_run",
      "reject_pipeline_message",
    ]) {
      expect(migration).toMatch(
        new RegExp(`grant execute on function public\\.${functionName}\\([^;]+to service_role`, "i"),
      );
      expect(migration).toMatch(
        new RegExp(`revoke all on function public\\.${functionName}\\([^;]+from public, anon, authenticated`, "i"),
      );
    }
    expect(migration).not.toMatch(/pgmq\.pop/i);
  });
});
