import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { isApifyEbaySoldProvider } from "./providers/apify-sold";
import { isEbayPublicSoldProvider } from "./providers/ebay-sold";
import {
  priceResultSchema,
  type PriceResult,
  type PricingProvider,
  type SoldEvidenceProvider,
} from "./types";

const trustedSoldEvidenceResults = new WeakMap<object, PriceResult>();
const persistedPriceEvidenceSchema = z
  .object({
    priced: priceResultSchema,
    priceEvidence: priceResultSchema,
  })
  .passthrough();

function durableSnapshot(result: PriceResult): PriceResult {
  return priceResultSchema.parse(JSON.parse(JSON.stringify(result)));
}

function rememberTrustedResult(result: PriceResult): void {
  trustedSoldEvidenceResults.set(result, durableSnapshot(result));
}

function sameDurableResult(left: PriceResult, right: PriceResult): boolean {
  return (
    JSON.stringify(durableSnapshot(left)) ===
    JSON.stringify(durableSnapshot(right))
  );
}

/** Create the exact duplicate written into the server-owned pipeline checkpoint. */
export function checkpointTrustedPriceEvidence(
  recommendation: PriceResult,
): PriceResult {
  const checkpoint = checkpointTrustedPriceEvidenceIfAvailable(recommendation);
  if (!checkpoint) {
    throw new Error("Price evidence checkpoint requires a trusted routed result.");
  }
  return checkpoint;
}

/** Producer seam: non-sold tiers simply have no Scout price-evidence checkpoint. */
export function checkpointTrustedPriceEvidenceIfAvailable(
  recommendation: PriceResult,
): PriceResult | null {
  const trusted = trustedSoldEvidenceResults.get(recommendation);
  if (!trusted) return null;
  const checkpoint = durableSnapshot(trusted);
  rememberTrustedResult(checkpoint);
  return checkpoint;
}

/**
 * Re-enroll evidence only after reading the lease-fenced, service-role-written
 * pipeline checkpoint through the caller's tenant/RLS Supabase client.
 * Tenant-writable prediction-log JSON is deliberately never consulted.
 */
export async function loadTrustedPriceEvidenceFromPipelineRun(
  supabase: SupabaseClient,
  runId: string,
): Promise<PriceResult | null> {
  if (typeof window !== "undefined") {
    throw new Error("Pipeline price evidence can only be loaded on the server.");
  }
  const parsedRunId = z.string().uuid().parse(runId);
  const { data, error } = await supabase
    .from("pipeline_runs")
    .select("checkpoint")
    .eq("id", parsedRunId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load pipeline price evidence: ${error.message}`);
  }
  if (!data) return null;
  const persisted = persistedPriceEvidenceSchema.safeParse(data.checkpoint);
  if (
    !persisted.success ||
    !sameDurableResult(
      persisted.data.priced,
      persisted.data.priceEvidence,
    )
  ) {
    return null;
  }
  const recommendation = durableSnapshot(persisted.data.priceEvidence);
  rememberTrustedResult(recommendation);
  return recommendation;
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
