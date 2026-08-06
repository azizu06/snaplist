import type { SupabaseClient } from "@supabase/supabase-js";
import {
  EbayApiError,
  EbayWriteAmbiguousError,
  type EbayAdapter,
  type EbayDispatchContext,
  type EbayPublishRequest,
  type EbayPublishResult,
} from "./types";
import { marketplaceCurrency, toEbayPublishRequest } from "./map";
import type { EbayPolicyLocationBinding } from "./policy-location-contract";
import { createSupabaseEbayPolicyLocationBindingStore } from "./policy-location-store";
import {
  EBAY_POLICY_SETUP_NOT_CONNECTED_MESSAGE,
  ensureEbayPolicyLocationBinding,
} from "./policy-location-setup";
import {
  PublishValidationError,
  isEbayAuthError,
  EBAY_RECONNECT_MESSAGE,
} from "./errors";
import { createNotification } from "../../notifications";
import { effectivePrice } from "../../pipeline";
import {
  issueEbayPhotoUrls,
  resolveEbayPhotoBaseUrl,
} from "./photo-access";

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
 * without another eBay call. Before external work, an atomic revision/run-id
 * claim freezes one coherent review snapshot and excludes concurrent edits or
 * publishes. The claimed amount uses a valid seller override first and the latest
 * prediction only as fallback, without rewriting recommendation history. A
 * FAILED publish persists ebay_status='failed', clears its claim lease, and
 * leaves the local `status` lifecycle (draft/queued) untouched, so review/draft
 * flows keep seeing the listing and a retry stays safe.
 */

export interface PublishOutcome {
  listingId: string;
  ebayListingId: string;
  ebayOfferId: string | null;
  listingUrl: string | null;
  ebayStatus: "published";
  /** True when the stored result was returned (idempotent short-circuit, no eBay call); false when this call actually published. */
  alreadyPublished: boolean;
}

export interface PublishOptions {
  /** Injectable env reader; defaults to process.env. Read lazily per call. */
  env?: () => Record<string, string | undefined>;
  /** Public SnapList origin hosting the short eBay media route. */
  photoBaseUrl?: string;
  /** Seven days preserves the prior bounded retry window. */
  photoUrlTtlSeconds?: number;
  completionClient?: SupabaseClient;
  /** Client-observed review token. Mobile publish must supply this and fail closed when stale. */
  expectedReviewRevision?: string;
  /** Durable mobile confirmation key used to resume an ambiguous provider write. */
  idempotencyKey?: string;
}

interface PublishClaimSnapshot {
  claimId: string;
  listingId: string;
  itemId: string;
  title: string | null;
  description: string | null;
  copy: Record<string, unknown>;
  condition: string | null;
  photos: string[];
  price: number | string | null;
  priceOverride: number | string | null;
}

interface EbayOfferBinding {
  marketplaceId: string;
  connectionGeneration: string | null;
  fulfillmentPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
  merchantLocationKey: string;
}

/**
 * Fallback leaf category when EBAY_DEFAULT_CATEGORY_ID is unset: eBay's
 * "Everything Else > Other" — the generic catch-all. Real category resolution
 * is a follow-up slice; the env var overrides this without a code change.
 */
const GENERIC_CATEGORY_ID = "88433";

/**
 * The currency every persisted price is denominated in: the pricing pipeline's
 * comps (sold/asking lookups, depreciation tables) are USD. `prediction_logs`
 * stores a bare numeric, so this constant is the read-side's currency claim —
 * publishing under a different currency must reprice, never relabel.
 */
const PRICING_CURRENCY = "USD";

export class PublishedReplayConflictError extends PublishValidationError {}

export class PublishReviewRevisionConflictError extends PublishValidationError {}

