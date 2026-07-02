import { NextResponse, type NextRequest } from "next/server";
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
import { logServerError, serverErrorJson } from "@/lib/api/errors";
import { enforceRateLimit } from "@/lib/abuse";

/**
 * eBay publish endpoint (issue #14).
 *
 * POST { listingId } — publish the caller's persisted listing to eBay through
 * the adapter (Sell API sandbox by default; production is an env flip) and
 * persist `ebay_listing_id` + `ebay_status` on the listings row.
 *
 * GET ?listingId=... — read back the persisted eBay state for a listing. This
 * is the minimal "shown in SnapList" surface alongside /listings/[listingId];
 * the review page (separately owned) can consume either without coordination.
 *
 * Tenancy: both verbs run on the request's USER-SCOPED server client, so RLS
 * makes a foreign listingId indistinguishable from a missing one (404).
 */

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const limited = await enforceRateLimit(request, userId);
  if (limited) return limited;

  const body: unknown = await request.json().catch(() => undefined);
  const listingId = (body as { listingId?: unknown } | undefined)?.listingId;
  if (typeof listingId !== "string" || listingId.length === 0) {
    return NextResponse.json(
      { error: "Body must be JSON: { listingId: string }." },
      { status: 400 },
    );
  }

  try {
    // Per-user tokens when the seller connected eBay in Settings (issue #17);
    // app-level env credentials otherwise (the sandbox loop). The shared wrapper
    // fires the same activity-feed notifications the "Publish" button does.
    const outcome = await publishListingToEbayAndNotify(
      supabase,
      userId,
      listingId,
      await createEbayAdapterForUser(supabase),
    );
    return NextResponse.json(outcome, { status: 200 });
  } catch (err) {
    // User-actionable validation errors carry a SAFE message the seller can act on
    // (no price, no photo, currency, not found) — surface it. Everything else
    // (adapter/Supabase/upstream) is redacted to a generic message with the real
    // error logged server-side (CWE-209, #57).
    if (err instanceof PublishValidationError) {
      const status = /not found/i.test(err.message) ? 404 : 422;
      return NextResponse.json({ error: err.message }, { status });
    }
    // EbayApiError carries an author-controlled, user-actionable summary — surface
    // it; the raw payload (`.body`) is never exposed. An AUTH failure (expired/
    // invalid token) is normalized to the ONE actionable reconnect message instead
    // of the raw HTTP-401 text. Plain errors (Supabase/internal) are redacted.
    if (err instanceof EbayApiError) {
      return NextResponse.json(
        { error: isEbayAuthError(err) ? EBAY_RECONNECT_MESSAGE : err.message },
        { status: 502 },
      );
    }
    logServerError("ebay.publish", err);
    return NextResponse.json({ error: "Failed to publish to eBay." }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const listingId = request.nextUrl.searchParams.get("listingId");
  if (!listingId) {
    return NextResponse.json(
      { error: "Missing listingId query parameter." },
      { status: 400 },
    );
  }

  const { data: listing, error } = await supabase
    .from("listings")
    .select("id, status, ebay_listing_id, ebay_offer_id, ebay_status")
    .eq("id", listingId)
    .maybeSingle();
  if (error) {
    return serverErrorJson("ebay.publish.get", error, "Failed to read listing status.");
  }
  if (!listing) {
    return NextResponse.json({ error: "Listing not found." }, { status: 404 });
  }

  return NextResponse.json({
    listingId: listing.id,
    status: listing.status,
    ebayListingId: listing.ebay_listing_id ?? null,
    ebayOfferId: listing.ebay_offer_id ?? null,
    ebayStatus: listing.ebay_status ?? null,
  });
}
