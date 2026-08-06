import type { EbayItemSpecific } from "./schema";

/**
 * TEST-ONLY inverse of `itemSpecificsFromPairs`: turn a name→value record back into
 * the model-facing ordered pair list. It lets a test author item specifics in the
 * readable record shape and still emit them in the shape a provider actually returns
 * against `ebayListingRawSchema` (issue #691).
 *
 * It lives here rather than in `schema.ts` because production travel is ONE-WAY: the
 * model speaks pairs, every consumer downstream reads the record, and nothing ever
 * converts back. Exported from the production module it was dead surface that implied
 * a seam which does not exist. Same reasoning, and same file convention, as
 * `pipeline-queue/checkpoint-clock.testing.ts`.
 *
 * Round-tripping is only faithful for records this codebase produces: the pair list
 * is the richer shape (it can carry duplicate and untrimmed names), so
 * `itemSpecificsFromPairs(itemSpecificsToPairs(record))` returns `record`, but the
 * reverse composition does not generally hold.
 */
export function itemSpecificsToPairs(
  specifics: Record<string, string>,
): EbayItemSpecific[] {
  return Object.entries(specifics).map(([name, value]) => ({ name, value }));
}