class EbayPublishOutcomeUnknownError extends Error {}

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
    if (
      err instanceof PublishedReplayConflictError
      || err instanceof EbayWriteAmbiguousError
      || err instanceof EbayPublishOutcomeUnknownError
    ) {
      throw err;
    }
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
  const marketplaceId = env.EBAY_MARKETPLACE_ID ?? "EBAY_US";

  // 1. Load the listing UNDER RLS — a foreign or unknown id is simply not found.
  const { data: listing, error: listingErr } = await supabase
    .from("listings")
    .select(
      "id, item_id, platform, title, description, copy, status, run_id, ebay_listing_id, ebay_offer_id, ebay_status, ebay_publish_connection_generation, ebay_publish_idempotency_key, ebay_publish_expected_review_revision",
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
    if (
      options.idempotencyKey
      && (
        listing.ebay_publish_idempotency_key !== options.idempotencyKey
        || listing.ebay_publish_expected_review_revision
          !== options.expectedReviewRevision
      )
    ) {
      throw new PublishReviewRevisionConflictError(
        "The listing changed since it was opened. Refresh before publishing.",
      );
    }
    const currentConnectionGeneration = await readEbayReplayConnectionGeneration(
      supabase,
      marketplaceId,
      adapter,
    );
    if (
      listing.ebay_publish_connection_generation
      !== currentConnectionGeneration
    ) {
      throw new PublishedReplayConflictError(
        "The eBay connection changed after this listing was published.",
      );
    }
    return {
      listingId,
      ebayListingId: listing.ebay_listing_id as string,
      ebayOfferId: (listing.ebay_offer_id as string | null) ?? null,
      listingUrl: null,
      ebayStatus: "published",
      alreadyPublished: true,
    };
  }

  const offerBinding = await readEbayOfferBinding(
    supabase,
    marketplaceId,
    adapter,
    options.completionClient,
  );

  // 3. Pull the current review token used by the atomic publish claim. The claim
  // returns the seller override from the same locked review snapshot and rejects
  // a concurrent review edit before any external work begins.
  const { data: item, error: itemErr } = await supabase
    .from("items")
    .select("review_revision")
    .eq("id", listing.item_id)
    .maybeSingle();
  if (itemErr || !item) {
    throw new Error(
      `Failed to load item for listing ${listingId}: ${itemErr?.message ?? "not found"}`,
    );
  }
  const expectedReviewRevision =
    options.expectedReviewRevision ?? (item.review_revision as string);
  const matchingAmbiguousReplay =
    listing.ebay_status === "publishing"
    && options.idempotencyKey != null
    && listing.ebay_publish_idempotency_key === options.idempotencyKey
    && listing.ebay_publish_expected_review_revision
      === options.expectedReviewRevision;
  if (
    options.expectedReviewRevision
    && item.review_revision !== options.expectedReviewRevision
    && !matchingAmbiguousReplay
  ) {
    throw new PublishReviewRevisionConflictError(
      "The listing changed since it was opened. Refresh before publishing.",
    );
  }

  // The persisted price is a currency-less numeric produced by the pricing
  // pipeline, whose comps are USD. Publishing it under another marketplace's
  // currency would RELABEL the amount (100 USD listed as 100 GBP), materially
  // mispricing the live listing — so a non-USD marketplace is rejected unless
  // the operator explicitly declares the pricing currency via EBAY_CURRENCY
  // (the escape hatch for a future repricing flow whose numerics genuinely
  // are in that currency).
  const currency = marketplaceCurrency(marketplaceId, env.EBAY_CURRENCY);
  if (!env.EBAY_CURRENCY && currency !== PRICING_CURRENCY) {
    throw new PublishValidationError(
      `Listing ${listingId} cannot publish to ${marketplaceId}: its price ` +
        `was computed in ${PRICING_CURRENCY}, and relabeling the amount as ${currency} ` +
        "would misprice the live listing. Reprice for the target marketplace, or set " +
        "EBAY_CURRENCY explicitly if the persisted prices really are in that currency.",
    );
  }

  const claimRpc = options.idempotencyKey
    ? "begin_mobile_ebay_publish"
    : "begin_ebay_publish";
  const { data: claimData, error: claimErr } = await supabase.rpc(claimRpc, {
    p_listing_id: listingId,
    p_expected_run_id: (listing.run_id as string | null) ?? null,
    p_expected_review_revision: expectedReviewRevision,
    ...(options.idempotencyKey
      ? { p_idempotency_key: options.idempotencyKey }
      : {}),
  });
  if (claimErr) {
    if (claimErr.code === "P0002") {
      throw new PublishReviewRevisionConflictError(
        `Listing ${listingId} changed or is already being published. Refresh and try again.`,
      );
    }
    throw new Error(`Failed to start eBay publish: ${claimErr.message}`);
  }
  const returnedClaimId = publishClaimId(claimData);
  const claim = parsePublishClaimSnapshot(claimData);
  if (!claim) {
    if (returnedClaimId) {
      await markPublishFailed(
        supabase,
        listingId,
        returnedClaimId,
        offerBinding,
      );
    }
    throw new Error("Failed to start eBay publish: publish snapshot was not returned.");
  }
  const claimId = claim.claimId;
  try {
    await bindPublishClaimToConnection(
      options.completionClient ?? supabase,
      listingId,
      claimId,
      offerBinding,
    );
  } catch (error) {
    await markPublishFailed(supabase, listingId, claimId, offerBinding);
    throw error;
  }
  const price = effectivePrice(claim.price, claim.priceOverride);
  if (price == null) {
    await markPublishFailed(supabase, listingId, claimId, offerBinding);
    throw new PublishValidationError(
      `Listing ${listingId} has no usable price. Run the pipeline (or set a price) before publishing.`,
    );
  }

  const photoPaths = claim.photos;
  let imageUrls: string[];
  try {
    imageUrls = photoPaths.length === 0
      ? []
      : await issueEbayPhotoUrls(
          supabase,
          claim.itemId,
          {
            baseUrl: options.photoBaseUrl ?? resolveEbayPhotoBaseUrl(env),
            // A second local copy of this TTL is a second thing to forget to
            // shorten. The capability's lifetime belongs to the module that
            // issues it.
            ttlSeconds: options.photoUrlTtlSeconds,
          },
        );
  } catch (error) {
    await markPublishFailed(supabase, listingId, claimId, offerBinding);
    throw error;
  }
  if (imageUrls.length === 0) {
    await markPublishFailed(supabase, listingId, claimId, offerBinding);
    throw new PublishValidationError(
      photoPaths.length === 0
        ? `Listing ${listingId} has no photos, and eBay requires at least one image. ` +
          "Add a photo to the item before publishing."
        : `Listing ${listingId} has ${photoPaths.length} photo(s) but none could be ` +
          "resolved into a fetchable URL, and eBay requires at least one image. " +
          "Re-upload the item's photos before publishing.",
    );
  }
  if (imageUrls.length !== photoPaths.length) {
    // The token RPC returns one row per photo it can bind to a verified private
    // object and silently skips the rest. Publishing the survivors would list
    // the item with photos missing and tell the seller nothing, so a partial
    // set fails the whole publish.
    await markPublishFailed(supabase, listingId, claimId, offerBinding);
    throw new PublishValidationError(
      `Listing ${listingId} has ${photoPaths.length} photo(s) but only ` +
        `${imageUrls.length} could be resolved into a fetchable URL. ` +
        "Publishing a partial photo set would misrepresent the item, so " +
        "re-upload the item's photos before publishing.",
    );
  }

  let request: EbayPublishRequest;
  try {
    request = {
      ...toEbayPublishRequest({
        listingId,
        title: claim.title ?? "",
        description: claim.description ?? "",
        copy: claim.copy,
        condition: claim.condition,
        price,
        imageUrls,
        categoryId: env.EBAY_DEFAULT_CATEGORY_ID ?? GENERIC_CATEGORY_ID,
        currency,
      }),
      ...offerBinding,
      publishClaimId: claimId,
    };
  } catch (error) {
    await markPublishFailed(supabase, listingId, claimId, offerBinding);
    throw error;
  }

  // 6. Publish through the adapter. An ADAPTER failure is persisted as
  //    ebay_status='failed' (then rethrown); persistence problems after a
  //    SUCCESSFUL publish must NOT be marked failed — the eBay listing is live.
  let providerAcknowledged = false;
  let durableCompletionSucceeded = false;
  let acknowledgedResult: EbayPublishResult | null = null;
  let result: EbayPublishResult;
  try {
    result = await adapter.publishListing(request, async (acknowledgement, context) => {
      providerAcknowledged = true;
      acknowledgedResult = acknowledgement;
      await persistPublishedListing(
        options.completionClient ?? supabase,
        listingId,
        claimId,
        request.connectionGeneration,
        price,
        acknowledgement,
        context,
      );
      durableCompletionSucceeded = true;
    });
  } catch (err) {
    if (durableCompletionSucceeded && acknowledgedResult) {
      result = acknowledgedResult;
    } else {
      if (!providerAcknowledged && !(err instanceof EbayWriteAmbiguousError)) {
        await markPublishFailed(supabase, listingId, claimId, offerBinding);
      }
      throw providerAcknowledged
        ? new EbayPublishOutcomeUnknownError(
            err instanceof Error
              ? err.message
              : "eBay may have accepted this listing, but SnapList could not save the result.",
          )
        : err;
    }
  }

  return {
    listingId,
    ebayListingId: result.listingId,
    ebayOfferId: result.offerId,
    listingUrl: result.listingUrl ?? null,
    ebayStatus: "published",
    alreadyPublished: false,
  };
}

