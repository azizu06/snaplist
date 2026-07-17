import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260717010000_revenuecat_storekit_entitlement_bridge.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("RevenueCat StoreKit entitlement bridge migration", () => {
  it("keeps a server-owned tenant and original-transaction binding", () => {
    expect(migration).toMatch(/create table public\.revenuecat_customer_bindings/i);
    expect(migration).toMatch(/user_id text primary key/i);
    expect(migration).toMatch(/revenuecat_app_user_id text not null unique/i);
    expect(migration).toMatch(/original_transaction_id text unique/i);
    expect(migration).toMatch(/transition_state in \('not_required', 'required', 'reconciled'\)/i);
    expect(migration).toMatch(/pg_advisory_xact_lock/i);
  });

  it("allows RLS reads but no client or generic service-role writes", () => {
    expect(migration).toMatch(
      /alter table public\.revenuecat_customer_bindings enable row level security/i,
    );
    expect(migration).toMatch(/create policy revenuecat_customer_bindings_select_own/i);
    expect(migration).toMatch(
      /revoke all on table public\.revenuecat_customer_bindings[\s\S]+authenticated, service_role/i,
    );
    expect(migration).toMatch(
      /grant select on table public\.revenuecat_customer_bindings to authenticated/i,
    );
  });

  it("wraps #168 through narrow service-only idempotent functions", () => {
    expect(migration).toMatch(/private\.revenuecat_webhook_events/i);
    expect(migration).toMatch(/public\.bind_revenuecat_customer/i);
    expect(migration).toMatch(/public\.resolve_revenuecat_customer/i);
    expect(migration).toMatch(/public\.record_verified_revenuecat_ai_item_period/i);
    expect(migration).toMatch(/public\.record_verified_storekit_ai_item_period/i);
    expect(migration).toMatch(/public\.require_revenuecat_reconciliation/i);
    expect(migration).toMatch(/public\.reconcile_revenuecat_billing_source/i);
    expect(migration).toMatch(/grant execute[\s\S]+to service_role/i);
    expect(migration).not.toMatch(
      /grant execute on function public\.record_verified_revenuecat_ai_item_period[\s\S]+to authenticated/i,
    );
  });

  it("detects legacy Stripe state without making it the native quota source", () => {
    expect(migration).toMatch(/legacy_stripe_status/i);
    expect(migration).toMatch(/from public\.subscriptions/i);
    expect(migration).toMatch(/transition_state = 'required'/i);
    expect(migration).not.toMatch(/insert into public\.ai_item_allowance_periods[\s\S]+stripe/i);
  });
});
