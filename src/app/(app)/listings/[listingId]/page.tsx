import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import { isLiveListingRow } from "@/lib/ui/status";
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
  const userId = await getUserId();
  if (!userId) redirect(`/login?next=/listings/${listingId}`);

  // RLS scopes to the owner; a foreign/missing id returns no row → 404.
  const { data: listing } = await supabase
    .from("listings")
    .select(
      "id, item_id, platform, title, description, status, ebay_listing_id, ebay_status",
    )
    .eq("id", listingId)
    .maybeSingle();
  if (!listing) notFound();

  // The ONE definition of "live on eBay" (shared with the dashboard guards) so
  // the predicate can't drift between the publish page and the mutation paths.
  const published = isLiveListingRow(listing);

  // A short-lived signed thumbnail so the preview looks like the buyer's view,
  // not a wall of text. Same read pattern as the review/export pages.
  let photoUrl: string | null = null;
  const { data: item } = await supabase
    .from("items")
    .select("photos")
    .eq("id", listing.item_id)
    .maybeSingle();
  const photoPaths = (item?.photos as string[] | null) ?? [];
  if (photoPaths.length > 0) {
    const { data: signed } = await supabase.storage
      .from("photos")
      .createSignedUrl(photoPaths[0], 60 * 10);
    photoUrl = signed?.signedUrl ?? null;
  }

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
    photoUrl,
    actionError: error ?? null,
  };

  return <PublishView data={data} publishAction={publishToEbay} />;
}
