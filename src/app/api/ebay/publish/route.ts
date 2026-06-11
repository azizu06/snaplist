import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createEbayAdapter, publishListingToEbay } from "@/lib/marketplace/ebay";

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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => undefined);
  const listingId = (body as { listingId?: unknown } | undefined)?.listingId;
  if (typeof listingId !== "string" || listingId.length === 0) {
    return NextResponse.json(
      { error: "Body must be JSON: { listingId: string }." },
      { status: 400 },
    );
  }

  try {
    const outcome = await publishListingToEbay(
      supabase,
      listingId,
      createEbayAdapter(),
    );
    return NextResponse.json(outcome, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Publish failed.";
    const status = /not found/i.test(message) ? 404 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
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
    return NextResponse.json({ error: error.message }, { status: 500 });
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
