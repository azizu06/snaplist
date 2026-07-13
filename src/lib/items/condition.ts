/** Conditions with explicit ISBN/depreciation pricing factors. */
export const PRICED_ITEM_CONDITIONS = [
  "new",
  "like-new",
  "very-good",
  "good",
  "acceptable",
  "fair",
  "poor",
] as const;

/** Full seller-facing condition taxonomy; values outside the priced subset use provider fallbacks. */
export const ITEM_CONDITIONS = [
  ...PRICED_ITEM_CONDITIONS,
  "for-parts",
] as const;

export type PricedItemCondition = (typeof PRICED_ITEM_CONDITIONS)[number];
export type ItemCondition = (typeof ITEM_CONDITIONS)[number];

/** Normalize separators and casing before alias mapping or provider-specific translation. */
export function normalizeConditionAlias(value: string): string {
  return value.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
}

/** Whether a normalized value belongs to the full seller-facing taxonomy. */
export function isItemCondition(value: string): value is ItemCondition {
  return (ITEM_CONDITIONS as readonly string[]).includes(value);
}

/** Whether a normalized value has an explicit pricing-factor entry. */
export function isPricedItemCondition(value: string): value is PricedItemCondition {
  return (PRICED_ITEM_CONDITIONS as readonly string[]).includes(value);
}

/** Convert accepted human aliases to the canonical persisted condition vocabulary. */
export function canonicalizeCondition(value: string): string {
  const normalized = normalizeConditionAlias(value);
  switch (normalized) {
    case "like new":
      return "like-new";
    case "very good":
      return "very-good";
    case "for parts":
      return "for-parts";
    default:
      return normalized;
  }
}
