import type { SupabaseClient } from "@supabase/supabase-js";
import { createEbayMessagingAdapterForUser } from "@/lib/marketplace/ebay";
import type { MarketplaceMessagingAdapter } from "@/lib/marketplace/messaging";
import { SimulatedMarketplaceMessagingAdapter } from "@/lib/marketplace/simulated-messaging";
import { createAdminClient } from "@/lib/supabase/admin";
import { SupabaseDeliveryRepository } from "./transport";

/** Compose transport by the persisted conversation source, never by caller input. */
export async function createMessagingAdapterForConversation(
  supabase: SupabaseClient,
  userId: string,
  marketplace: string | null | undefined,
): Promise<MarketplaceMessagingAdapter> {
  return marketplace === "ebay"
    ? createEbayMessagingAdapterForUser(supabase, userId)
    : new SimulatedMarketplaceMessagingAdapter();
}

export async function createMessagingTransportForConversation(
  supabase: SupabaseClient,
  userId: string,
  marketplace: string | null | undefined,
) {
  const persistenceClient =
    marketplace === "ebay" ? createAdminClient() : supabase;
  return {
    repository: new SupabaseDeliveryRepository(persistenceClient, userId),
    adapter: await createMessagingAdapterForConversation(
      persistenceClient,
      userId,
      marketplace,
    ),
  };
}
