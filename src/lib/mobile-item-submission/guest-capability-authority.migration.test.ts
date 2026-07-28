import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const authorityMigrationPath = resolve(
  "supabase/migrations/20260728130000_verified_guest_capability_authority.sql",
);
const operationChannelMigrationPath = resolve(
  "supabase/migrations/20260728170000_verified_guest_operation_channel.sql",
);
const protectedMigrationPaths = [
  "supabase/migrations/20260728140000_authenticated_guest_submission_replay_lookup.sql",
  "supabase/migrations/20260728150000_authenticated_guest_submission_begin.sql",
  "supabase/migrations/20260728160000_authenticated_guest_submission_commit.sql",
].map((path) => resolve(path));

function extractCapabilityAssertion(migration: string): string {
  const assertion = migration.match(
    /create or replace function private\.assert_verified_guest_capability\(\)[\s\S]*?\n\$\$;/i,
  )?.[0];
  expect(assertion).toBeDefined();
  return assertion!;
}

function normalizeCapabilityAssertionAuthority(assertion: string): string {
  return assertion
    .replace(
      /\s*v_api_key text := coalesce\([\s\S]*?\n\s*\);/i,
      "\n  __OPERATION_CHANNEL_DECLARATION__;",
    )
    .replace(
      /\s*v_operation_channel text := coalesce\([\s\S]*?\);/i,
      "\n  __OPERATION_CHANNEL_DECLARATION__;",
    )
    .replace(
      /\s*or v_api_key not like 'sb_publishable_%' then/i,
      "\n    or __OPERATION_CHANNEL_PREDICATE__ then",
    )
    .replace(
      /\s*or v_operation_channel <> 'verified_guest_publishable' then/i,
      "\n    or __OPERATION_CHANNEL_PREDICATE__ then",
    )
    .replace(/\s+/g, " ")
    .trim();
}

