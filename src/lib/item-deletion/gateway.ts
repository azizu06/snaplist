import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ItemDeletionGateway } from "@/lib/mobile-api";
import { deleteItem } from "./service";

/**
 * Binds the #181 deletion executor to the native transport.
 *
 * Same shape as the assisted-export gateway and for the same reason: each call
 * builds a client from the caller's own bearer, so RLS and `delete_item` decide
 * what may be deleted exactly as they do for any other caller. Adding a
 * service-role path here would turn the one operation that destroys seller data
 * into the one operation nothing checks.
 */
export function createSupabaseItemDeletionGateway(
  clientFor: (bearerToken: string) => SupabaseClient,
): ItemDeletionGateway {
  return {
    delete: (input) =>
      deleteItem(clientFor(input.bearerToken), { itemId: input.itemId }),
  };
}

export function createConfiguredItemDeletionGateway(input: {
  supabaseURL: string;
  anonKey: string;
}): ItemDeletionGateway {
  return createSupabaseItemDeletionGateway((bearerToken) =>
    createClient(input.supabaseURL, input.anonKey, {
      accessToken: async () => bearerToken,
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  );
}