async function bindPublishClaimToConnection(
  supabase: SupabaseClient,
  listingId: string,
  claimId: string,
  binding: EbayOfferBinding,
): Promise<void> {
  if (binding.connectionGeneration === null) {
    return;
  }
  const { error } = await supabase.rpc(
    "bind_ebay_publish_connection_generation",
    {
      p_listing_id: listingId,
      p_claim_id: claimId,
      p_marketplace_id: binding.marketplaceId,
      p_connection_generation: binding.connectionGeneration,
      p_fulfillment_policy_id: binding.fulfillmentPolicyId,
      p_payment_policy_id: binding.paymentPolicyId,
      p_return_policy_id: binding.returnPolicyId,
      p_merchant_location_key: binding.merchantLocationKey,
    },
  );
  if (error) {
    // The RPC answers this way both when the fence genuinely moved and when the
    // call itself was refused (`42501 permission denied for function
    // bind_ebay_publish_connection_generation` on an unprovisioned server-RPC
    // secret). Interpolating `error.message` would ship the schema name and
    // privilege model to the device (CWE-209), so the seller gets the one
    // sentence that is true either way and the PostgREST detail rides `cause`
    // to the server log — which the 422 branch keys on to report at all.
    throw new PublishValidationError(
      "The eBay connection changed before publishing. Try again.",
      { cause: error },
    );
  }
}

