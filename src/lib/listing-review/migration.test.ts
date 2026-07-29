import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260729190000_mobile_listing_review_read.sql",
  "utf8",
);

describe("mobile Listing Review read authority", () => {
  it("binds one succeeded run, current listing result, and tenant through RLS", () => {
    expect(migration).toMatch(
      /create or replace function public\.get_mobile_listing_review\(p_run_id uuid\)/i,
    );
    expect(migration).toMatch(/security invoker/i);
    expect(migration).not.toMatch(/security definer/i);
    expect(migration).toMatch(
      /where run\.id = p_run_id[\s\S]*run\.user_id = public\.clerk_user_id\(\)/i,
    );
    expect(migration).toMatch(
      /join public\.pricing_evidence_snapshots pricing[\s\S]*pricing\.run_id = listing\.run_id[\s\S]*pricing\.item_id = run\.item_id[\s\S]*pricing\.listing_id = run\.listing_id[\s\S]*pricing\.user_id = run\.user_id/i,
    );
    expect(migration).toMatch(
      /run\.status = 'succeeded'[\s\S]*run\.stage = 'completed'/i,
    );
  });

  it("grants only authenticated callers the tenant-scoped projection", () => {
    expect(migration).toMatch(
      /revoke all on function public\.get_mobile_listing_review\(uuid\)[\s\S]*from public, anon, service_role/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.get_mobile_listing_review\(uuid\)[\s\S]*to authenticated/i,
    );
  });
});
