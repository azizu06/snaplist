import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../../supabase/migrations/20260727220000_ebay_publish_connection_generation.sql",
    import.meta.url,
  ),
  "utf8",
).replace(/\s+/g, " ");
const accountGenerationMigration = readFileSync(
  new URL(
    "../../../../supabase/migrations/20260714140000_ebay_account_generation_boundaries.sql",
    import.meta.url,
  ),
  "utf8",
).replace(/\s+/g, " ");
const durableCompletionPgTap = readFileSync(
  new URL(
    "../../../../supabase/tests/ebay_dispatch_durable_completion.test.sql",
    import.meta.url,
  ),
  "utf8",
).replace(/\s+/g, " ");

describe("eBay publish connection-generation migration", () => {
  it("pins the listing claim and provider lease to connection provenance", () => {
    expect(migration).toContain(
      "add column ebay_publish_connection_generation uuid",
    );
    expect(migration).toContain("add column connection_generation uuid");
    expect(migration).toContain("add column publish_claim_id uuid");
    expect(migration).toContain("add column ebay_publish_binding jsonb");
    expect(migration).toContain("add column publish_binding jsonb");
    expect(migration).toContain(
      "listing.ebay_publish_claim_id = p_publish_claim_id",
    );
    expect(migration).toContain(
      "listing.ebay_publish_connection_generation is not distinct from p_connection_generation",
    );
    expect(migration).toContain(
      "lease.connection_generation is not distinct from p_connection_generation",
    );
    expect(migration).toContain("lease.publish_claim_id = p_claim_id");
    expect(migration).toContain(
      "lease.publish_binding is not distinct from v_publish_binding",
    );
    expect(migration).toContain("lease.attempt_token = p_attempt_token");
    expect(migration).toContain(
      "listing.ebay_publish_connection_generation is null and listing.ebay_publish_binding is null",
    );
    expect(migration).toContain(
      "listing.ebay_publish_connection_generation = p_connection_generation and listing.ebay_publish_binding = jsonb_build_object(",
    );
  });

  it("revalidates the exact ready marketplace policy/location selection", () => {
    expect(migration).toContain(
      "connection.policy_location_bindings -> p_marketplace_id",
    );
    expect(migration).toContain("v_binding->>'state' <> 'ready'");
    expect(migration).toContain(
      "v_binding->>'marketplaceId' <> p_marketplace_id",
    );
    expect(migration).toContain(
      "v_binding->>'connectionGeneration' <> p_connection_generation::text",
    );
    for (const path of [
      "fulfillmentPolicy",
      "paymentPolicy",
      "returnPolicy",
      "inventoryLocation",
    ]) {
      expect(migration).toContain(`v_binding#>>'{${path},state}' <> 'bound'`);
      expect(migration).toContain(`v_binding#>>'{${path},selectedId}' <>`);
    }
    expect(migration).toContain(
      "listing.ebay_publish_binding is not distinct from p_publish_binding",
    );
    expect(migration).toContain(
      "v_binding#>>'{fulfillmentPolicy,selectedId}' <> p_publish_binding->>'fulfillmentPolicyId'",
    );
    expect(migration).toContain(
      "v_binding#>>'{inventoryLocation,selectedId}' <> p_publish_binding->>'merchantLocationKey'",
    );
  });

  it("rejects same-marketplace binding mutation while its publish lease is active", () => {
    const saveBindingFunction = migration.match(
      /create or replace function public\.save_ebay_policy_location_binding\(.*?(?=revoke all on function public\.save_ebay_policy_location_binding)/,
    )?.[0];

    expect(saveBindingFunction).toContain(
      "coalesce(auth.jwt()->>'role', '') <> 'authenticated'",
    );
    expect(saveBindingFunction).toContain("v_api_key not like 'sb_secret_%'");
    expect(saveBindingFunction).toContain("lease.user_id = v_user_id");
    expect(saveBindingFunction).toContain("lease.dispatch_kind = 'publish'");
    expect(saveBindingFunction).toContain(
      "lease.connection_generation = p_connection_generation",
    );
    expect(saveBindingFunction).toContain(
      "lease.publish_binding->>'marketplaceId' = p_marketplace_id",
    );
    expect(saveBindingFunction).toContain(
      "lease.expires_at > statement_timestamp()",
    );
    expect(saveBindingFunction).toContain(
      "errcode = 'PT409', message = 'eBay policy selection is in use by an active publish dispatch'",
    );
    expect(saveBindingFunction).toContain(
      "set policy_location_bindings = jsonb_set(",
    );
  });

  it("keeps the operator Sandbox fallback separate and null-safe", () => {
    expect(migration).toContain(
      "if p_connection_generation is not null then",
    );
    expect(migration).toContain(
      "from private.ebay_sandbox_fallback_bindings binding",
    );
    expect(migration).toContain(
      "binding.account_generation = p_account_generation",
    );
    expect(migration).toContain(
      "connection_generation', p_connection_generation",
    );
    expect(migration).toContain(
      "connection-generation columns in account-erasure residue",
    );
    expect(migration).not.toMatch(
      /create (?:or replace )?function (?:public|private)\.[a-z0-9_]*erase/i,
    );
  });

  it("does not expose deterministic application conflicts as retryable transactions", () => {
    const retryableApplicationConflicts = migration.match(
      /errcode = '40001'/g,
    );
    const deterministicApplicationConflicts = migration.match(
      /errcode = 'PT409'/g,
    );

    expect(retryableApplicationConflicts).toBeNull();
    expect(deterministicApplicationConflicts).toHaveLength(19);
    expect(migration).toContain(
      "errcode = 'PT409', message = 'eBay offer binding changed before provider dispatch'",
    );
    expect(migration).toContain(
      "errcode = 'PT409', message = 'eBay provider dispatch lease expired before local completion'",
    );
  });

  it("expects the deterministic completion conflict through PostgREST PT409", () => {
    expect(durableCompletionPgTap).toContain(
      "'PT409', 'eBay account generation changed before local completion'",
    );
    expect(durableCompletionPgTap).not.toContain(
      "'40001', 'eBay account generation changed before local completion'",
    );
    expect(durableCompletionPgTap).toContain(
      "set policy_location_bindings = jsonb_build_object(",
    );
    expect(durableCompletionPgTap).toContain(
      "ebay_publish_binding = jsonb_build_object(",
    );
    expect(
      durableCompletionPgTap.match(
        /'merchantLocationKey', 'dispatch-location'/g,
      ),
    ).toHaveLength(3);
  });

  it("locks the seller connection through a narrowly authorized server RPC", () => {
    const bindFunction = migration.match(
      /create function public\.bind_ebay_publish_connection_generation\(.*?(?=revoke all on function public\.bind_ebay_publish_connection_generation)/,
    )?.[0];

    expect(accountGenerationMigration).toContain(
      "drop policy if exists ebay_connections_update_own on public.ebay_connections",
    );
    expect(bindFunction).toContain("security definer");
    expect(bindFunction).not.toContain("security invoker");
    expect(bindFunction).toContain(
      "coalesce(auth.jwt()->>'role', '') <> 'authenticated'",
    );
    expect(bindFunction).toContain("v_api_key not like 'sb_secret_%'");
    expect(bindFunction).toContain("v_user_id text := public.clerk_user_id()");
    expect(bindFunction).toContain("for update");
  });
});
