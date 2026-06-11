import type { EbayCondition, EbayPublishRequest } from "./types";

/**
 * Pure mapping from SnapList's persisted listing shape onto the provider-shaped
 * `EbayPublishRequest` (issue #14). Lives apart from the HTTP adapter so it is
 * unit-testable without any network and the adapter never reaches back into the
 * database.
 */

/** Inputs assembled by the publish service from the listing/item/price rows. */
export interface ListingForPublish {
  /** The listing row's UUID — becomes the inventory SKU (idempotent upsert key). */
  listingId: string;
  title: string;
  description: string;
  /** The `listings.copy` JSONB — `{ itemSpecifics?, tags? }` per the generator. */
  copy: Record<string, unknown>;
  /** Free-text assessed condition from the item row (e.g. "good", "like new"). */
  condition: string | null | undefined;
  /** Suggested price from the run's prediction log (seller-editable upstream). */
  price: number;
  /** Publicly fetchable photo URLs (signed URLs for the private bucket). */
  imageUrls?: string[];
  /** Leaf category id; from env default until category resolution lands. */
  categoryId: string;
  currency?: string;
}

/**
 * SnapList's free-text condition vocabulary -> eBay's enumerated conditions.
 * The app's condition column is deliberately free text (see init schema), so
 * this maps the common vocabulary and defaults CONSERVATIVELY to USED_GOOD —
 * never NEW — when unknown, so we never overclaim condition on a real listing.
 */
export function toEbayCondition(condition: string | null | undefined): EbayCondition {
  const c = (condition ?? "").trim().toLowerCase();
  if (c === "new" || c === "brand new" || c === "new with tags") return "NEW";
  if (c === "like new" || c === "open box" || c === "mint") return "LIKE_NEW";
  if (c === "excellent") return "USED_EXCELLENT";
  if (c === "very good") return "USED_VERY_GOOD";
  if (c === "good" || c === "used") return "USED_GOOD";
  if (c === "fair" || c === "acceptable" || c === "worn") return "USED_ACCEPTABLE";
  if (c === "for parts" || c === "broken" || c === "not working")
    return "FOR_PARTS_OR_NOT_WORKING";
  return "USED_GOOD";
}

/**
 * `listings.copy.itemSpecifics` (name -> string, per the generator's eBay schema)
 * -> Sell API aspects (name -> string[]). Non-string/empty values are dropped
 * rather than sent malformed.
 */
export function toEbayAspects(copy: Record<string, unknown>): Record<string, string[]> {
  const specifics = copy.itemSpecifics;
  const aspects: Record<string, string[]> = {};
  if (specifics && typeof specifics === "object" && !Array.isArray(specifics)) {
    for (const [name, value] of Object.entries(specifics as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim().length > 0) {
        aspects[name] = [value];
      }
    }
  }
  return aspects;
}

/**
 * Marketplace id → offer currency. eBay requires the offer to be priced in
 * the marketplace's currency, so a configured `EBAY_MARKETPLACE_ID` must not
 * silently price in USD. `EBAY_CURRENCY` overrides for marketplaces not in
 * the map (which falls back to USD).
 */
const MARKETPLACE_CURRENCY: Record<string, string> = {
  EBAY_US: "USD",
  EBAY_MOTORS_US: "USD",
  EBAY_CA: "CAD",
  EBAY_GB: "GBP",
  EBAY_AU: "AUD",
  EBAY_DE: "EUR",
  EBAY_FR: "EUR",
  EBAY_IT: "EUR",
  EBAY_ES: "EUR",
  EBAY_IE: "EUR",
  EBAY_AT: "EUR",
  EBAY_BE: "EUR",
  EBAY_NL: "EUR",
  EBAY_CH: "CHF",
  EBAY_PL: "PLN",
};

export function marketplaceCurrency(
  marketplaceId: string | undefined,
  override?: string,
): string {
  const o = override?.trim();
  if (o) return o.toUpperCase();
  return MARKETPLACE_CURRENCY[marketplaceId?.trim() ?? ""] ?? "USD";
}

/** Format a price for the Sell API money type (decimal string, 2 places). */
export function toEbayPrice(price: number, currency = "USD"): { value: string; currency: string } {
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Cannot publish to eBay with a non-positive price (got ${price}).`);
  }
  return { value: price.toFixed(2), currency };
}

/** Assemble the full publish request. Throws on unpublishable input (no price). */
export function toEbayPublishRequest(listing: ListingForPublish): EbayPublishRequest {
  if (!listing.title.trim() || !listing.description.trim()) {
    throw new Error("Cannot publish to eBay: listing is missing a title or description.");
  }
  return {
    sku: listing.listingId,
    title: listing.title,
    description: listing.description,
    aspects: toEbayAspects(listing.copy),
    condition: toEbayCondition(listing.condition),
    price: toEbayPrice(listing.price, listing.currency),
    quantity: 1, // SnapList sells single physical items (one item -> one listing).
    categoryId: listing.categoryId,
    imageUrls: listing.imageUrls ?? [],
  };
}
