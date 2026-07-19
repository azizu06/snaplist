/**
 * Listing generation public surface (issue #9). One Zod-validated attribute core →
 * a grounded, constraint-validated eBay listing mapped onto the `ListingCopy` seam.
 *
 * Generation is grounded by the validated item core and checked against eBay
 * constraints (title ≤ 80, required fields present, no attributes hallucinated beyond
 * that core). Optional, default-off pgvector examples may guide style and structure.
 * The model call and retrieval are both INJECTABLE so contract tests run fully offline.
 */
export {
  EBAY_TITLE_MAX_LENGTH,
  EBAY_PLATFORM,
  ebayListingSchema,
  type EbayListing,
} from "./schema";

export {
  generateEbayListing,
  enforceTitleLength,
  listingHallucinatesAttributes,
  toListingCopy,
  createOpenAIListingGenerate,
  createRealFewShotRetrieval,
  DEFAULT_LISTING_MODEL,
  DEFAULT_FEW_SHOT_COUNT,
  type GenerateEbayListingInput,
  type GenerateEbayListingResult,
  type ListingGenerate,
  type ListingExampleRetrievalOptions,
  type RetrieveFewShot,
} from "./generate";
