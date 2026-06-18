"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import {
  createEbayAdapterForUser,
  publishListingToEbay,
  PublishValidationError,
  EbayApiError,
} from "@/lib/marketplace/ebay";
import { reportServerError } from "@/lib/sentry";
import { rateLimitAllows } from "@/lib/abuse";
import { createNotification } from "@/lib/notifications";

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
    // credentials otherwise.
    await publishListingToEbay(
      supabase,
      listingId,
      await createEbayAdapterForUser(supabase),
    );
  } catch (err) {
    revalidatePath(`/listings/${listingId}`);
    const userActionable =
      err instanceof PublishValidationError || err instanceof EbayApiError;
    // Activity feed: a publish that didn't go through is worth a notification.
    await createNotification(supabase, {
      userId,
      kind: "listing_failed",
      title: "Couldn’t publish your listing to eBay",
      body: userActionable
        ? err.message
        : "Something went wrong while publishing. Please try again.",
      href: `/listings/${listingId}`,
      listingId,
    });
    // A validation error (no price/photo/currency) or an EbayApiError (reconnect
    // guidance, eBay's own validation message) carries a SAFE, user-actionable
    // message — show it so the seller can fix and retry. Internal/Supabase errors
    // are redacted and logged server-side (CWE-209, #57).
    if (userActionable) {
      redirect(`/listings/${listingId}?error=${encodeURIComponent(err.message)}`);
    }
    reportServerError("ebay.publish.action", err, { listingId });
    redirect(
      `/listings/${listingId}?error=${encodeURIComponent("Failed to publish to eBay. Please try again.")}`,
    );
  }

  // Activity feed: the listing is live → notify (rides Realtime to the bell).
  const { data: published } = await supabase
    .from("listings")
    .select("title, item_id")
    .eq("id", listingId)
    .maybeSingle();
  await createNotification(supabase, {
    userId,
    kind: "listing_published",
    title: published?.title
      ? `“${published.title}” is live on eBay`
      : "Your listing is live on eBay",
    body: "Buyers can find it now — view or edit it anytime.",
    href: `/listings/${listingId}`,
    itemId: published?.item_id ?? null,
    listingId,
  });

  revalidatePath(`/listings/${listingId}`);
  redirect(`/listings/${listingId}`);
}
