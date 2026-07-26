import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  ebayPolicyLocationBindingSchema,
  type EbayPolicyLocationBinding,
} from "./policy-location-contract";
import type { EbayPolicyLocationBindingStore } from "./policy-location-discovery";

const connectionContextSchema = z
  .object({
    account_generation: z.string().uuid(),
    connection_generation: z.string().uuid(),
  })
  .strict();

export function createSupabaseEbayPolicyLocationBindingStore(
  supabase: SupabaseClient,
): EbayPolicyLocationBindingStore {
  return {
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
