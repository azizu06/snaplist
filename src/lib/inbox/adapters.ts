import type { SupabaseClient } from "@supabase/supabase-js";
import { createEbayMessagingAdapterForUser } from "@/lib/marketplace/ebay";
import type { MarketplaceMessagingAdapter } from "@/lib/marketplace/messaging";
import { SimulatedMarketplaceMessagingAdapter } from "@/lib/marketplace/simulated-messaging";

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
