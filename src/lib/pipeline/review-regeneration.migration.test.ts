import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260713003000_review_identity_regeneration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("review regeneration migration security guards", () => {
  it("rejects NULL and empty Clerk subjects before any tenant-scoped mutation", () => {
    expect(migration).toMatch(
      /if\s+v_user_id\s+is\s+null\s+or\s+v_user_id\s*=\s*''\s+then/i,
    );
  });

  it("requires a strictly positive usable price", () => {
    expect(migration).toMatch(
      /if\s+p_price\s+is\s+null\s+or\s+p_price\s*<=\s*0\s+then/i,
    );
  });

  it("coordinates regeneration with an atomic publish claim and authoritative live fields", () => {
    expect(migration).toMatch(
      /create\s+or\s+replace\s+function\s+public\.begin_ebay_publish/i,
    );
    expect(migration).toMatch(/set\s+ebay_status\s*=\s*'publishing'/i);
    expect(migration).toMatch(/run_id\s+is\s+not\s+distinct\s+from\s+p_expected_run_id/i);
    expect(migration).toMatch(/ebay_listing_id\s+is\s+null/i);
    expect(migration).toMatch(/ebay_status\s+is\s+distinct\s+from\s+'published'/i);
  });
});
