import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260714160000_ebay_dispatch_durable_completion.sql",
  ),
  "utf8",
);

describe("generation-bound eBay dispatch completion migration", () => {
  it.each([
    "complete_ebay_publish_dispatch",
    "complete_ebay_reprice_dispatch",
    "complete_scheduled_ebay_reprice_dispatch",
  ])("defines %s", (name) => {
    expect(migration).toMatch(
      new RegExp(`create or replace function public\\.${name}\\(`, "i"),
    );
  });

  it("serializes completion with account rotation and the exact active attempt", () => {
    expect(migration).toMatch(/lock_ebay_messaging_account\(p_user_id\)/i);
    expect(migration).toMatch(/account\.generation\s+is\s+distinct\s+from\s+p_account_generation/i);
    expect(migration).toMatch(/lease\.attempt_token\s*=\s*p_attempt_token/i);
    expect(migration).toMatch(/lease\.expires_at\s*>\s*statement_timestamp\(\)/i);
  });

  it("persists acknowledged publish and reprice state before consuming the lease", () => {
    expect(migration).toMatch(/ebay_listing_id\s*=\s*p_ebay_listing_id/i);
    expect(migration).toMatch(/listed_price\s*=\s*p_applied_price/i);
    expect(migration.match(/review_revision\s*=\s*gen_random_uuid\(\)/gi)).toHaveLength(
      2,
    );
    expect(migration).toMatch(/delete from private\.ebay_provider_dispatch_leases/i);
  });
});
