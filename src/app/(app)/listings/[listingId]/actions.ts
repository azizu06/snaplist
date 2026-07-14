"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import {
  createEbayAdapterForUser,
  publishListingToEbayAndNotify,
  PublishValidationError,
  EbayApiError,
  isEbayAuthError,
  EBAY_RECONNECT_MESSAGE,
} from "@/lib/marketplace/ebay";
import { reportServerError } from "@/lib/sentry";
import { rateLimitAllows } from "@/lib/abuse";
import { createTenantServerClient } from "@/lib/supabase/tenant-server";

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

  // Rate-limit the eBay write here too — this server action is the path the
  // "Publish" button actually uses; the API route's limit alone would be bypassed
  // (#58, ADR-0004). Shares the per-user metered bucket with the route.
  if (!(await rateLimitAllows(userId))) {
    redirect(
      `/listings/${listingId}?error=${encodeURIComponent("Too many requests. Please slow down and try again shortly.")}`,
    );
  }

  try {
    // Per-user tokens when the seller connected eBay (issue #17), env sandbox
    // credentials otherwise. The shared wrapper owns the activity-feed
    // notifications (success AND failure), so the API route behaves identically.
    const completionClient = await createTenantServerClient();
    await publishListingToEbayAndNotify(
      supabase,
      userId,
      listingId,
      await createEbayAdapterForUser(supabase, userId, {
        credentialClient: completionClient,
      }),
      { completionClient },
    );
  } catch (err) {
    revalidatePath(`/listings/${listingId}`);
    // An AUTH failure (expired/invalid token) has ONE fix — reconnect eBay in
    // Settings — so the error banner shows the actionable reconnect message,
    // never the raw HTTP-401 text or a misleading generic "try again". The
    // activity-feed notification is owned by publishListingToEbayAndNotify,
    // which applies the same reconnect message for auth failures.
    if (isEbayAuthError(err)) {
      redirect(
        `/listings/${listingId}?error=${encodeURIComponent(EBAY_RECONNECT_MESSAGE)}`,
      );
    }
    // A validation error (no price/photo/currency) or an EbayApiError (eBay's
    // own validation message) carries a SAFE, user-actionable message — show it
    // so the seller can fix and retry. Internal/Supabase errors are redacted
    // and logged server-side (CWE-209, #57).
    if (err instanceof PublishValidationError || err instanceof EbayApiError) {
      redirect(`/listings/${listingId}?error=${encodeURIComponent(err.message)}`);
    }
    reportServerError("ebay.publish.action", err, { listingId });
    redirect(
      `/listings/${listingId}?error=${encodeURIComponent("Failed to publish to eBay. Please try again.")}`,
    );
  }

  revalidatePath(`/listings/${listingId}`);
  redirect(`/listings/${listingId}`);
}
