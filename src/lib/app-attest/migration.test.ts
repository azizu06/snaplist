import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260726191500_app_attest_verification.sql",
    import.meta.url,
  ),
  "utf8",
);
const executableSql = migration.replace(/^--.*$/gm, "");

describe("App Attest private persistence contract", () => {
  it("atomically consumes private challenges and advances only monotonic key counters", () => {
    expect(migration).toMatch(/create table private\.app_attest_challenges/i);
    expect(migration).toMatch(/create table private\.app_attest_keys/i);
    expect(migration).toMatch(/challenge bytea not null/i);
    expect(migration).toMatch(/octet_length\(challenge\) >= 16/i);
    expect(migration).toMatch(/expires_at timestamptz not null/i);
    expect(migration).toMatch(/consumed_at timestamptz/i);
    expect(migration).toMatch(/assertion_counter bigint not null default 0/i);

    expect(migration).toMatch(/create or replace function public\.claim_app_attest_challenge/i);
    expect(migration).toMatch(
      /update private\.app_attest_challenges[\s\S]+set consumed_at = statement_timestamp\(\)[\s\S]+consumed_at is null[\s\S]+expires_at > statement_timestamp\(\)[\s\S]+returning challenge/i,
    );
    expect(migration).toMatch(/create or replace function public\.commit_app_attest_assertion/i);
    expect(migration).toMatch(
      /update private\.app_attest_keys[\s\S]+assertion_counter = p_assertion_counter[\s\S]+p_assertion_counter > assertion_counter[\s\S]+returning true/i,
    );
  });

  it("exposes only narrow server-owned RPCs and no guest or domain authority", () => {
    expect(migration).toMatch(/revoke all on table private\.app_attest_challenges from public/i);
    expect(migration).toMatch(/revoke all on table private\.app_attest_keys from public/i);
    expect(migration).not.toMatch(/grant .+ to (?:anon|authenticated)/i);
    expect(migration.match(/grant execute on function public\.[^;]+ to service_role/gi)).toHaveLength(6);
    expect(executableSql).not.toMatch(
      /guest_bearer|guest_principal|allowance|ai_item|pipeline_runs|items|listings|storage\.objects/i,
    );
  });

  it("deletes consumed or expired challenges through repeatable private cleanup", () => {
    expect(migration).toMatch(
      /create or replace function private\.cleanup_app_attest_retention\(\s*p_now timestamptz,\s*p_cleanup_challenges boolean/i,
    );
    expect(migration).toMatch(
      /if p_cleanup_challenges then[\s\S]*delete from private\.app_attest_challenges[\s\S]*consumed_at is not null[\s\S]*or expires_at <= p_now[\s\S]*get diagnostics v_deleted_challenges = row_count/i,
    );
    expect(migration).toMatch(
      /jsonb_build_object\(\s*'deletedChallenges', v_deleted_challenges/i,
    );
  });

  it("deletes inactive keys after 90 days using attestation time when never asserted", () => {
    expect(migration).toMatch(
      /private\.cleanup_app_attest_retention\(\s*p_now timestamptz,\s*p_cleanup_challenges boolean,\s*p_cleanup_keys boolean/i,
    );
    expect(migration).toMatch(
      /if p_cleanup_keys then[\s\S]*delete from private\.app_attest_keys[\s\S]*coalesce\(last_asserted_at, attested_at\)\s*<= p_now - interval '90 days'[\s\S]*get diagnostics v_deleted_keys = row_count/i,
    );
    expect(migration).toMatch(
      /'deletedKeys', v_deleted_keys/i,
    );
  });

  it("stores only current key state with a valid latest successful assertion time", () => {
    expect(migration).toMatch(
      /last_asserted_at timestamptz[\s\S]*check \(last_asserted_at is null or last_asserted_at >= attested_at\)/i,
    );
    expect(migration).toMatch(
      /insert into private\.app_attest_keys[\s\S]*on conflict \(key_id\) do nothing/i,
    );
    expect(migration).toMatch(
      /update private\.app_attest_keys[\s\S]*assertion_counter = p_assertion_counter[\s\S]*last_asserted_at = statement_timestamp\(\)/i,
    );
    expect(executableSql).not.toMatch(
      /device_fingerprint|app_attest_(?:challenge|receipt|key)_history|superseded_key/i,
    );
  });

  it("provides an exact immediate App Attest erasure seam for supplied identifiers", () => {
    expect(migration).toMatch(
      /create or replace function public\.delete_app_attest_state_for_erasure\(\s*p_challenge_ids uuid\[\],\s*p_key_ids text\[\]/i,
    );
    expect(migration).toMatch(
      /delete from private\.app_attest_challenges[\s\S]*challenge_id = any\(p_challenge_ids\)[\s\S]*key_id = any\(p_key_ids\)[\s\S]*delete from private\.app_attest_keys[\s\S]*key_id = any\(p_key_ids\)/i,
    );
    expect(migration).toMatch(
      /revoke all on function public\.delete_app_attest_state_for_erasure\(uuid\[\], text\[\]\) from public, anon, authenticated/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.delete_app_attest_state_for_erasure\(uuid\[\], text\[\]\) to service_role/i,
    );
  });

  it("registers serialized hourly cleanup with private catalog and run-history breach proof", () => {
    expect(migration).toMatch(/create extension if not exists pg_cron/i);
    expect(migration).toMatch(
      /pg_catalog\.pg_advisory_xact_lock\(\s*pg_catalog\.hashtextextended\('snaplist:app-attest-retention', 0\)\s*\)/i,
    );
    expect(migration).toMatch(
      /cron\.schedule\(\s*'snaplist-app-attest-retention-hourly',\s*'17 \* \* \* \*',\s*'select private\.cleanup_app_attest_retention\(statement_timestamp\(\), true, true\);'\s*\)/i,
    );
    expect(migration).toMatch(
      /create view private\.app_attest_retention_scheduler_health[\s\S]*interval '23 hours'[\s\S]*retention_breach/i,
    );
    expect(migration).toMatch(
      /join cron\.job[\s\S]*cron\.job_run_details[\s\S]*status = 'succeeded'/i,
    );
    expect(migration).toMatch(
      /revoke all on private\.app_attest_retention_scheduler_health\s+from public, anon, authenticated, service_role/i,
    );
    expect(migration).not.toMatch(
      /grant execute on function private\.cleanup_app_attest_retention[\s\S]*to service_role/i,
    );
  });
});
