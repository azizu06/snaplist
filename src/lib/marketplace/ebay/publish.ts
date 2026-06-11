import type { SupabaseClient } from "@supabase/supabase-js";
import type { EbayAdapter } from "./types";
import { toEbayPublishRequest } from "./map";

/**
 * Publish ONE persisted SnapList listing to eBay through the adapter seam and
 * persist the outcome (issue #14): listings row -> `EbayPublishRequest` ->
 * adapter (mock in tests, Sell API sandbox/production for real) ->
 * `ebay_listing_id` + `ebay_status` written back onto the SAME listings row.
 *
 * Tenancy: everything goes through the caller's USER-SCOPED Supabase client, so
 * RLS gates both the read (you can only publish your own listing — a foreign id
 * simply isn't found) and the write-back. No service-role anywhere.
 *
 * Idempotent: a listing that already published returns its stored result
 * without another eBay call. A FAILED publish persists ebay_status='failed'
 * (status='failed' too — the PRD lifecycle) and rethrows; re-running retries
 * cleanly because the adapter's SKU/offer steps are themselves idempotent.
 */

export interface PublishOutcome {
  listingId: string;
  ebayListingId: string;
  ebayOfferId: string | null;
  ebayStatus: "published";
  /** True when this call hit eBay; false when the stored result was returned. */
  alreadyPublished: boolean;
}

export interface PublishOptions {
  /** Injectable env reader; defaults to process.env. Read lazily per call. */
  env?: () => Record<string, string | undefined>;
  /**
   * TTL for the signed photo URLs handed to eBay. eBay copies images into its
   * own hosting at listing time, so the URL only has to outlive the publish
   * call; 7 days is comfortable for retries.
   */
  signedUrlTtlSeconds?: number;
}

/**
 * Fallback leaf category when EBAY_DEFAULT_CATEGORY_ID is unset: eBay's
 * "Everything Else > Other" — the generic catch-all. Real category resolution
 * is a follow-up slice; the env var overrides this without a code change.
 */
const GENERIC_CATEGORY_ID = "88433";

const SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function publishListingToEbay(
  supabase: SupabaseClient,
  listingId: string,
  adapter: EbayAdapter,
  options: PublishOptions = {},
): Promise<PublishOutcome> {
  const env = options.env?.() ?? process.env;

  // 1. Load the listing UNDER RLS — a foreign or unknown id is simply not found.
  const { data: listing, error: listingErr } = await supabase
    .from("listings")
    .select(
      "id, item_id, platform, title, description, copy, status, ebay_listing_id, ebay_offer_id, ebay_status",
    )
    .eq("id", listingId)
    .maybeSingle();
  if (listingErr) {
    throw new Error(`Failed to load listing: ${listingErr.message}`);
  }
  if (!listing) {
    throw new Error(`Listing ${listingId} not found (or not yours).`);
  }
  if (listing.platform !== "ebay") {
    throw new Error(
      `Listing ${listingId} targets platform "${listing.platform}", not eBay.`,
    );
  }

  // 2. Idempotency: already live -> return the stored result, no eBay call.
  if (listing.ebay_listing_id && listing.ebay_status === "published") {
    return {
      listingId,
      ebayListingId: listing.ebay_listing_id as string,
      ebayOfferId: (listing.ebay_offer_id as string | null) ?? null,
      ebayStatus: "published",
      alreadyPublished: true,
    };
  }

  // 3. Pull the item (condition + photos) and the run's price.
  const { data: item, error: itemErr } = await supabase
    .from("items")
    .select("condition, photos")
    .eq("id", listing.item_id)
    .maybeSingle();
  if (itemErr || !item) {
    throw new Error(
      `Failed to load item for listing ${listingId}: ${itemErr?.message ?? "not found"}`,
    );
  }

  const { data: log, error: logErr } = await supabase
    .from("prediction_logs")
    .select("price")
    .eq("item_id", listing.item_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (logErr) {
    throw new Error(`Failed to load price for listing ${listingId}: ${logErr.message}`);
  }
  const price = log?.price == null ? NaN : Number(log.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(
      `Listing ${listingId} has no usable price — run the pipeline (or set a price) before publishing.`,
    );
  }

  // 4. Sign the private photo paths so eBay can fetch (and rehost) the images.
  const photoPaths = (item.photos as string[] | null) ?? [];
  const imageUrls = await signPhotoUrls(
    supabase,
    photoPaths,
    options.signedUrlTtlSeconds ?? SIGNED_URL_TTL_SECONDS,
  );

  // 5. Map onto the provider shape (pure; throws on unpublishable input).
  const request = toEbayPublishRequest({
    listingId,
    title: (listing.title as string | null) ?? "",
    description: (listing.description as string | null) ?? "",
    copy: (listing.copy as Record<string, unknown> | null) ?? {},
    condition: item.condition as string | null,
    price,
    imageUrls,
    categoryId: env.EBAY_DEFAULT_CATEGORY_ID ?? GENERIC_CATEGORY_ID,
  });

  // 6. Publish through the adapter. An ADAPTER failure is persisted as
  //    ebay_status='failed' (then rethrown); persistence problems after a
  //    SUCCESSFUL publish must NOT be marked failed — the eBay listing is live.
  let result;
  try {
    result = await adapter.publishListing(request);
  } catch (err) {
    // Best-effort failure marker; never mask the original error.
    await supabase
      .from("listings")
      .update({ ebay_status: "failed", status: "failed" })
      .eq("id", listingId)
      .then(undefined, () => undefined);
    throw err;
  }

  // 7. Persist the live ids + status on the listings row (the acceptance seam).
  const { error: updErr } = await supabase
    .from("listings")
    .update({
      ebay_listing_id: result.listingId,
      ebay_offer_id: result.offerId,
      ebay_status: "published",
      status: "published",
    })
    .eq("id", listingId);
  if (updErr) {
    // The eBay listing IS live; surface a loud, specific error so the operator
    // reconciles instead of the next retry silently double-publishing.
    throw new Error(
      `eBay listing ${result.listingId} published but persisting it failed: ${updErr.message}`,
    );
  }

  return {
    listingId,
    ebayListingId: result.listingId,
    ebayOfferId: result.offerId,
    ebayStatus: "published",
    alreadyPublished: false,
  };
}

/** Sign each private photo path; skip (don't fail the publish) on a bad path. */
async function signPhotoUrls(
  supabase: SupabaseClient,
  paths: string[],
  ttlSeconds: number,
): Promise<string[]> {
  const urls: string[] = [];
  for (const path of paths) {
    const { data } = await supabase.storage
      .from("photos")
      .createSignedUrl(path, ttlSeconds);
    if (data?.signedUrl) urls.push(data.signedUrl);
  }
  return urls;
}
