import type { SupabaseClient } from "@supabase/supabase-js";
import { createEbayMessagingAdapterForUser } from "@/lib/marketplace/ebay";
import type { MarketplaceMessagingAdapter } from "@/lib/marketplace/messaging";
import { SimulatedMarketplaceMessagingAdapter } from "@/lib/marketplace/simulated-messaging";
import { createTenantServerClient } from "@/lib/supabase/tenant-server";
import { SupabaseDeliveryRepository } from "./transport";

/** Compose transport by the persisted conversation source, never by caller input. */
export async function createMessagingAdapterForConversation(
  supabase: SupabaseClient,
  userId: string,
  marketplace: string | null | undefined,
  credentialClient: SupabaseClient = supabase,
): Promise<MarketplaceMessagingAdapter> {
  return marketplace === "ebay"
    ? createEbayMessagingAdapterForUser(supabase, userId, { credentialClient })
    : new SimulatedMarketplaceMessagingAdapter();
}

export async function createMessagingTransportForConversation(
  supabase: SupabaseClient,
  userId: string,
  marketplace: string | null | undefined,
) {
  const serverWriteClient =
    marketplace === "ebay" ? await createTenantServerClient() : supabase;
  return {
    repository: new SupabaseDeliveryRepository(
      supabase,
      userId,
      marketplace === "ebay",
      serverWriteClient,
    ),
    adapter: await createMessagingAdapterForConversation(
      supabase,
      userId,
      marketplace,
      serverWriteClient,
    ),
  };
}
