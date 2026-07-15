import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260715024820_durable_pipeline_foundation.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("durable pipeline foundation migration", () => {
  it("creates a logged Basic Queue without exposing pgmq_public", () => {
    expect(migration).toMatch(/create extension if not exists pgmq/i);
    expect(migration).toMatch(/pgmq\.create\('pipeline_jobs'\)/i);
    expect(migration).not.toMatch(/create schema\s+pgmq_public/i);
    expect(migration).not.toMatch(/schemas\s*=.*pgmq_public/i);
  });

  it("uses the cross-version two-argument send contract", () => {
    expect(migration).toMatch(
      /pgmq\.send\(\s*'pipeline_jobs'\s*,\s*jsonb_build_object\([\s\S]*?\)\s*\)/i,
    );
    expect(migration).not.toMatch(
      /pgmq\.send\(\s*'pipeline_jobs'[\s\S]*?,\s*['\"]?\d+['\"]?\s*\)/i,
    );
  });

  it("binds run ownership to item and listing ownership in the database", () => {
    expect(migration).toMatch(/create table public\.pipeline_runs/i);
    expect(migration).toMatch(/foreign key \(item_id, user_id\)/i);
    expect(migration).toMatch(/foreign key \(listing_id, item_id, user_id\)/i);
    expect(migration).toMatch(/unique \(user_id, idempotency_key\)/i);
  });

  it("keeps queue and worker mutation RPCs internal", () => {
    for (const functionName of [
      "enqueue_pipeline_message",
      "claim_pipeline_messages",
      "ack_pipeline_message",
      "load_pipeline_run_worker_context",
      "transition_pipeline_run",
      "link_pipeline_run_listing",
    ]) {
      expect(migration).toMatch(
        new RegExp(`grant execute on function public\\.${functionName}\\([^;]+to service_role`, "i"),
      );
      expect(migration).toMatch(
        new RegExp(`revoke all on function public\\.${functionName}\\([^;]+from public, anon, authenticated`, "i"),
      );
    }
  });
});
