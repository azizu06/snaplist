import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  "supabase/migrations/20260728150000_authenticated_guest_submission_begin.sql",
);

describe("authenticated guest submission begin migration", () => {
  it("stages only the authenticated subject's validated photo paths", () => {
    expect(existsSync(migrationPath)).toBe(true);
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toMatch(
      /create or replace function public\.begin_mobile_item_submission\(\s*p_idempotency_key uuid,\s*p_request_fingerprint text,\s*p_batch_id uuid,\s*p_cleanup_id uuid,\s*p_cost_basis numeric,\s*p_photo_receipts jsonb\s*\)/i,
    );
    expect(migration).toMatch(/security definer[\s\S]*set search_path = ''/i);
    expect(migration).toMatch(
      /v_user_id text := private\.assert_verified_guest_capability\(\)/i,
    );
    expect(migration).not.toMatch(/p_user_id/i);
    expect(migration).toMatch(
      /char_length\(v_user_id \|\| '\/pipeline-staging\/' \|\| p_batch_id::text \|\| '\/0\/'\)[\s\S]*<> v_user_id \|\| '\/pipeline-staging\/' \|\| p_batch_id::text \|\| '\/0\/'/i,
    );
    expect(migration).toMatch(
      /submission\.user_id = v_user_id[\s\S]*submission\.idempotency_key = p_idempotency_key/i,
    );
    expect(migration).toMatch(
      /create or replace function private\.record_authenticated_guest_staging_cleanup_intent\(\s*p_cleanup_id uuid,\s*p_batch_id uuid,\s*p_photo_paths text\[\]\s*\)/i,
    );
    expect(migration).toMatch(
      /record_authenticated_guest_staging_cleanup_intent\(\s*p_cleanup_id, p_batch_id, v_photo_paths\s*\)/i,
    );
    expect(migration).toMatch(
      /record_authenticated_guest_staging_cleanup_intent[\s\S]*v_user_id text := private\.assert_verified_guest_capability\(\)/i,
    );
    expect(migration).toMatch(
      /where intent\.cleanup_id = p_cleanup_id[\s\S]*intent\.user_id = v_user_id[\s\S]*intent\.batch_id = p_batch_id/i,
    );
    expect(migration).toMatch(
      /insert into private\.mobile_item_submissions[\s\S]*values \(\s*v_user_id,/i,
    );
    expect(migration).toMatch(
      /revoke all on function public\.begin_mobile_item_submission\(\s*uuid, text, uuid, uuid, numeric, jsonb\s*\)[\s\S]*from public, anon, authenticated, service_role/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.begin_mobile_item_submission\(\s*uuid, text, uuid, uuid, numeric, jsonb\s*\)[\s\S]*to authenticated/i,
    );
    expect(migration).toMatch(
      /revoke all on function private\.record_authenticated_guest_staging_cleanup_intent\(\s*uuid, uuid, text\[\]\s*\)[\s\S]*from public, anon, authenticated, service_role/i,
    );
    expect(migration).not.toMatch(
      /grant execute on function public\.begin_mobile_item_submission\([\s\S]*to service_role/i,
    );
    expect(migration).not.toMatch(
      /grant\s+(?:select|insert|update|delete|all)[\s\S]*private\.(?:mobile_item_submissions|pipeline_staging_cleanup_intents)/i,
    );
  });
});
