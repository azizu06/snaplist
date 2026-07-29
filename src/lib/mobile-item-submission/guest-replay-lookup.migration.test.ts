import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  "supabase/migrations/20260728140000_authenticated_guest_submission_replay_lookup.sql",
);

describe("authenticated guest submission replay lookup migration", () => {
  it("exposes one publishable-key self lookup without caller-supplied tenancy", () => {
    expect(existsSync(migrationPath)).toBe(true);
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toMatch(
      /create or replace function public\.find_mobile_item_submission\(\s*p_idempotency_key uuid,\s*p_request_fingerprint text\s*\)/i,
    );
    expect(migration).toMatch(/security definer[\s\S]*set search_path = ''/i);
    expect(migration).toMatch(
      /v_user_id text := private\.assert_verified_guest_capability\(\)/i,
    );
    expect(migration).not.toMatch(/public\.clerk_user_id\(\)/i);
    expect(migration).toMatch(
      /submission\.user_id = v_user_id[\s\S]*submission\.idempotency_key = p_idempotency_key/i,
    );
    expect(migration).not.toMatch(/p_user_id/i);
    expect(migration).toMatch(
      /revoke all on function public\.find_mobile_item_submission\(uuid, text\)[\s\S]*from public, anon, authenticated, service_role/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.find_mobile_item_submission\(uuid, text\)[\s\S]*to authenticated/i,
    );
    expect(migration).not.toMatch(
      /grant execute on function public\.find_mobile_item_submission\(uuid, text\)[\s\S]*to service_role/i,
    );
    expect(migration).not.toMatch(
      /grant\s+(?:select|insert|update|delete|all)[\s\S]*private\.mobile_item_submissions/i,
    );
  });
});
