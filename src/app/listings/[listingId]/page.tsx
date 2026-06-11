import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { publishToEbay } from "./actions";
import { PublishView, type PublishData } from "./publish-view";

/**
 * Listing publish page (issue #14; #40 round 2 skin). Data assembly only —
 * reads the persisted eBay state (`ebay_listing_id`, `ebay_status`) through
 * the user-scoped client and feeds PublishView. The publish action and the
 * X-3/X-8/X-9 states (pending button, plain-language failure + retry, real
 * success moment) are unchanged.
 */
export default async function ListingPage({
  params,
  searchParams,
}: {
  params: Promise<{ listingId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { listingId } = await params;
  const { error } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/listings/${listingId}`);

  // RLS scopes to the owner; a foreign/missing id returns no row → 404.
  const { data: listing } = await supabase
    .from("listings")
    .select(
      "id, item_id, platform, title, description, status, ebay_listing_id, ebay_status",
    )
    .eq("id", listingId)
    .maybeSingle();
  if (!listing) notFound();

  const published = Boolean(
    listing.ebay_status === "published" && listing.ebay_listing_id,
  );

  const data: PublishData = {
    listingId: listing.id as string,
    itemId: listing.item_id as string,
    platform: listing.platform as string,
    title: (listing.title as string | null) ?? "Untitled",
    description: (listing.description as string | null) ?? "",
    status: listing.status as string | null,
    published,
    failed: listing.ebay_status === "failed",
    ebayListingId: (listing.ebay_listing_id as string | null) ?? null,
    actionError: error ?? null,
  };

  return <PublishView data={data} publishAction={publishToEbay} />;
}
