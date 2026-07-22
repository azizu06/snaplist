import { readFileSync } from "node:fs";
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

function functionSql(name: string): string {
  const start = migration.indexOf(`create function public.${name}(`);
  if (start < 0) throw new Error(`Missing ${name}`);
  const next = migration.indexOf("\ncreate function public.", start + 1);
  return migration.slice(start, next < 0 ? undefined : next);
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
});
