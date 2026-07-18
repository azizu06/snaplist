import { isApifyEbaySoldProvider } from "./providers/apify-sold";
import { isEbayPublicSoldProvider } from "./providers/ebay-sold";
import type { PriceResult, PricingProvider, SoldEvidenceProvider } from "./types";

function approvedProvenance(
  provider: PricingProvider,
): SoldEvidenceProvider | undefined {
  if (isEbayPublicSoldProvider(provider)) return "ebay-public-sold";
  if (isApifyEbaySoldProvider(provider)) return "apify-ebay-sold";
  return undefined;
}

/**
 * Stamp durable provenance only when the result came from an approved provider
 * instance. Any caller-supplied provenance on an injected provider is removed.
 */
export function canonicalizeRoutedSoldEvidence(
  provider: PricingProvider,
  result: PriceResult,
): PriceResult {
  const provenance = approvedProvenance(provider);
  return {
    ...result,
    sources: result.sources.map((source) => {
      const facts = { ...source };
      delete facts.soldProvider;
      return source.kind === "sold-comp" && provenance
        ? { ...facts, soldProvider: provenance }
        : facts;
    }),
  };
}
