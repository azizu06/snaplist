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
