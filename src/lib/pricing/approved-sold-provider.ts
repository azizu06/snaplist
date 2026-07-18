import { isApifyEbaySoldProvider } from "./providers/apify-sold";
import { isEbayPublicSoldProvider } from "./providers/ebay-sold";
import {
  priceResultSchema,
  type PriceResult,
  type PricingProvider,
  type SoldEvidenceProvider,
} from "./types";

const trustedSoldEvidenceResults = new WeakMap<object, PriceResult>();

function durableSnapshot(result: PriceResult): PriceResult {
  return priceResultSchema.parse(JSON.parse(JSON.stringify(result)));
}

function rememberTrustedResult(result: PriceResult): void {
  trustedSoldEvidenceResults.set(result, durableSnapshot(result));
}

/** Cross the persisted JSON shape while retaining private server-side authority. */
export function checkpointTrustedPriceEvidence(
  recommendation: PriceResult,
): PriceResult {
  const trusted = trustedSoldEvidenceResults.get(recommendation);
  if (!trusted) {
    throw new Error("Price evidence checkpoint requires a trusted routed result.");
  }
  const checkpoint = durableSnapshot(trusted);
  rememberTrustedResult(checkpoint);
  return checkpoint;
}

/** Immutable trusted projection used by Scout fact derivation. */
export function trustedPriceEvidenceSnapshot(
  recommendation: unknown,
): PriceResult | null {
  if (typeof recommendation !== "object" || recommendation === null) return null;
  const trusted = trustedSoldEvidenceResults.get(recommendation);
  return trusted ? durableSnapshot(trusted) : null;
}

/** Carry private authority across a deterministic result transformation. */
export function inheritTrustedSoldEvidence(
  transformed: PriceResult,
  source: PriceResult,
): PriceResult {
  if (trustedSoldEvidenceResults.has(source)) {
    rememberTrustedResult(transformed);
  }
  return transformed;
}

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
  if (trustedSoldEvidenceResults.has(result)) return result;
  const provenance = approvedProvenance(provider);
  const canonical = {
    ...result,
    sources: result.sources.map((source) => {
      const facts = { ...source };
      delete facts.soldProvider;
      return source.kind === "sold-comp" && provenance
        ? { ...facts, soldProvider: provenance }
        : facts;
    }),
  };
  if (provenance) rememberTrustedResult(canonical);
  return canonical;
}
