import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  ebayPolicyLocationBindingSchema,
  type EbayPolicyLocationBinding,
} from "./policy-location-contract";
import type { EbayPolicyLocationSetupStore } from "./policy-location-setup";

/**
 * These parse OUR OWN `ebay_connections` row, narrowed by the `select()` above
 * each read, so they validate the columns we consume and ignore anything else
 * the row carries. Rejecting extra keys would buy no safety — the row is ours,
 * not seller input — and would make the read brittle against a new column or a
 * test double that does not model column projection.
 */
const connectionContextSchema = z.object({
  account_generation: z.string().uuid(),
  connection_generation: z.string().uuid(),
});

const storedBindingRowSchema = z.object({
  connection_generation: z.string().uuid(),
  policy_location_bindings: z.unknown().optional(),
});

export function createSupabaseEbayPolicyLocationBindingStore(
  supabase: SupabaseClient,
): EbayPolicyLocationSetupStore {
  return {
    /**
     * The binding jsonb for ONE marketplace plus the connection generation it
     * must match, read under the caller's RLS client (issue #47). Returns the
     * raw stored value; the setup service is the single place that decides
     * whether it is usable, so a malformed or retired binding can never reach a
     * publish by way of a permissive read.
     */
    async readStoredBinding(marketplaceId: string) {
      const { data, error } = await supabase
        .from("ebay_connections")
        .select("connection_generation, policy_location_bindings")
        .maybeSingle();
      if (error) {
        throw new Error(`Failed to read eBay policy setup: ${error.message}`);
      }
      if (!data) return null;
      const row = storedBindingRowSchema.parse(data);
      const bindings = row.policy_location_bindings;
      return {
        connectionGeneration: row.connection_generation,
        binding:
          bindings && typeof bindings === "object" && !Array.isArray(bindings)
            ? (bindings as Record<string, unknown>)[marketplaceId]
            : undefined,
      };
    },

    async readConnectionContext() {
      const { data, error } = await supabase
        .from("ebay_connections")
        .select("account_generation, connection_generation")
        .maybeSingle();
      if (error) {
        throw new Error(`Failed to read eBay policy setup: ${error.message}`);
      }
      if (!data) return null;
      const row = connectionContextSchema.parse(data);
      return {
        accountGeneration: row.account_generation,
        connectionGeneration: row.connection_generation,
      };
    },

    async saveBinding(binding: EbayPolicyLocationBinding) {
      const safeBinding = ebayPolicyLocationBindingSchema.parse(binding);
      const { data, error } = await supabase.rpc(
        "save_ebay_policy_location_binding",
        {
          p_marketplace_id: safeBinding.marketplaceId,
          p_connection_generation: safeBinding.connectionGeneration,
          p_binding: safeBinding,
        },
      );
      if (error) {
        throw new Error(`Failed to save eBay policy setup: ${error.message}`);
      }
      return ebayPolicyLocationBindingSchema.parse(data);
    },
  };
}
