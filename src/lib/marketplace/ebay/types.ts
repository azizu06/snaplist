/**
 * The eBay marketplace adapter seam (issue #14).
 *
 * Everything that talks to eBay lives behind `EbayAdapter`. The pipeline, the
 * publish service, the API route, and the UI only ever see this interface:
 *
 *  - `HttpEbayAdapter` (http.ts) is the real Sell API implementation
 *    (inventory item -> offer -> publish against `EBAY_BASE_URL`).
 *  - `MockEbayAdapter` (mock.ts) is the offline implementation every test uses —
 *    no live eBay call ever happens in the suite.
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
export interface EbayPublishRequest {
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
 * The adapter boundary. ONE capability for this slice: publish a listing.
 * Withdraw/revise/etc. are added HERE when their slices land, so callers keep
 * a single seam to mock.
 */
export interface EbayAdapter {
  publishListing(request: EbayPublishRequest): Promise<EbayPublishResult>;
}

/**
 * Where access tokens come from. The HTTP adapter only ever calls
 * `getAccessToken()` — it does not know whether the token is the app-level
 * sandbox token (env refresh-token grant, auth.ts) or a per-user token
 * (issue #17). That swap is the entire production OAuth story.
 */
export interface EbayTokenProvider {
  getAccessToken(): Promise<string>;
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
