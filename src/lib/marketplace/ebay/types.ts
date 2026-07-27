/**
 * The eBay marketplace adapter seam (issue #14).
 *
 * Publishing and repricing live behind `EbayAdapter`; pre-sale messaging has a
 * separate `MarketplaceMessagingAdapter`. Listing pipeline callers see only:
 *
 *  - `HttpEbayAdapter` (http.ts) is the real Sell API implementation
 *    (inventory item -> offer -> publish against `EBAY_BASE_URL`).
 *  - `MockEbayAdapter` (mock.ts) is the offline listing implementation.
 *
 * Sandbox <-> production is a credential/`EBAY_BASE_URL` flip (PRD "Path to
 * real"); nothing above this seam changes. Per-user OAuth (issue #17) slots in
 * by swapping the `EbayTokenProvider` handed to the HTTP adapter — the adapter
 * interface itself is already per-call stateless.
 */

/** eBay's enumerated item conditions (the subset SnapList maps onto). */
export type EbayCondition =
  | "NEW"
  | "LIKE_NEW"
  | "USED_EXCELLENT"
  | "USED_VERY_GOOD"
  | "USED_GOOD"
  | "USED_ACCEPTABLE"
  | "FOR_PARTS_OR_NOT_WORKING";

/**
 * Everything the adapter needs to publish ONE listing. Deliberately a plain,
 * provider-shaped value object: the mapping from SnapList rows to this shape is
 * pure and lives in map.ts, so the adapter never reaches back into the database.
 */
export interface EbayPublishListingRequest {
  /**
   * Seller-unique inventory SKU. SnapList uses the listing row's UUID so the
   * inventory-item PUT is naturally idempotent (re-publishing the same listing
   * upserts the same SKU instead of multiplying inventory).
   */
  sku: string;
  /** eBay listing title (<= 80 chars; enforced upstream by the listing schema). */
  title: string;
  /** Listing body / description. */
  description: string;
  /**
   * eBay item aspects ("item specifics") — name -> values. The Sell Inventory
   * API wants string ARRAYS per aspect name.
   */
  aspects: Record<string, string[]>;
  condition: EbayCondition;
  /** Offer price. `value` is a decimal string per the Sell API money type. */
  price: { value: string; currency: string };
  quantity: number;
  /** Leaf category id for the offer. */
  categoryId: string;
  /** Photo URLs for the inventory item (eBay requires publicly fetchable URLs). */
  imageUrls: string[];
}

/**
 * One fully resolved seller offer request. Policy/location values belong to
 * the current connection generation; the HTTP adapter must not substitute
 * process-wide seller configuration.
 */
export interface EbayPublishBindingProvenance {
  marketplaceId: string;
  fulfillmentPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
  merchantLocationKey: string;
}

export interface EbayPublishRequest
  extends EbayPublishListingRequest, EbayPublishBindingProvenance {
  connectionGeneration: string | null;
  publishClaimId: string;
}

/** Outcome of a successful inventory item -> offer -> publish run. */
export interface EbayPublishResult {
  /** The live eBay listing id (the proof an external listing exists). */
  listingId: string;
  /** The Sell Inventory offer id (kept for retry/withdraw). */
  offerId: string;
  /** Adapter-side lifecycle; a successful publish is always "published". */
  status: "published";
}

/**
 * Everything the adapter needs to revise the PRICE of one live listing
 * (issue #102 — the stale-inventory repricing pipeline's apply path). Like
 * `EbayPublishRequest`, a plain provider-shaped value object: the caller maps
 * SnapList rows onto it, the adapter never reaches back into the database.
 */
export interface EbayReviseRequest {
  /** The seller-unique inventory SKU (SnapList: the listing row's UUID). */
  sku: string;
  /** The Sell Inventory offer id persisted at publish time (`ebay_offer_id`). */
  offerId: string;
  /** The new offer price. `value` is a decimal string per the Sell API money type. */
  price: { value: string; currency: string };
}

/** Outcome of a successful price revision. */
export interface EbayReviseResult {
  /** The offer whose price was updated. */
  offerId: string;
  status: "revised";
}

/**
 * The adapter boundary. Two capabilities: publish a listing (issue #14) and
 * revise a live listing's price (issue #102). Withdraw/etc. are added HERE
 * when their slices land, so callers keep a single seam to mock.
 */
export interface EbayAdapter {
  publishListing(
    request: EbayPublishRequest,
    complete?: EbayPublishCompletion,
  ): Promise<EbayPublishResult>;
  /** Update the price of an already-published offer (idempotent per price). */
  revisePrice(
    request: EbayReviseRequest,
    complete?: EbayReviseCompletion,
  ): Promise<EbayReviseResult>;
  /**
   * Present only on the exact-tenant, exact-origin Sandbox operator adapter.
   * Normal connected sellers resolve offer values from their RLS-owned
   * connection binding.
   */
  getPublishFallbackBinding?(): EbayPublishFallbackBinding | undefined;
}

export interface EbayPublishFallbackBinding {
  marketplaceId: string;
  connectionGeneration: null;
  fulfillmentPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
  merchantLocationKey: string;
}

export interface EbayDispatchContext {
  accountGeneration: string;
  connectionGeneration: string | null;
  publishClaimId: string | null;
  attemptToken: string;
}

export type EbayPublishCompletion = (
  result: EbayPublishResult,
  context: EbayDispatchContext | null,
) => Promise<void>;

export type EbayReviseCompletion = (
  result: EbayReviseResult,
  context: EbayDispatchContext | null,
) => Promise<void>;

/**
 * Where access tokens come from. The HTTP adapter only ever calls
 * `getAccessToken()` — it does not know whether the grant is an encrypted
 * connected-seller token or the generation-bound one-operator Sandbox
 * fallback. Production composition permits only the former.
 */
export interface EbayTokenProvider {
  getAccessToken(
    expectedAccountGeneration?: string,
    signal?: AbortSignal,
    expectedConnectionGeneration?: string | null,
  ): Promise<string>;
  beginProviderDispatch?(
    resourceId: string,
    operation: "publish" | "reprice",
    expectedConnectionGeneration?: string | null,
    expectedPublishClaimId?: string | null,
    expectedPublishBinding?: EbayPublishBindingProvenance | null,
  ): Promise<EbayProviderDispatchLease>;
}

export interface EbayProviderDispatchLease {
  accountGeneration: string;
  connectionGeneration: string | null;
  publishClaimId: string | null;
  attemptToken: string;
  signal: AbortSignal;
  release(): Promise<void>;
}

/** Typed failure for any non-2xx Sell API response, with eBay's error payload. */
export class EbayApiError extends Error {
  constructor(
    message: string,
    /** HTTP status returned by eBay. */
    public readonly status: number,
    /** Parsed eBay error payload (shape: { errors: [{ errorId, message, ... }] }). */
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "EbayApiError";
  }
}

export class EbayWriteAmbiguousError extends EbayApiError {
  readonly kind = "ambiguous";

  constructor(message: string, status: number, body: unknown) {
    super(message, status, body);
    this.name = "EbayWriteAmbiguousError";
  }
}
