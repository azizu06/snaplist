import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve("supabase/migrations/20260722130000_mobile_ebay_sandbox_oauth.sql"),
  "utf8",
);
const grantCorrection = readFileSync(
  resolve(
    "supabase/migrations/20260722140000_narrow_mobile_ebay_oauth_session_grants.sql",
  ),
  "utf8",
);
const forwardRpcMigrationPath = resolve(
  "supabase/migrations/20260722150000_forward_mobile_ebay_oauth_expiry_rpcs.sql",
);
const forwardRpcMigration = existsSync(forwardRpcMigrationPath)
  ? readFileSync(forwardRpcMigrationPath, "utf8")
  : "";

function functionSql(name: string): string {
  const start = migration.indexOf(`create function public.${name}(`);
  if (start < 0) throw new Error(`Missing ${name}`);
  const next = migration.indexOf("\ncreate function public.", start + 1);
  return migration.slice(start, next < 0 ? undefined : next);
}

function functionDefinition(source: string, name: string): string {
  const startMatch = new RegExp(
    `create(?: or replace)? function public\\.${name}\\(`,
    "i",
  ).exec(source);
  if (!startMatch) throw new Error(`Missing ${name}`);
  const end = source.indexOf("\n$$;", startMatch.index);
  if (end < 0) throw new Error(`Missing ${name} terminator`);
  return source
    .slice(startMatch.index, end + 4)
    .replace(/^create or replace function/i, "create function");
}

