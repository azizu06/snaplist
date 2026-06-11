"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createEbayAdapter, publishListingToEbay } from "@/lib/marketplace/ebay";

/**
 * Server action behind the "Publish to eBay" button on /listings/[listingId]
 * (issue #14). Thin wrapper: auth, then the shared publish service with the
 * REAL adapter (sandbox by default via EBAY_BASE_URL). The service persists
 * ebay_listing_id + ebay_status either way; this action just refreshes the page
 * (or surfaces the error in the query string) so the persisted state is shown.
 */
export async function publishToEbay(formData: FormData) {
  const listingId = formData.get("listingId");
  if (typeof listingId !== "string" || listingId.length === 0) {
    redirect("/");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/listings/${listingId}`);

  try {
    await publishListingToEbay(supabase, listingId, createEbayAdapter());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Publish failed.";
    revalidatePath(`/listings/${listingId}`);
    redirect(`/listings/${listingId}?error=${encodeURIComponent(message)}`);
  }

  revalidatePath(`/listings/${listingId}`);
  redirect(`/listings/${listingId}`);
}
