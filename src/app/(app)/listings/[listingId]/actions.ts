"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import {
  createEbayAdapterForUser,
  publishListingToEbay,
  PublishValidationError,
} from "@/lib/marketplace/ebay";
import { logEvent } from "@/lib/observability";

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
    redirect("/dashboard");
  }

  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) redirect(`/login?next=/listings/${listingId}`);

  try {
    // Per-user tokens when the seller connected eBay (issue #17), env sandbox
    // credentials otherwise.
    await publishListingToEbay(
      supabase,
      listingId,
      await createEbayAdapterForUser(supabase),
    );
  } catch (err) {
    revalidatePath(`/listings/${listingId}`);
    // A validation error is user-actionable (no price, no photo, currency) — show
    // it so the seller can fix and retry. Internal/adapter errors are redacted and
    // logged server-side (CWE-209, #57).
    if (err instanceof PublishValidationError) {
      redirect(`/listings/${listingId}?error=${encodeURIComponent(err.message)}`);
    }
    logEvent("ebay.publish.action", {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    redirect(
      `/listings/${listingId}?error=${encodeURIComponent("Failed to publish to eBay. Please try again.")}`,
    );
  }

  revalidatePath(`/listings/${listingId}`);
  redirect(`/listings/${listingId}`);
}