describe("verified guest capability authority migration", () => {
  it("persists only bounded capability authority behind one ungranted assertion", () => {
    expect(existsSync(authorityMigrationPath)).toBe(true);
    const migration = readFileSync(authorityMigrationPath, "utf8");
    const capabilityTable = migration.match(
      /create table private\.verified_guest_capabilities\s*\([\s\S]*?\n\);/i,
    )?.[0];

    expect(capabilityTable).toBeDefined();
    expect(migration).toMatch(/capability_id uuid primary key/i);
    expect(migration).toMatch(/user_id text not null/i);
    expect(migration).toMatch(
      /state text not null default 'active'[\s\S]*active[\s\S]*claimed[\s\S]*tombstoned/i,
    );
    expect(migration).toMatch(/activated_at timestamptz not null/i);
    expect(migration).toMatch(/expires_at timestamptz not null/i);
    expect(migration).toMatch(/revoked_at timestamptz/i);
    expect(migration).toMatch(
      /bearer_digest bytea not null unique[\s\S]*octet_length\(bearer_digest\) = 32/i,
    );
    expect(capabilityTable).not.toMatch(
      /\b(?:bearer_token|jwt|raw_token|access_token|refresh_token|private_key)\b/i,
    );
    expect(migration).toMatch(
      /revoke all on table private\.verified_guest_capabilities[\s\S]*from public, anon, authenticated, service_role/i,
    );
    expect(migration).not.toMatch(
      /grant\s+(?:select|insert|update|delete|all)[\s\S]*private\.verified_guest_capabilities/i,
    );

    expect(migration).toMatch(
      /create or replace function private\.assert_verified_guest_capability\(\s*\)\s*returns text/i,
    );
    expect(migration).toMatch(/security definer[\s\S]*set search_path = ''/i);
    expect(migration).toMatch(
      /auth\.jwt\(\)->>'actor'[\s\S]*verified_guest/i,
    );
    expect(migration).toMatch(/auth\.jwt\(\)->>'cap_id'/i);
    expect(migration).toMatch(/auth\.jwt\(\)->>'sub'/i);
    expect(migration).toMatch(
      /auth\.jwt\(\)->>'role'[\s\S]*authenticated/i,
    );
    expect(migration).toMatch(
      /current_setting\('request\.headers', true\)[\s\S]*sb_publishable_%/i,
    );
    expect(migration).toMatch(
      /capability\.capability_id = v_capability_id[\s\S]*capability\.user_id = v_user_id[\s\S]*capability\.state = 'active'[\s\S]*capability\.activated_at <= statement_timestamp\(\)[\s\S]*capability\.expires_at > statement_timestamp\(\)[\s\S]*capability\.revoked_at is null[\s\S]*for share/i,
    );
    expect(migration).toMatch(
      /revoke all on function private\.assert_verified_guest_capability\(\)[\s\S]*from public, anon, authenticated, service_role/i,
    );
    expect(migration).not.toMatch(
      /grant execute on function private\.assert_verified_guest_capability/i,
    );
  });

  it("replaces the unobservable gateway header fence with one exact signed operation channel", () => {
    expect(existsSync(operationChannelMigrationPath)).toBe(true);
    const authorityMigration = readFileSync(authorityMigrationPath, "utf8");
    const migration = readFileSync(operationChannelMigrationPath, "utf8");
    const originalAssertion = extractCapabilityAssertion(authorityMigration);
    const replacementAssertion = extractCapabilityAssertion(migration);

    expect(replacementAssertion).toMatch(
      /auth\.jwt\(\)->>'snaplist_operation_channel'/i,
    );
    expect(replacementAssertion).toMatch(
      /v_operation_channel <> 'verified_guest_publishable'/i,
    );
    expect(replacementAssertion).not.toMatch(
      /request\.headers|apikey|sb_publishable_|service_role/i,
    );
    expect(replacementAssertion).toMatch(
      /auth\.jwt\(\)->>'role'[\s\S]*authenticated/i,
    );
    expect(replacementAssertion).toMatch(
      /auth\.jwt\(\)->>'actor'[\s\S]*verified_guest/i,
    );
    expect(replacementAssertion).toMatch(/auth\.jwt\(\)->>'cap_id'/i);
    expect(replacementAssertion).toMatch(/auth\.jwt\(\)->>'sub'/i);
    expect(replacementAssertion).toMatch(
      /capability\.capability_id = v_capability_id[\s\S]*capability\.user_id = v_user_id[\s\S]*capability\.state = 'active'[\s\S]*capability\.activated_at <= statement_timestamp\(\)[\s\S]*capability\.expires_at > statement_timestamp\(\)[\s\S]*capability\.revoked_at is null[\s\S]*for share/i,
    );
    expect(replacementAssertion).toMatch(
      /security definer[\s\S]*set search_path = ''/i,
    );
    expect(migration).toMatch(
      /revoke all on function private\.assert_verified_guest_capability\(\)[\s\S]*from public, anon, authenticated, service_role/i,
    );
    expect(migration).not.toMatch(
      /grant execute on function private\.assert_verified_guest_capability/i,
    );
    expect(normalizeCapabilityAssertionAuthority(replacementAssertion)).toBe(
      normalizeCapabilityAssertionAuthority(originalAssertion),
    );
  });

  it("exposes only fixed service-role issue and digest-resolution capabilities", () => {
    const migration = readFileSync(authorityMigrationPath, "utf8");

    expect(migration).toMatch(
      /create or replace function public\.issue_verified_guest_capability\(\s*p_capability_id uuid,\s*p_user_id text,\s*p_bearer_digest bytea,\s*p_activated_at timestamptz,\s*p_expires_at timestamptz\s*\)/i,
    );
    expect(migration).toMatch(
      /pg_advisory_xact_lock[\s\S]*expires_at = least\([\s\S]*interval '60 seconds'[\s\S]*insert into private\.verified_guest_capabilities/i,
    );
    expect(migration).toMatch(
      /pg_advisory_xact_lock[\s\S]*set state = 'tombstoned'[\s\S]*capability\.expires_at <= statement_timestamp\(\)[\s\S]*exists \([\s\S]*capability\.state = 'active'[\s\S]*capability\.expires_at[\s\S]*> statement_timestamp\(\) \+ interval '5 minutes'[\s\S]*raise exception[\s\S]*refresh is not due[\s\S]*expires_at = least/i,
    );
    expect(migration).not.toMatch(
      /capability\.expires_at >= statement_timestamp\(\) \+ interval '5 minutes'/i,
    );
    expect(migration).toMatch(
      /p_expires_at > p_activated_at[\s\S]*p_expires_at <= p_activated_at \+ interval '30 minutes'/i,
    );
    expect(migration).toMatch(
      /create or replace function public\.resolve_verified_guest_capability\(\s*p_bearer_digest bytea\s*\)[\s\S]*returns table\(\s*capability_id uuid,\s*user_id text\s*\)/i,
    );
    expect(migration).toMatch(
      /capability\.bearer_digest = p_bearer_digest[\s\S]*capability\.state = 'active'[\s\S]*capability\.expires_at > statement_timestamp\(\)[\s\S]*capability\.revoked_at is null/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.issue_verified_guest_capability[\s\S]*to service_role/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.resolve_verified_guest_capability[\s\S]*to service_role/i,
    );
    expect(migration).not.toMatch(
      /grant execute on function public\.(?:issue|resolve)_verified_guest_capability[\s\S]*to (?:anon|authenticated)/i,
    );
    expect(migration).toMatch(
      /delete from private\.verified_guest_capabilities[\s\S]*interval '23 hours'[\s\S]*capability\.state <> 'active'/i,
    );
    expect(migration).toMatch(
      /cron\.schedule\([\s\S]*snaplist-verified-guest-capability-retention-hourly[\s\S]*41 \* \* \* \*/i,
    );
  });

  it("rechecks the capability at every authenticated guest operation", () => {
    for (const migrationPath of protectedMigrationPaths) {
      const migration = readFileSync(migrationPath, "utf8");
      expect(migration).toMatch(
        /private\.assert_verified_guest_capability\(\)/i,
      );
    }

    const commitMigration = readFileSync(protectedMigrationPaths[2]!, "utf8");
    expect(commitMigration).toMatch(
      /create or replace function public\.stage_pipeline_batch[\s\S]*private\.assert_verified_guest_capability\(\)/i,
    );
    expect(commitMigration).toMatch(
      /create or replace function public\.commit_mobile_item_submission\(\s*p_idempotency_key[\s\S]*private\.assert_verified_guest_capability\(\)/i,
    );
    const cleanupResolver = commitMigration.match(
      /create or replace function public\.resolve_pipeline_staging_cleanup_intent\([\s\S]*?\n\$\$;/i,
    )?.[0];
    expect(cleanupResolver).not.toMatch(/assert_verified_guest_capability/i);
  });
});
