import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260730120000_mobile_item_submission_voice_v2.sql",
  "utf8",
);

describe("mobile item submission voice v2 migration", () => {
  it("keeps the private raw-audio handoff exact and pending for #386", () => {
    expect(migration).toMatch(
      /create table private\.mobile_item_submission_voice_handoffs/i,
    );
    expect(migration).toMatch(
      /state text not null default 'staged'[\s\S]*\('staged', 'accepted'\)/i,
    );
    expect(migration).toMatch(
      /cleanup_after timestamptz not null[\s\S]*interval '24 hours'/i,
    );
    expect(migration).toMatch(
      /revoke all on table private\.mobile_item_submission_voice_handoffs[\s\S]*from public, anon, authenticated, service_role/i,
    );
    expect(migration).not.toMatch(
      /unique\s*\(\s*\(\s*receipt->>'storage_path'\s*\)\s*\)/i,
    );
    expect(migration).toMatch(
      /create unique index mobile_item_submission_voice_handoffs_storage_path_key\s+on private\.mobile_item_submission_voice_handoffs\s*\(\s*\(receipt->>'storage_path'\)\s*\)/i,
    );
    expect(migration).not.toMatch(
      /delete from private\.mobile_item_submission_voice_handoffs/i,
    );
  });

  it("preserves separate Clerk service-role and verified-guest v2 capabilities", () => {
    for (const functionName of [
      "find_mobile_item_submission_v2",
      "begin_mobile_item_submission_v2",
      "commit_mobile_item_submission_v2",
    ]) {
      expect(
        migration.match(
          new RegExp(
            `create or replace function public\\.${functionName}\\(`,
            "gi",
          ),
        ),
      ).toHaveLength(2);
    }
    expect(migration).toMatch(
      /find_mobile_item_submission_v2\(\s*p_user_id text[\s\S]*to service_role/i,
    );
    expect(migration).toMatch(
      /find_mobile_item_submission_v2\(\s*p_idempotency_key uuid[\s\S]*private\.assert_verified_guest_capability\(\)[\s\S]*to authenticated/i,
    );
    expect(migration).toMatch(
      /security definer[\s\S]*set search_path = ''/i,
    );
  });

  it("reuses an exact existing photo-only v1 binding without weakening new v2 identity", () => {
    expect(migration).toMatch(
      /create or replace function private\.resolve_mobile_item_submission_v2_fingerprint\(/i,
    );
    expect(migration).toMatch(
      /p_legacy_request_fingerprint text[\s\S]*p_allow_legacy boolean/i,
    );
    expect(migration).toMatch(
      /submission\.request_fingerprint = p_legacy_request_fingerprint[\s\S]*then[\s\S]*return p_legacy_request_fingerprint[\s\S]*end if;[\s\S]*return p_request_fingerprint/i,
    );
    expect(migration).toMatch(
      /find_mobile_item_submission_v2\([\s\S]*p_legacy_request_fingerprint text[\s\S]*resolve_mobile_item_submission_v2_fingerprint\([\s\S]*true/i,
    );
    expect(migration).toMatch(
      /begin_mobile_item_submission_v2\([\s\S]*p_voice_receipt jsonb[\s\S]*resolve_mobile_item_submission_v2_fingerprint\([\s\S]*p_voice_receipt is null/i,
    );
    expect(migration).toMatch(
      /commit_mobile_item_submission_v2\([\s\S]*p_voice_receipt jsonb[\s\S]*resolve_mobile_item_submission_v2_fingerprint\([\s\S]*p_voice_receipt is null/i,
    );
  });

  it("accepts the handoff in the same transaction without widening queue payloads", () => {
    expect(migration).toMatch(
      /public\.commit_mobile_item_submission\([\s\S]*private\.accept_mobile_submission_voice_handoff\(/i,
    );
    expect(migration).toMatch(
      /v_handoff\.receipt is distinct from p_voice_receipt/i,
    );
    expect(migration).not.toMatch(
      /pgmq\.send[\s\S]*(voice|audio)|jsonb_build_object\([\s\S]*(voice|audio)/i,
    );
    expect(migration).not.toMatch(
      /insert into public\.(items|prediction_logs)[\s\S]*(voice|audio)/i,
    );
  });

  it("extends only the non-null private photo bucket MIME allowlist for WAV", () => {
    expect(migration).toMatch(
      /update storage\.buckets[\s\S]*set allowed_mime_types = array_append\(allowed_mime_types, 'audio\/wav'\)[\s\S]*where id = 'photos'[\s\S]*allowed_mime_types is not null[\s\S]*not \('audio\/wav' = any\(allowed_mime_types\)\)/i,
    );
    expect(migration).not.toMatch(
      /update storage\.buckets[\s\S]*set[\s\S]*(public|file_size_limit)\s*=/i,
    );
    expect(migration).not.toMatch(
      /drop policy|alter policy|create policy/i,
    );
  });
});
