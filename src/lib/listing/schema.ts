import { z } from "zod";

/**
 * eBay listing constraints + the structured shape the generator produces (issue #9).
 *
 * This is the platform contract the generated copy must satisfy BEFORE it is mapped
 * onto the generic `ListingCopy` seam (`pipeline/types`). It encodes the real eBay
 * rules the PRD calls out ("per-platform output validated against platform
 * constraints — eBay title length, required fields present, no attributes
 * hallucinated beyond the validated core"):
 *
 *  - TITLE: required, non-empty, ≤ 80 characters (eBay's hard cap).
 *  - ITEM SPECIFICS: required, at least one name→value pair (eBay requires the
 *    structured specifics, not just free text).
 *  - DESCRIPTION: required, non-empty.
 *  - TAGS: keyword/search terms; may be empty but must be an array of strings.
 *
 * The generator's structured output is validated against `ebayListingSchema`; only a
 * listing that passes is mapped onto `ListingCopy`. Title over-length is repaired
 * DETERMINISTICALLY (truncate on a word boundary) before validation, so the returned
 * listing always satisfies the cap regardless of what the model emitted.
 */

/** eBay's hard maximum title length, in characters. */
export const EBAY_TITLE_MAX_LENGTH = 80;

/** Platform discriminator stamped onto the resulting `ListingCopy`. */
export const EBAY_PLATFORM = "ebay" as const;

/**
 * The structured eBay listing the generator emits. Item specifics are a name→value
 * map (eBay's "item specifics" are exactly key/value attribute pairs); tags are
 * free-form keyword strings for search relevance.
 */
export const ebayListingSchema = z.object({
  /** Keyword-dense eBay title. Required, ≤ 80 chars (the platform cap). */
  title: z
    .string()
    .min(1, "eBay title is required")
    .max(
      EBAY_TITLE_MAX_LENGTH,
      `eBay title must be ${EBAY_TITLE_MAX_LENGTH} characters or fewer`,
    ),
  /** eBay item specifics: required structured name→value attribute pairs. */
  itemSpecifics: z
    .record(z.string(), z.string())
    .refine((s) => Object.keys(s).length > 0, {
      message: "eBay requires at least one item specific",
    }),
  /** The listing body. Required, non-empty. */
  description: z.string().min(1, "eBay description is required"),
  /** Search keyword tags. May be empty, but must be string entries. */
  tags: z.array(z.string()),
});

export type EbayListing = z.infer<typeof ebayListingSchema>;

/**
 * One model-emitted eBay item specific. The MODEL-FACING representation is an ordered
 * LIST of name→value pairs rather than a dictionary: `generateObject` compiles the
 * supplied Zod schema to JSON Schema, a Zod `record` compiles to `propertyNames`, and
 * OpenAI structured outputs reject that construct outright — which took down every
 * production run on `LLM_PROVIDER=openai` (issue #691). A list of fixed-key objects is
 * expressible in every provider's structured-output dialect. `itemSpecificsFromPairs`
 * converts back to the name→value record everything downstream consumes.
 */
export const ebayItemSpecificSchema = z.object({
  /** The specific's name, e.g. "Brand". */
  name: z.string(),
  /** The specific's value, e.g. "Sony". */
  value: z.string(),
});

export type EbayItemSpecific = z.infer<typeof ebayItemSpecificSchema>;

/**
 * PERMISSIVE schema handed to `generateObject` on the real path. It relaxes exactly
 * the two DETERMINISTICALLY-REPAIRABLE constraints — the title length cap and the
 * "≥ 1 item specific" rule — so the model's output is ACCEPTED by the SDK (which
 * validates against the supplied schema and throws otherwise) and reaches the
 * repair/reconcile step. The repaired candidate is then validated against the strict
 * `ebayListingSchema`. Without this, a merely over-long title or empty specifics would
 * throw inside `generateObject` before the repair could run, so the advertised
 * deterministic repair would never apply in production.
 */
export const ebayListingRawSchema = z.object({
  title: z.string().min(1, "eBay title is required"),
  itemSpecifics: z.array(ebayItemSpecificSchema),
  description: z.string().min(1, "eBay description is required"),
  tags: z.array(z.string()),
});

export type RawEbayListing = z.infer<typeof ebayListingRawSchema>;

/** Normalized comparison key for a specific's name: case- and padding-insensitive. */
function specificNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Convert the model's ORDERED pair list into the name→value record every consumer
 * downstream expects (`ebayListingSchema`, the repair/whitelist step, eBay mapping,
 * mobile publish, the listing-review read path).
 *
 * COLLISION RULE — a list can carry two entries under one name; a record cannot:
 *  - names are compared trimmed and case-insensitively;
 *  - the FIRST occurrence wins, so a later duplicate can neither overwrite an earlier,
 *    better-grounded value nor be silently concatenated onto it;
 *  - the retained key is the first occurrence's TRIMMED name, so a padded variant
 *    cannot shadow the clean one;
 *  - an entry whose name is blank is dropped rather than creating an empty key.
 */
export function itemSpecificsFromPairs(
  pairs: readonly EbayItemSpecific[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const { name, value } of pairs) {
    const key = specificNameKey(name);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out[name.trim()] = value;
  }
  return out;
}

/** Convert a name→value record back into the model-facing ordered pair list. */
export function itemSpecificsToPairs(
  specifics: Record<string, string>,
): EbayItemSpecific[] {
  return Object.entries(specifics).map(([name, value]) => ({ name, value }));
}
