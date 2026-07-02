import type { SupabaseClient } from "@supabase/supabase-js";
import { EbayApiError, type EbayAdapter } from "./types";
import { marketplaceCurrency, toEbayPublishRequest } from "./map";
import {
  PublishValidationError,
  isEbayAuthError,
  EBAY_RECONNECT_MESSAGE,
} from "./errors";
import { batchSignPhotoUrls } from "../../vision/photos";
import { createNotification } from "../../notifications";

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
 * ONLY — the local `status` lifecycle (draft/queued) is untouched, so review
 * and draft flows keep seeing the listing — and rethrows; re-running retries
 * cleanly because the adapter's SKU/offer steps are themselves idempotent.
 */

export interface PublishOutcome {
  listingId: string;
  ebayListingId: string;
  ebayOfferId: string | null;
  ebayStatus: "published";
  /** True when the stored result was returned (idempotent short-circuit, no eBay call); false when this call actually published. */
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

/**
 * The currency every persisted price is denominated in: the pricing pipeline's
 * comps (sold/asking lookups, depreciation tables) are USD. `prediction_logs`
 * stores a bare numeric, so this constant is the read-side's currency claim —
 * publishing under a different currency must reprice, never relabel.
 */
const PRICING_CURRENCY = "USD";

/**
 * `publishListingToEbay` + the seller's activity-feed notifications, shared by
 * BOTH entry points (the /listings/[listingId] server action and the
 * /api/ebay/publish route) so a publish behaves identically wherever it's
 * triggered — the route previously skipped the notifications the button fired.
 * Failures are recorded to the feed and RETHROWN for the caller's own error
 * handling; `createNotification` is fire-and-forget, so the feed can never
 * break the publish itself.
 */
export async function publishListingToEbayAndNotify(
  supabase: SupabaseClient,
  userId: string,
  listingId: string,
  adapter: EbayAdapter,
  options: PublishOptions = {},
): Promise<PublishOutcome> {
  let outcome: PublishOutcome;
  try {
    outcome = await publishListingToEbay(supabase, listingId, adapter, options);
  } catch (err) {
    // An AUTH failure (expired/invalid token) has ONE fix — reconnect eBay in
    // Settings — so the feed shows the actionable reconnect message, matching
    // the error banner both entry points surface, never the raw HTTP-401 text.
    const authError = isEbayAuthError(err);
    const userActionable =
      err instanceof PublishValidationError || err instanceof EbayApiError;
    await createNotification(supabase, {
      userId,
      kind: "listing_failed",
      title: "Couldn’t publish your listing to eBay",
      body: authError
        ? EBAY_RECONNECT_MESSAGE
        : userActionable
          ? (err as Error).message
          : "Something went wrong while publishing. Please try again.",
      href: `/listings/${listingId}`,
      listingId,
    });
    throw err;
  }

  // Notify only when this call ACTUALLY published (rides Realtime to the bell).
  // An idempotent retry (`alreadyPublished`) already produced this notification
  // the first time — re-emitting would spam the feed on every re-trigger.
  if (!outcome.alreadyPublished) {
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
      itemId: (published?.item_id as string | null) ?? null,
      listingId,
    });
  }
  return outcome;
}

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
    throw new PublishValidationError(`Listing ${listingId} not found (or not yours).`);
  }
  if (listing.platform !== "ebay") {
    throw new PublishValidationError(
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
    throw new PublishValidationError(
      `Listing ${listingId} has no usable price. Run the pipeline (or set a price) before publishing.`,
    );
  }

  // 4. Sign the private photo paths so eBay can fetch (and rehost) the images.
  const photoPaths = (item.photos as string[] | null) ?? [];
  const imageUrls = await signPhotoUrls(
    supabase,
    photoPaths,
    options.signedUrlTtlSeconds ?? SIGNED_URL_TTL_SECONDS,
  );

  // eBay requires at least one image, so an empty set is a GUARANTEED failed
  // publish. Fail fast LOCALLY — before the adapter makes any eBay call (no
  // partial remote writes) — through the same failed-publish path an adapter
  // error takes, with a user-attributable reason.
  if (imageUrls.length === 0) {
    await markPublishFailed(supabase, listingId);
    throw new PublishValidationError(
      photoPaths.length === 0
        ? `Listing ${listingId} has no photos, and eBay requires at least one image. ` +
          "Add a photo to the item before publishing."
        : `Listing ${listingId} has ${photoPaths.length} photo(s) but none could be ` +
          "signed into a fetchable URL, and eBay requires at least one image. " +
          "Re-upload the item's photos before publishing.",
    );
  }

  // The persisted price is a currency-less numeric produced by the pricing
  // pipeline, whose comps are USD. Publishing it under another marketplace's
  // currency would RELABEL the amount (100 USD listed as 100 GBP), materially
  // mispricing the live listing — so a non-USD marketplace is rejected unless
  // the operator explicitly declares the pricing currency via EBAY_CURRENCY
  // (the escape hatch for a future repricing flow whose numerics genuinely
  // are in that currency).
  const currency = marketplaceCurrency(env.EBAY_MARKETPLACE_ID, env.EBAY_CURRENCY);
  if (!env.EBAY_CURRENCY && currency !== PRICING_CURRENCY) {
    throw new PublishValidationError(
      `Listing ${listingId} cannot publish to ${env.EBAY_MARKETPLACE_ID}: its price ` +
        `was computed in ${PRICING_CURRENCY}, and relabeling the amount as ${currency} ` +
        "would misprice the live listing. Reprice for the target marketplace, or set " +
        "EBAY_CURRENCY explicitly if the persisted prices really are in that currency.",
    );
  }

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
    currency,
  });

  // 6. Publish through the adapter. An ADAPTER failure is persisted as
  //    ebay_status='failed' (then rethrown); persistence problems after a
  //    SUCCESSFUL publish must NOT be marked failed — the eBay listing is live.
  let result;
  try {
    result = await adapter.publishListing(request);
  } catch (err) {
    await markPublishFailed(supabase, listingId);
    throw err;
  }

  // 7. Persist the live ids + status on the listings row (the acceptance seam).
  //    `listed_price` / `last_priced_at` record the price the live listing
  //    actually carries and the price event — the stale-inventory repricing
  //    pipeline (issue #102) selects on and revises against these.
  const { error: updErr } = await supabase
    .from("listings")
    .update({
      ebay_listing_id: result.listingId,
      ebay_offer_id: result.offerId,
      ebay_status: "published",
      status: "published",
      listed_price: price,
      last_priced_at: new Date().toISOString(),
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

/**
 * Best-effort failed-publish marker; never masks the error being thrown.
 *
 * Writes ONLY `ebay_status` — that column exists precisely so an eBay failure
 * can be shown without destroying the local listing lifecycle (`status` stays
 * draft/queued and review/draft flows keep seeing the row). The update is also
 * conditional on the row not already being published: when two publish calls
 * overlap, the loser's eBay error must not downgrade the winner's live
 * listing to 'failed' (which would disable the stored-result fast path and
 * make every retry call eBay again).
 */
async function markPublishFailed(
  supabase: SupabaseClient,
  listingId: string,
): Promise<void> {
  await supabase
    .from("listings")
    .update({ ebay_status: "failed" })
    .eq("id", listingId)
    .or("ebay_status.is.null,ebay_status.neq.published")
    .then(undefined, () => undefined);
}

/**
 * Sign each private photo path, IN ORDER; a bad PATH is skipped (a genuinely
 * missing photo shouldn't block the rest), but a storage/transport failure
 * THROWS (`batchSignPhotoUrls`) so a transient outage surfaces as a retryable
 * internal error — never as "none of your photos could be signed, re-upload"
 * (Codex P2 on #98).
 */
async function signPhotoUrls(
  supabase: SupabaseClient,
  paths: string[],
  ttlSeconds: number,
): Promise<string[]> {
  const signed = await batchSignPhotoUrls(supabase, paths, { expiresIn: ttlSeconds });
  return paths
    .map((path) => signed.get(path))
    .filter((url): url is string => Boolean(url));
}