describe("mobile eBay OAuth migration authority", () => {
  it("expires finish callbacks before reporting an active completion lease", () => {
    const finish = functionSql("finish_mobile_ebay_oauth_session");
    const expiry = finish.indexOf("if v_session.expires_at <= statement_timestamp()");
    const inProgress = finish.indexOf("if v_session.status = 'completing'");

    expect(expiry).toBeGreaterThan(0);
    expect(expiry).toBeLessThan(inProgress);
    expect(finish.slice(expiry, inProgress)).toMatch(
      /status = 'expired',[\s\S]*completion_lease_token = null,[\s\S]*completion_started_at = null,[\s\S]*finished_at = statement_timestamp\(\)/i,
    );
  });

  it("expires begin callbacks before active or stale lease handling", () => {
    const begin = functionSql("begin_mobile_ebay_oauth_session");
    const expiry = begin.indexOf("if v_session.expires_at <= statement_timestamp()");
    const leaseHandling = begin.indexOf("if v_session.status = 'completing'");

    expect(expiry).toBeGreaterThan(0);
    expect(expiry).toBeLessThan(leaseHandling);
    expect(begin.slice(expiry, leaseHandling)).toMatch(
      /status = 'expired',[\s\S]*completion_lease_token = null,[\s\S]*completion_started_at = null,[\s\S]*finished_at = statement_timestamp\(\)/i,
    );
  });

  it("expires the held lease before any late connection persistence", () => {
    const complete = functionSql("complete_mobile_ebay_oauth_session");
    const expiry = complete.indexOf("if v_session.expires_at <= statement_timestamp()");
    const saveConnection = complete.indexOf(
      "perform private.save_ebay_connection_for_tenant(",
    );

    expect(expiry).toBeGreaterThan(0);
    expect(expiry).toBeLessThan(saveConnection);
    expect(complete.slice(expiry, saveConnection)).toMatch(
      /status = 'expired',[\s\S]*completion_lease_token = null,[\s\S]*completion_started_at = null,[\s\S]*'kind', 'replayed', 'outcome', 'expired'/i,
    );
    expect(complete).toMatch(
      /status in \('connected', 'declined', 'cancelled', 'expired', 'failed'\)[\s\S]*'kind', 'replayed', 'outcome', v_session\.status/i,
    );
  });

  it("replays terminal or expired truth before a late provider failure", () => {
    const fail = functionSql("fail_mobile_ebay_oauth_session");
    const lock = fail.indexOf("for update");
    const terminal = fail.indexOf(
      "if v_session.status in ('connected', 'declined', 'cancelled', 'expired', 'failed')",
    );
    const expiry = fail.indexOf(
      "if v_session.expires_at <= statement_timestamp()",
    );
    const failed = fail.indexOf("set status = 'failed'");

    expect(lock).toBeGreaterThan(0);
    expect(terminal).toBeGreaterThan(lock);
    expect(expiry).toBeGreaterThan(terminal);
    expect(expiry).toBeLessThan(failed);
    expect(fail.slice(terminal, expiry)).toMatch(
      /'kind', 'replayed', 'outcome', v_session\.status/i,
    );
    expect(fail.slice(expiry, failed)).toMatch(
      /status = 'expired',[\s\S]*completion_lease_token = null,[\s\S]*completion_started_at = null,[\s\S]*'kind', 'replayed', 'outcome', 'expired'/i,
    );
    expect(fail.slice(failed)).toMatch(
      /'kind', 'finished', 'outcome', 'failed'/i,
    );
  });

  it("keeps the six RPCs hardened and narrowly granted", () => {
    expect(
      migration.match(/language plpgsql\s+security definer\s+set search_path = ''/gi),
    ).toHaveLength(6);
    expect(migration).toMatch(
      /alter table public\.ebay_oauth_sessions enable row level security/i,
    );
    expect(migration).toMatch(
      /revoke all on table public\.ebay_oauth_sessions from public, anon, authenticated/i,
    );
    expect(migration).toMatch(
      /revoke all on function public\.create_mobile_ebay_oauth_session\([\s\S]*from public, anon, service_role;[\s\S]*grant execute on function public\.create_mobile_ebay_oauth_session\([\s\S]*to authenticated;/i,
    );
    expect(
      migration.match(/grant execute on function public\.[\s\S]*?to service_role;/gi),
    ).toHaveLength(5);
  });

  it("removes broad service-role table authority before restoring read and delete", () => {
    expect(grantCorrection).toMatch(
      /^revoke all on table public\.ebay_oauth_sessions from service_role;\s+grant select, delete on table public\.ebay_oauth_sessions to service_role;\s*$/i,
    );
    expect(grantCorrection).not.toMatch(
      /grant\s+(?:insert|update|truncate|references|trigger|all)\b/i,
    );
    expect(migration).toMatch(
      /revoke all on table public\.ebay_oauth_sessions from public, anon, authenticated/i,
    );
  });

  it("forwards every corrected RPC into databases that recorded the parent migration", () => {
    expect(forwardRpcMigration).not.toBe("");
    expect(
      forwardRpcMigration.match(
        /create or replace function public\.(?:finish|begin|complete)_mobile_ebay_oauth_session\(/gi,
      ),
    ).toHaveLength(3);
    expect(forwardRpcMigration).toMatch(
      /drop function public\.fail_mobile_ebay_oauth_session\(\s*uuid, text, uuid, timestamptz\s*\);[\s\S]*create function public\.fail_mobile_ebay_oauth_session\(/i,
    );
    expect(
      forwardRpcMigration.match(
        /language plpgsql\s+security definer\s+set search_path = ''/gi,
      ),
    ).toHaveLength(4);
    expect(
      forwardRpcMigration.match(
        /grant execute on function public\.(?:finish|begin|complete|fail)_mobile_ebay_oauth_session\([\s\S]*?to service_role;/gi,
      ),
    ).toHaveLength(4);
    expect(forwardRpcMigration).toMatch(
      /create or replace function public\.complete_mobile_ebay_oauth_session\([\s\S]*if v_session\.expires_at <= statement_timestamp\(\)[\s\S]*perform private\.save_ebay_connection_for_tenant\(/i,
    );
    expect(forwardRpcMigration).toMatch(
      /create function public\.fail_mobile_ebay_oauth_session\([\s\S]*returns jsonb[\s\S]*for update;[\s\S]*if v_session\.status in \('connected', 'declined', 'cancelled', 'expired', 'failed'\)[\s\S]*if v_session\.expires_at <= statement_timestamp\(\)[\s\S]*set status = 'failed'/i,
    );
    for (const name of [
      "finish_mobile_ebay_oauth_session",
      "begin_mobile_ebay_oauth_session",
      "complete_mobile_ebay_oauth_session",
      "fail_mobile_ebay_oauth_session",
    ]) {
      expect(functionDefinition(forwardRpcMigration, name)).toBe(
        functionDefinition(migration, name),
      );
    }
  });
});
