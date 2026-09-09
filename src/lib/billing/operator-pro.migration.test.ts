import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260909120000_operator_pro_allowance.sql",
    import.meta.url,
  ),
  "utf8",
);

const ledger = readFileSync(
  new URL(
    "../../../supabase/migrations/20260716180000_ai_item_credit_ledger.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("operator Pro allowance migration", () => {
  it("adds an allowance source that is neither the included offer nor a store period", () => {
    expect(migration).toMatch(
      /drop constraint ai_item_allowance_periods_source_check/i,
    );
    expect(migration).toMatch(
      /source in \('included', 'operator', 'storekit'\)/i,
    );
    // The operator row carries one stable identity, no transaction, and is
    // always active: nothing about it can be read back as a purchase.
    expect(migration).toMatch(
      /source = 'operator'[\s\S]{0,400}?period_key = 'operator-pro-grant'[\s\S]{0,200}?original_transaction_id is null[\s\S]{0,200}?state = 'active'/i,
    );
  });

  it("never fabricates a RevenueCat customer or a StoreKit transaction span", () => {
    // Reading a binding for its `transition_state` is what the entitlement
    // function already did. Writing one would be the fabrication.
    for (const table of [
      "revenuecat_customer_bindings",
      "storekit_ai_item_period_events",
      "revenuecat_reconciliation_requirements",
    ]) {
      expect(migration).not.toMatch(
        new RegExp(`(?:insert into|update)\\s+(?:public|private)\\.${table}`, "i"),
      );
    }
    expect(migration).not.toMatch(
      /record_verified_(?:revenuecat|storekit)_ai_item_period/i,
    );
    // An operator row has no notification to replay, so the event columns stay
    // null exactly as they do for the included offer.
    expect(migration).toMatch(
      /last_event_id is null and last_event_created_at is null[\s\S]{0,200}?source in \('included', 'operator'\)/i,
    );
  });

  it("grants the allowance only through a service-role capability that checks an exact Clerk subject", () => {
    expect(migration).toMatch(
      /create or replace function public\.grant_operator_ai_item_allowance\(\s*p_user_id text,\s*p_allowance integer\s*\)/i,
    );
    expect(migration).toMatch(/security definer/i);
    expect(migration).toMatch(/set search_path = ''/i);
    expect(migration).toMatch(
      /revoke all on function public\.grant_operator_ai_item_allowance\(text, integer\)\s*from public, anon, authenticated, service_role/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.grant_operator_ai_item_allowance\(text, integer\)\s*to service_role/i,
    );
    expect(migration).not.toMatch(
      /grant execute on function public\.grant_operator_ai_item_allowance\(text, integer\)\s*to (?:anon|authenticated)/i,
    );
    // The database refuses a guest principal, an email, or a wildcard even if
    // the environment layer above it were ever bypassed.
    expect(migration).toMatch(/\^user_\[A-Za-z0-9\]\{1,120\}\$/);
    expect(migration).toMatch(/p_allowance (?:is null or p_allowance )?not between 1 and 10000/i);
  });

  it("reserves an operator run before the paid path and still writes a ledger row", () => {
    expect(migration).toMatch(
      /create or replace function private\.reserve_ai_item_credit_for_pipeline_run\(\)/i,
    );
    // The operator period is consulted only after the included offer declines,
    // and before the StoreKit lookup that raises `snaplist-pro-required`.
    const operatorAt = migration.search(/source = 'operator'\s*\n\s*and period\.state = 'active'/i);
    const storekitAt = migration.search(/source = 'storekit'\s*\n\s*and period\.period_start <= v_now/i);
    expect(operatorAt).toBeGreaterThan(-1);
    expect(storekitAt).toBeGreaterThan(-1);
    expect(operatorAt).toBeLessThan(storekitAt);
    // Every operator run is still recorded: the reservation insert is reached
    // on the operator path exactly as it is on the included and paid paths.
    expect(migration).toMatch(
      /insert into public\.ai_item_credit_reservations[\s\S]{0,600}?on conflict \(pipeline_run_id\) do nothing/i,
    );
    // The existing denial vocabulary is untouched.
    for (const reason of [
      "device-fence-required",
      "snaplist-pro-required",
      "storekit-entitlement-unavailable",
      "monthly-allowance-reached",
    ]) {
      expect(migration).toContain(reason);
    }
  });

  it("projects the grant through the frozen client envelope without claiming a store purchase", () => {
    expect(migration).toMatch(
      /create or replace function public\.get_verified_ai_item_entitlement\(/i,
    );
    // The shipped Swift enum accepts only included | storekit | none, so the
    // operator period reports the non-purchase value and an active status.
    expect(migration).toMatch(
      /v_operator[\s\S]{0,600}?'included'::text,\s*'active'::text/i,
    );
    expect(migration).not.toMatch(/'operator'::text,\s*'active'::text/i);
    // Whatever the projection says, the durable marker reconciliation reads is
    // the ledger's own source column.
    expect(ledger).toMatch(/source = 'storekit'/i);
    expect(migration).toMatch(/source = 'operator'/i);
  });
});
