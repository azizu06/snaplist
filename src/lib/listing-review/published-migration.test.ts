import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20261001160000_mobile_published_listing_review_read.sql",
  "utf8",
);

describe("mobile published Listing Review read authority", () => {
  it("reads only the caller's own posted listing through RLS", () => {
    expect(migration).toMatch(
      /create or replace function public\.get_mobile_published_listing_review\(p_run_id uuid\)/i,
    );
    expect(migration).toMatch(/security invoker/i);
    expect(migration).not.toMatch(/security definer/i);
    expect(migration).toMatch(
      /where run\.id = p_run_id[\s\S]*run\.user_id = public\.clerk_user_id\(\)/i,
    );
    expect(migration).toMatch(
      /listing\.ebay_listing_id is not null[\s\S]*listing\.ebay_status = 'published'/i,
    );
  });

  it("grants only authenticated callers the tenant-scoped projection", () => {
    expect(migration).toMatch(
      /revoke all on function public\.get_mobile_published_listing_review\(uuid\)[\s\S]*from public, anon, service_role/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.get_mobile_published_listing_review\(uuid\)[\s\S]*to authenticated/i,
    );
  });
});
