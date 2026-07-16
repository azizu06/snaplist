/**
 * Pricing pipeline public surface. Real tier provider implementations are added
 * in later slices; this barrel exposes the seam (contracts + router) they plug into.
 */
export {
  PRICING_TIERS,
  pricingTierSchema,
  priceSourceSchema,
  priceResultSchema,
  type PricingTier,
  type ItemSignal,
  type PriceSource,
  type PriceResult,
  type PricingProvider,
} from "./types";
export { PriceRouter } from "./router";
export {
  classifySoldComp,
  normalizeComparableText,
  normalizeSoldCompCondition,
  selectSoldCompEvidence,
  type SoldCompCandidate,
  type SoldCompClassification,
  type SoldCompCondition,
  type SoldCompEvidence,
  type SoldCompMatch,
  type SoldCompMatchReason,
} from "./sold-comp-matcher";
export {
  createIsbnPricingProvider,
  USED_PRICE_FRACTION,
  type FetchJson,
  type IsbnPricingProviderOptions,
} from "./providers/isbn";
export {
  createUpcWebPricingProvider,
  createBrandedWebPricingProvider,
  createDefaultSearchClient,
  createOpenAICompExtractor,
  buildSearchQueries,
  webSearchConfigured,
  webCompSchema,
  MAX_SEARCH_ITERATIONS,
  MIN_USEFUL_COMPS,
  DEFAULT_PRICING_MODEL,
  resolvePricingModel,
  type SearchClient,
  type SearchResult,
  type WebComp,
  type ExtractComps,
  type WebSearchPricingProviderOptions,
} from "./providers/web-search";
export {
  createEbaySoldPricingProvider,
  createDefaultFetchPage,
  buildSoldSearchUrl,
  parseSoldComps,
  parsePrice,
  filterRelevantComps,
  synthesizeSoldResult,
  assertSafeEbayUrl,
  isAllowedEbayHost,
  isPrivateOrInternalHost,
  ebaySoldConfigured,
  EBAY_SOLD_MIN_COMPS,
  EBAY_SOLD_BASE_URL_DEFAULT,
  type FetchPage,
  type EbaySoldComp,
  type EbaySoldPricingProviderOptions,
} from "./providers/ebay-sold";
export {
  createDepreciationPricingProvider,
  createOpenAIRetailExtractor,
  buildRetailQueries,
  retailFindingSchema,
  DEPRECIATION_FACTORS,
  DEFAULT_DEPRECIATION_FACTOR,
  DEPRECIATION_CONFIDENCE,
  MAX_RETAIL_SEARCHES,
  type RetailFinding,
  type ExtractRetail,
  type DepreciationPricingProviderOptions,
} from "./providers/depreciation";
export {
  createLlmOnlyPricingProvider,
  createOpenAIPriceEstimator,
  llmPriceEstimateSchema,
  LLM_ONLY_CONFIDENCE,
  type LlmPriceEstimate,
  type EstimatePrice,
  type LlmOnlyPricingProviderOptions,
} from "./providers/llm-only";
