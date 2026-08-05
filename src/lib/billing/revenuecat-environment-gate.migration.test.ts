import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260805160000_revenuecat_environment_gate.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("RevenueCat environment persistence migration", () => {
  it("persists an explicit provider environment in webhook idempotency", () => {
    expect(migration).toMatch(
      /add column environment text[\s\S]+primary key \(environment, event_id\)/i,
    );
    expect(migration).toMatch(/p_environment text/i);
    expect(migration).toMatch(/'environment', p_environment/i);
    expect(migration).toMatch(/event\.environment = p_environment/i);
  });

  it("binds the environment into downstream StoreKit event identity", () => {
    expect(migration).toMatch(
      /v_storekit_event_id text := lower\(p_environment\) \|\| ':' \|\| md5\(p_event_id\)/i,
    );
    expect(migration).toMatch(
      /record_verified_storekit_ai_item_period\([\s\S]+v_storekit_event_id/i,
    );
  });

  it("removes the environment-blind service-role RPC signatures", () => {
    expect(migration).toMatch(
      /drop function public\.record_verified_revenuecat_ai_item_period\([\s\S]+\);/i,
    );
    expect(migration).toMatch(
      /drop function public\.require_revenuecat_reconciliation\([\s\S]+\);/i,
    );
    expect(migration).toMatch(/grant execute[\s\S]+to service_role/i);
  });
});
