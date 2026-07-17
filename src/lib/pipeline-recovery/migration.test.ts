import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260717000000_pipeline_recovery_ux.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("pipeline recovery migration", () => {
  it("deduplicates terminal notifications by tenant, run, and kind", () => {
    expect(migration).toMatch(/add column(?: if not exists)? source_pipeline_run_id uuid/i);
    expect(migration).toMatch(
      /unique index[\s\S]+notifications[\s\S]+\(user_id, source_pipeline_run_id, kind\)/i,
    );
    expect(migration).toMatch(/'listing_ready'/i);
    expect(migration).toMatch(/'pipeline_failed'/i);
  });

  it("emits only terminal run notifications from the database transition", () => {
    expect(migration).toMatch(/create or replace function public\.notify_pipeline_run_terminal/i);
    expect(migration).toMatch(/new\.status = 'succeeded'/i);
    expect(migration).toMatch(/new\.status = 'failed'/i);
    expect(migration).toMatch(/on conflict \(user_id, source_pipeline_run_id, kind\) do nothing/i);
    expect(migration).not.toMatch(/new\.status = 'retrying'[\s\S]+insert into public\.notifications/i);
  });

  it("exposes tenant-scoped idempotent retry and cancel RPCs", () => {
    for (const functionName of ["retry_pipeline_run", "cancel_pipeline_run"]) {
      expect(migration).toMatch(
        new RegExp(`create or replace function public\\.${functionName}`, "i"),
      );
      expect(migration).toMatch(
        new RegExp(`grant execute on function public\\.${functionName}\\(uuid\\)[\\s\\S]+to authenticated`, "i"),
      );
    }
    expect(migration).toMatch(/public\.clerk_user_id\(\)/i);
    expect(migration).toMatch(/pgmq\.send\([\s\S]+'pipeline_jobs'[\s\S]+run_id[\s\S]+schema_version/i);
    expect(migration).toMatch(/status in \('queued', 'running', 'retrying'\)/i);
    expect(migration).not.toMatch(/delete from public\.(items|listings)/i);
    expect(migration).not.toMatch(/storage\.objects/i);
  });
});
