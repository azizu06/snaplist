import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationURL = new URL(
  "../../../supabase/migrations/20260804030000_guest_recovery_submission_identity.sql",
  import.meta.url,
);

describe("guest recovery producer migration", () => {
  it("persists only the hash-bound identity and closes the v2 producer bypass", async () => {
    const sql = await readFile(migrationURL, "utf8");

    expect(sql).toContain("add column recovery_id uuid");
    expect(sql).toContain("add column recovery_token_hash text");
    expect(sql).not.toMatch(/add column recovery_token\s/);
    expect(sql).toContain("find_mobile_item_submission_v3");
    expect(sql).toContain("begin_mobile_item_submission_v3");
    expect(sql).toContain("commit_mobile_item_submission_v3");
    expect(sql).toMatch(
      /revoke all on function public\.commit_mobile_item_submission_v2[\s\S]*from authenticated/,
    );
    expect(sql).toMatch(
      /revoke all on function public\.commit_mobile_item_submission_v2[\s\S]*from service_role/,
    );
    expect(sql).toMatch(
      /revoke all on function public\.commit_mobile_item_submission\([\s\S]*from public, anon, authenticated, service_role/,
    );
  });

  it("atomically completes the owned run and calls the existing registration capability", async () => {
    const sql = await readFile(migrationURL, "utf8");

    expect(sql).toContain("complete_pipeline_run_with_guest_recovery");
    expect(sql).toContain("stage_guest_recovery_upload_cleanup");
    expect(sql).toContain("v_completion := public.complete_pipeline_run(");
    expect(sql).toContain("v_recovery := public.register_guest_draft_recovery(");
    expect(sql).toContain("set photos = v_recovery_paths");
    expect(sql).toContain("guest_recovery_photo_remap_allowed");
    expect(sql).toContain("run.completed_at = statement_timestamp()");
    expect(sql).toContain("cleanup.photo_paths is not distinct from p_new.photos");
    expect(sql).toMatch(
      /insert into private\.pipeline_storage_cleanup_jobs[\s\S]*'staging'[\s\S]*v_source_photo_paths/,
    );
    expect(sql).toMatch(
      /v_run\.user_id ~ '\^guest_\[0-9a-f\]\{48\}\$'[\s\S]*Legacy guest pipeline run has no recovery authority/,
    );
    expect(sql).toMatch(
      /delete from private\.pipeline_storage_cleanup_jobs[\s\S]*source_type = 'guest_recovery'/,
    );
    expect(sql).toMatch(
      /revoke all on function public\.complete_pipeline_run\(uuid, uuid, jsonb\)[\s\S]*from service_role/,
    );
    expect(sql).toContain("'recovery_id', run.recovery_id");
    expect(sql).toContain("'photo_identity_fingerprint', item.photo_identity_fingerprint");
  });
});