/**
 * The offer values for THIS seller's current connection (issue #47).
 *
 * Business policies and inventory locations belong to the eBay account that
 * created them, so the ids come from the seller's own account: the setup
 * service reuses their stored binding when it still governs this marketplace
 * and connection generation, and otherwise reads their account through the
 * adapter's read-only discovery capability and persists the result under RLS.
 * A process-wide env policy id is never substituted here; the exact-tenant
 * Sandbox operator fallback applies only when no connection row exists at all.
 *
 * Every unusable outcome throws BEFORE the publish claim, so a seller whose
 * policies cannot be resolved gets an honest message and zero eBay writes
 * rather than an offer built from someone else's ids.
 */
async function readEbayOfferBinding(
  supabase: SupabaseClient,
  marketplaceId: string,
  adapter: EbayAdapter,
  /**
   * Persisting a freshly discovered binding goes through the completion client
   * when the caller has one: `save_ebay_policy_location_binding` is a
   * server-guarded RPC a publishable-key client cannot reach. It is bound to the
   * same seller JWT, so RLS still decides the row. Reads stay on the caller's
   * own client.
   */
  persistClient?: SupabaseClient,
): Promise<EbayOfferBinding> {
  const reads = createSupabaseEbayPolicyLocationBindingStore(supabase);
  const writes = persistClient
    ? createSupabaseEbayPolicyLocationBindingStore(persistClient)
    : reads;
  const setup = await ensureEbayPolicyLocationBinding({
    marketplaceId,
    adapter,
    store: { ...reads, saveBinding: writes.saveBinding },
  });

  if (setup.state === "notConnected") {
    const fallback = adapter.getPublishFallbackBinding?.();
    if (
      fallback
      && fallback.marketplaceId === marketplaceId
      && fallback.connectionGeneration === null
    ) {
      return fallback;
    }
    throw new PublishValidationError(EBAY_POLICY_SETUP_NOT_CONNECTED_MESSAGE);
  }

  if (setup.state !== "ready" || !setup.binding) {
    // An expired grant is the one failure with a better-known fix than "try
    // again": it is the same reconnect the rest of the publish path reports.
    const message = isEbayAuthError(setup.cause)
      ? EBAY_RECONNECT_MESSAGE
      : setup.message
        ?? `Finish eBay policy/location setup for ${marketplaceId} before publishing.`;
    throw new PublishValidationError(message, { cause: setup.cause });
  }

  return offerBindingFromReady(setup.binding, marketplaceId);
}

