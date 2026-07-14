import { extractedAttributesSchema } from "@/lib/pipeline/types";
import { measurementWords } from "@/lib/vision/measurements";
import type { MarketplaceListingSnapshot } from "@/lib/marketplace/messaging";
import {
  authoritativeMessageGroundingSchema,
  type AuthoritativeFact,
  type AuthoritativeMessageGrounding,
} from "./policy";

interface ListingGroundingRow {
  id: string;
  item_id: string;
  status: string;
  ebay_status: string | null;
  ebay_listing_id: string | null;
  copy: unknown;
  listed_price: number | null;
  last_priced_at: string | null;
  updated_at: string;
}

interface ItemGroundingRow {
  id: string;
  condition: string | null;
  attributes: unknown;
  updated_at: string;
}

const MARKETPLACE_SNAPSHOT_MAX_AGE_MS = 5 * 60_000;

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function referenceKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function comparable(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function formatInches(value: number): string {
  return `${Number(value.toFixed(2))} in`;
}

function listingSpecifics(copy: unknown): Array<[string, string]> {
  if (!copy || typeof copy !== "object" || Array.isArray(copy)) return [];
  const specifics = (copy as Record<string, unknown>).itemSpecifics;
  if (!specifics || typeof specifics !== "object" || Array.isArray(specifics)) {
    return [];
  }
  return Object.entries(specifics).flatMap(([key, value]) => {
    const cleanKey = nonEmpty(key);
    const cleanValue = nonEmpty(value);
    return cleanKey && cleanValue ? [[cleanKey, cleanValue]] : [];
  });
}

/**
 * Builds the deliberately narrow fact set allowed to authorize an automatic
 * pre-sale answer. Raw extraction output is excluded except for measurements a
 * seller explicitly confirmed; the active marketplace listing is authoritative.
 */
export function buildAuthoritativeMessageGrounding(input: {
  listing: ListingGroundingRow;
  item: ItemGroundingRow;
  marketplace: MarketplaceListingSnapshot | null;
  now?: Date;
}): AuthoritativeMessageGrounding {
  const now = input.now ?? new Date();
  const localActive =
    input.listing.status === "published" &&
    input.listing.ebay_status === "published" &&
    Boolean(nonEmpty(input.listing.ebay_listing_id));
  const marketplaceObservedAt = input.marketplace
    ? new Date(input.marketplace.observedAt)
    : null;
  const marketplaceFresh =
    marketplaceObservedAt !== null &&
    Number.isFinite(marketplaceObservedAt.getTime()) &&
    marketplaceObservedAt.getTime() <= now.getTime() &&
    marketplaceObservedAt.getTime() >=
      now.getTime() - MARKETPLACE_SNAPSHOT_MAX_AGE_MS;
  const marketplaceIdentityMatches =
    input.marketplace?.externalListingId === input.listing.ebay_listing_id;
  const active = Boolean(
    localActive &&
      input.marketplace?.active &&
      marketplaceIdentityMatches &&
      marketplaceFresh,
  );
  const pricedAt = input.listing.last_priced_at
    ? new Date(input.listing.last_priced_at)
    : null;
  const localPrice = input.listing.listed_price;
  const marketplacePrice = input.marketplace?.price;
  const priceMatches =
    typeof localPrice !== "number" ||
    !Number.isFinite(localPrice) ||
    localPrice <= 0 ||
    (typeof marketplacePrice === "number" &&
      Number.isFinite(marketplacePrice) &&
      Math.round(marketplacePrice * 100) === Math.round(localPrice * 100));
  const current =
    active &&
    priceMatches &&
    pricedAt !== null &&
    Number.isFinite(pricedAt.getTime()) &&
    pricedAt.getTime() <= now.getTime();

  const facts: AuthoritativeFact[] = [];
  const conflicts = new Set<string>();
  const marketplaceSpecifics = new Map(
    Object.entries(input.marketplace?.itemSpecifics ?? {}).map(([key, value]) => [
      comparable(key),
      comparable(value),
    ]),
  );
  for (const [key, value] of listingSpecifics(input.listing.copy)) {
    const marketplaceValue = marketplaceSpecifics.get(comparable(key));
    if (marketplaceValue !== comparable(value)) {
      conflicts.add(comparable(key));
      continue;
    }
    facts.push({
      key,
      value,
      source: "active_listing_specific",
      reference: `listing:${input.listing.id}:specific:${referenceKey(key)}`,
    });
  }

  const condition = nonEmpty(input.item.condition);
  if (condition) {
    const marketplaceCondition = nonEmpty(input.marketplace?.condition);
    if (
      marketplaceCondition &&
      comparable(marketplaceCondition) === comparable(condition)
    ) {
      facts.push({
        key: "Condition",
        value: condition,
        source: "active_listing_specific",
        reference: `listing:${input.listing.id}:condition`,
      });
    } else {
      conflicts.add("condition");
    }
  }

  const attributes = extractedAttributesSchema.safeParse(input.item.attributes ?? {});
  if (attributes.success) {
    for (const measurement of attributes.data.measurements ?? []) {
      if (!measurement.confirmed) continue;
      const key = measurementWords(measurement.name);
      if (
        marketplaceSpecifics.get(comparable(key)) !==
        comparable(formatInches(measurement.value_in))
      ) {
        continue;
      }
      facts.push({
        key,
        value: formatInches(measurement.value_in),
        source: "seller_confirmed_measurement",
        reference: `item:${input.item.id}:confirmed-measurement:${referenceKey(key)}`,
      });
    }
  }

  if (
    typeof localPrice === "number" &&
    Number.isFinite(localPrice) &&
    localPrice > 0 &&
    priceMatches
  ) {
    facts.push({
      key: "asking price",
      value: localPrice.toFixed(2),
      source: "current_asking_price",
      reference: `listing:${input.listing.id}:current-asking-price`,
    });
  }

  if (active) {
    facts.push({
      key: "listing state",
      value: "active on eBay",
      source: "active_listing_state",
      reference: `listing:${input.listing.id}:active-state`,
    });
  }
  if (!priceMatches) conflicts.add("asking price");

  const valuesByKey = new Map<string, Set<string>>();
  for (const fact of facts) {
    const key = comparable(fact.key);
    const values = valuesByKey.get(key) ?? new Set<string>();
    values.add(comparable(fact.value));
    valuesByKey.set(key, values);
  }
  for (const [key, values] of valuesByKey.entries()) {
    if (values.size > 1) conflicts.add(key);
  }
  const conflictList = [...conflicts].sort();

  return authoritativeMessageGroundingSchema.parse({
    listingId: input.listing.id,
    active,
    current,
    conflicts: conflictList,
    facts,
    authorization: {
      listingUpdatedAt: new Date(input.listing.updated_at).toISOString(),
      itemUpdatedAt: new Date(input.item.updated_at).toISOString(),
      marketplaceObservedAt:
        marketplaceObservedAt && Number.isFinite(marketplaceObservedAt.getTime())
          ? marketplaceObservedAt.toISOString()
          : new Date(0).toISOString(),
      externalListingId:
        nonEmpty(input.listing.ebay_listing_id) ?? "unverified-listing",
    },
  });
}
