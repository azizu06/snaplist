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