/**
 * A `ready` binding is defined by the contract to have all four parts bound.
 * Re-checking each part keeps that guarantee at the type level and refuses the
 * publish if a future contract change ever loosens it.
 */
function offerBindingFromReady(
  binding: EbayPolicyLocationBinding,
  marketplaceId: string,
): EbayOfferBinding {
  const { fulfillmentPolicy, paymentPolicy, returnPolicy, inventoryLocation } =
    binding;
  if (
    fulfillmentPolicy.state !== "bound"
    || paymentPolicy.state !== "bound"
    || returnPolicy.state !== "bound"
    || inventoryLocation.state !== "bound"
  ) {
    throw new PublishValidationError(
      `Finish eBay policy/location setup for ${marketplaceId} before publishing.`,
    );
  }
  return {
    marketplaceId,
    connectionGeneration: binding.connectionGeneration,
    fulfillmentPolicyId: fulfillmentPolicy.selectedId,
    paymentPolicyId: paymentPolicy.selectedId,
    returnPolicyId: returnPolicy.selectedId,
    merchantLocationKey: inventoryLocation.selectedId,
  };
}

async function readEbayReplayConnectionGeneration(
  supabase: SupabaseClient,
  marketplaceId: string,
  adapter: EbayAdapter,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("ebay_connections")
    .select("connection_generation")
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read eBay connection generation: ${error.message}`);
  }
  if (data) {
    return data.connection_generation as string;
  }
  const fallback = adapter.getPublishFallbackBinding?.();
  if (
    fallback
    && fallback.marketplaceId === marketplaceId
    && fallback.connectionGeneration === null
  ) {
    return null;
  }
  throw new PublishedReplayConflictError(
    "Connect eBay before replaying this published listing.",
  );
}

async function persistPublishedListing(
  supabase: SupabaseClient,
  listingId: string,
  claimId: string,
  connectionGeneration: string | null,
  price: number,
  result: EbayPublishResult,
  context: EbayDispatchContext | null,
): Promise<void> {
  const pricedAt = new Date().toISOString();
  if (context) {
    if (
      context.connectionGeneration !== connectionGeneration
      || context.publishClaimId !== claimId
    ) {
      throw new Error(
        `eBay listing ${result.listingId} published but its dispatch provenance changed before persistence`,
      );
    }
    const { error } = await supabase.rpc("complete_ebay_publish_dispatch", {
      p_listing_id: listingId,
      p_claim_id: claimId,
      p_account_generation: context.accountGeneration,
      p_connection_generation: context.connectionGeneration,
      p_attempt_token: context.attemptToken,
      p_ebay_listing_id: result.listingId,
      p_ebay_offer_id: result.offerId,
      p_listed_price: price,
      p_priced_at: pricedAt,
    });
    if (error) {
      throw new Error(
        `eBay listing ${result.listingId} published but generation-bound persistence failed: ${error.message}`,
      );
    }
    return;
  }

  let update = supabase
    .from("listings")
    .update({
      ebay_listing_id: result.listingId,
      ebay_offer_id: result.offerId,
      ebay_status: "published",
      status: "published",
      listed_price: price,
      last_priced_at: pricedAt,
      ebay_publish_claim_id: null,
      ebay_publish_claimed_at: null,
    })
    .eq("id", listingId)
    .eq("ebay_status", "publishing")
    .eq("ebay_publish_claim_id", claimId);
  update =
    connectionGeneration === null
      ? update.is("ebay_publish_connection_generation", null)
      : update.eq(
          "ebay_publish_connection_generation",
          connectionGeneration,
        );
  const { data: updated, error } = await update.select("id");
  if (error || !updated || updated.length === 0) {
    throw new Error(
      `eBay listing ${result.listingId} published but persisting it failed: ${error?.message ?? "publish claim was lost"}`,
    );
  }
}

function parsePublishClaimSnapshot(value: unknown): PublishClaimSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const snapshot = value as Record<string, unknown>;
  if (
    typeof snapshot.claimId !== "string" ||
    typeof snapshot.listingId !== "string" ||
    typeof snapshot.itemId !== "string" ||
    (snapshot.title !== null && typeof snapshot.title !== "string") ||
    (snapshot.description !== null && typeof snapshot.description !== "string") ||
    !snapshot.copy ||
    typeof snapshot.copy !== "object" ||
    Array.isArray(snapshot.copy) ||
    (snapshot.condition !== null && typeof snapshot.condition !== "string") ||
    !Array.isArray(snapshot.photos) ||
    !snapshot.photos.every((photo) => typeof photo === "string") ||
    !("priceOverride" in snapshot) ||
    (snapshot.priceOverride !== null &&
      typeof snapshot.priceOverride !== "number" &&
      typeof snapshot.priceOverride !== "string")
  ) {
    return null;
  }
  return snapshot as unknown as PublishClaimSnapshot;
}

function publishClaimId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const claimId = (value as Record<string, unknown>).claimId;
  return typeof claimId === "string" ? claimId : null;
}

/**
 * Best-effort failed-publish marker; never masks the error being thrown.
 *
 * Writes the eBay failure state and clears this attempt's claim lease without
 * destroying the local listing lifecycle (`status` stays draft/queued and
 * review/draft flows keep seeing the row). The update is also
 * conditional on the row not already being published: when two publish calls
 * overlap, the loser's eBay error must not downgrade the winner's live
 * listing to 'failed' (which would disable the stored-result fast path and
 * make every retry call eBay again).
 */
async function markPublishFailed(
  supabase: SupabaseClient,
  listingId: string,
  claimId?: string,
  expectedOfferBinding?: EbayOfferBinding,
): Promise<void> {
  const expectedConnectionGeneration =
    expectedOfferBinding?.connectionGeneration ?? null;
  const expectedPublishBinding =
    expectedConnectionGeneration === null || !expectedOfferBinding
      ? null
      : {
          marketplaceId: expectedOfferBinding.marketplaceId,
          fulfillmentPolicyId: expectedOfferBinding.fulfillmentPolicyId,
          paymentPolicyId: expectedOfferBinding.paymentPolicyId,
          returnPolicyId: expectedOfferBinding.returnPolicyId,
          merchantLocationKey: expectedOfferBinding.merchantLocationKey,
        };

  const clearMatchingAttempt = async (
    connectionGeneration: string | null,
    publishBinding: typeof expectedPublishBinding,
  ): Promise<boolean> => {
    let query = supabase
      .from("listings")
      .update({
        ebay_status: "failed",
        ebay_publish_claim_id: null,
        ebay_publish_claimed_at: null,
        ebay_publish_connection_generation: null,
        ebay_publish_binding: null,
        ebay_publish_idempotency_key: null,
        ebay_publish_expected_review_revision: null,
      })
      .eq("id", listingId);
    query = claimId
      ? query.eq("ebay_status", "publishing").eq("ebay_publish_claim_id", claimId)
      : query.or("ebay_status.is.null,ebay_status.eq.failed");
    query = connectionGeneration === null
      ? query.is("ebay_publish_connection_generation", null)
      : query.eq(
          "ebay_publish_connection_generation",
          connectionGeneration,
        );
    query = publishBinding === null
      ? query.is("ebay_publish_binding", null)
      : query.filter(
          "ebay_publish_binding",
          "eq",
          JSON.stringify(publishBinding),
        );
    const { data } = await query.select("id");
    return (data?.length ?? 0) > 0;
  };

  try {
    if (
      await clearMatchingAttempt(
        expectedConnectionGeneration,
        expectedPublishBinding,
      )
    ) {
      return;
    }
    if (expectedConnectionGeneration !== null) {
      await clearMatchingAttempt(null, null);
    }
  } catch {
    // Best effort: never mask the publish error being reported.
  }
}
