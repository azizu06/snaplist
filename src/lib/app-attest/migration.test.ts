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
    expect(migration.match(/grant execute on function public\.[^;]+ to service_role/gi)).toHaveLength(5);
    expect(executableSql).not.toMatch(
      /guest_bearer|guest_principal|allowance|ai_item|pipeline_runs|items|listings|storage\.objects/i,
    );
  });
});
