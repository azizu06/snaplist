import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../supabase/migrations/20260802213500_guest_claim_handoff.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const executableSql = migration.replace(/^--.*$/gm, "");

describe("durable guest claim handoff contract", () => {
  it("keeps handoff state private and callable only through narrow service-role RPCs", () => {
    expect(migration).toMatch(/create table private\.guest_claim_handoffs/i);
    expect(migration).toMatch(/alter table private\.guest_claim_handoffs enable row level security/i);
    expect(migration).toMatch(
      /revoke all on table private\.guest_claim_handoffs\s+from public, anon, authenticated, service_role/i,
    );
    expect(migration).toMatch(/create or replace function public\.issue_guest_claim_handoff/i);
    expect(migration).toMatch(/create or replace function public\.consume_guest_claim_handoff/i);
    expect(executableSql).not.toMatch(/grant .+ to (?:anon|authenticated)/i);
    expect(migration.match(/grant execute on function public\.[^;]+ to service_role/gi)).toHaveLength(2);
  });

  it("derives the guest principal from the exact attested App Attest key", () => {
    expect(migration).toMatch(
      /p_guest_user_id <> 'guest_' \|\| pg_catalog\.substr\([\s\S]*extensions\.digest\([\s\S]*pg_catalog\.convert_to\(p_app_id[\s\S]*decode\('00', 'hex'\)[\s\S]*pg_catalog\.convert_to\(p_key_id/i,
    );
    expect(migration).toMatch(
      /from private\.app_attest_keys key[\s\S]*key\.key_id = p_key_id[\s\S]*key\.app_id = p_app_id[\s\S]*key\.environment = p_environment/i,
    );
  });

  it("issues only for the exact recoverable photo set", () => {
    expect(migration).toMatch(
      /from private\.guest_draft_recoveries recovery[\s\S]*join public\.items item[\s\S]*recovery\.id = p_recovery_id[\s\S]*recovery\.guest_user_id = p_guest_user_id[\s\S]*recovery\.recovery_token_hash = p_recovery_token_hash[\s\S]*item\.photo_identity_kind = 'content_sha256_set_v1'[\s\S]*item\.photo_identity_fingerprint = p_photo_set_fingerprint/i,
    );
  });

  it("makes replay rejection durable by deleting the matching token atomically", () => {
    expect(migration).toMatch(
      /delete from private\.guest_claim_handoffs handoff[\s\S]*using private\.app_attest_keys key,[\s\S]*private\.guest_draft_recoveries recovery,[\s\S]*public\.items item[\s\S]*returning[\s\S]*handoff\.recovery_id/i,
    );
  });

  it("rejects an expired handoff using the database clock", () => {
    expect(migration).toMatch(
      /handoff\.token_digest = p_token_digest[\s\S]*handoff\.expires_at > statement_timestamp\(\)/i,
    );
  });

  it("rejects a handoff whose App Attest key is no longer attested", () => {
    expect(migration).toMatch(
      /using private\.app_attest_keys key,[\s\S]*key\.key_id = handoff\.key_id[\s\S]*key\.app_id = handoff\.app_id[\s\S]*key\.environment = handoff\.environment/i,
    );
  });

  it("rejects a handoff after the recovery photo set changes", () => {
    expect(migration).toMatch(
      /item\.id = recovery\.item_id[\s\S]*item\.user_id = recovery\.guest_user_id[\s\S]*item\.photo_identity_kind = handoff\.photo_identity_kind[\s\S]*item\.photo_identity_fingerprint = handoff\.photo_set_fingerprint/i,
    );
  });

  it("purges unused expired handoffs on a serialized hourly schedule", () => {
    expect(migration).toMatch(
      /create or replace function private\.cleanup_guest_claim_handoff_retention\(\)/i,
    );
    expect(migration).toMatch(
      /pg_catalog\.pg_advisory_xact_lock[\s\S]*delete from private\.guest_claim_handoffs[\s\S]*expires_at <= statement_timestamp\(\)/i,
    );
    expect(migration).toMatch(
      /cron\.schedule\([\s\S]*snaplist-guest-claim-handoff-retention-hourly[\s\S]*cleanup_guest_claim_handoff_retention/i,
    );
  });

  it("reports a retention breach on scheduler drift, stale success, or any expired row", () => {
    expect(migration).toMatch(
      /create view private\.guest_claim_handoff_retention_health[\s\S]*security_invoker = true/i,
    );
    expect(migration).toMatch(
      /job\.schedule is distinct from '23 \* \* \* \*'[\s\S]*job\.command is distinct from[\s\S]*job\.active is distinct from true[\s\S]*run\.last_succeeded_at is null[\s\S]*interval '1 hour'[\s\S]*expired\.expired_rows > 0/i,
    );
    expect(migration).toMatch(
      /from cron\.job_run_details history[\s\S]*history\.status = 'succeeded'/i,
    );
    expect(migration).toMatch(
      /revoke all on private\.guest_claim_handoff_retention_health[\s\S]*from public, anon, authenticated, service_role/i,
    );
  });
});
