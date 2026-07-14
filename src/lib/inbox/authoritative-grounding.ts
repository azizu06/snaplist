import { extractedAttributesSchema } from "@/lib/pipeline/types";
import { measurementWords } from "@/lib/vision/measurements";
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
}

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
  now?: Date;
}): AuthoritativeMessageGrounding {
  const now = input.now ?? new Date();
  const active =
    input.listing.status === "published" &&
    input.listing.ebay_status === "published" &&
    Boolean(nonEmpty(input.listing.ebay_listing_id));
  const pricedAt = input.listing.last_priced_at
    ? new Date(input.listing.last_priced_at)
    : null;
  const current =
    active &&
    pricedAt !== null &&
    Number.isFinite(pricedAt.getTime()) &&
    pricedAt.getTime() <= now.getTime();

  const facts: AuthoritativeFact[] = [];
  for (const [key, value] of listingSpecifics(input.listing.copy)) {
    facts.push({
      key,
      value,
      source: "active_listing_specific",
      reference: `listing:${input.listing.id}:specific:${referenceKey(key)}`,
    });
  }

  const condition = nonEmpty(input.item.condition);
  if (condition) {
    facts.push({
      key: "Condition",
      value: condition,
      source: "active_listing_specific",
      reference: `listing:${input.listing.id}:condition`,
    });
  }

  const attributes = extractedAttributesSchema.safeParse(input.item.attributes ?? {});
  if (attributes.success) {
    for (const measurement of attributes.data.measurements ?? []) {
      if (!measurement.confirmed) continue;
      const key = measurementWords(measurement.name);
      facts.push({
        key,
        value: formatInches(measurement.value_in),
        source: "seller_confirmed_measurement",
        reference: `item:${input.item.id}:confirmed-measurement:${referenceKey(key)}`,
      });
    }
  }

  if (
    typeof input.listing.listed_price === "number" &&
    Number.isFinite(input.listing.listed_price) &&
    input.listing.listed_price > 0
  ) {
    facts.push({
      key: "asking price",
      value: input.listing.listed_price.toFixed(2),
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

  const valuesByKey = new Map<string, Set<string>>();
  for (const fact of facts) {
    const key = comparable(fact.key);
    const values = valuesByKey.get(key) ?? new Set<string>();
    values.add(comparable(fact.value));
    valuesByKey.set(key, values);
  }
  const conflicts = [...valuesByKey.entries()]
    .filter(([, values]) => values.size > 1)
    .map(([key]) => key)
    .sort();

  return authoritativeMessageGroundingSchema.parse({
    listingId: input.listing.id,
    active,
    current,
    conflicts,
    facts,
  });
}
