import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { isApifyEbaySoldProvider } from "./providers/apify-sold";
import { isEbayPublicSoldProvider } from "./providers/ebay-sold";
import {
  PRICE_RESULT_MAX_SOURCES,
  priceResultSchema,
  soldEvidenceProviderSchema,
  type PriceResult,
  type PricingProvider,
  type SoldEvidenceProvider,
} from "./types";

const trustedSoldEvidenceResults = new WeakMap<object, PriceResult>();
export const durablePriceEvidenceSchema = z
  .object({
    version: z.literal(1),
    soldCompCount: z.number().int().min(1).max(PRICE_RESULT_MAX_SOURCES),
    oldestSoldAt: z.number().nonnegative(),
    observedAt: z.number().nonnegative(),
    soldProvider: soldEvidenceProviderSchema,
  })
  .strict();
export type DurablePriceEvidence = z.infer<
  typeof durablePriceEvidenceSchema
>;
const persistedPriceEvidenceSchema = z
  .object({
    priced: priceResultSchema,
    priceEvidence: durablePriceEvidenceSchema,
  })
  .passthrough();

function durableSnapshot(result: PriceResult): PriceResult {
  return priceResultSchema.parse(JSON.parse(JSON.stringify(result)));
}

function rememberTrustedResult(result: PriceResult): void {
  trustedSoldEvidenceResults.set(result, durableSnapshot(result));
}

function durablePriceEvidence(
  recommendation: PriceResult,
): DurablePriceEvidence | null {
  const soldSources = recommendation.sources.filter(
    (source) => source.kind === "sold-comp",
  );
  const soldProviders = new Set(
    soldSources.map((source) => source.soldProvider),
  );
  const observedAt = soldSources[0]?.observedAt;
  const oldestSoldAt = Math.min(
    ...soldSources.map((source) => source.soldAt ?? Number.NaN),
  );
  if (
    soldSources.length === 0 ||
    new Set(soldSources.map((source) => source.url)).size !==
      soldSources.length ||
    soldProviders.size !== 1 ||
    soldProviders.has(undefined) ||
    observedAt === undefined ||
    !Number.isFinite(oldestSoldAt) ||
    soldSources.some(
      (source) =>
        source.soldAt === undefined ||
        source.observedAt !== observedAt ||
        source.soldAt > observedAt,
    )
  ) {
    return null;
  }
  return durablePriceEvidenceSchema.parse({
    version: 1,
    soldCompCount: soldSources.length,
    oldestSoldAt,
    observedAt,
    soldProvider: soldSources[0]?.soldProvider,
  });
}

/** Clone a currently trusted result while retaining process-local authority. */
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

/** Persist only the bounded Scout facts produced by an approved sold route. */
export function checkpointTrustedPriceEvidenceIfAvailable(
  recommendation: PriceResult,
): DurablePriceEvidence | null {
  const trusted = trustedSoldEvidenceResults.get(recommendation);
  if (!trusted) return null;
  return durablePriceEvidence(trusted);
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
  if (!persisted.success) {
    return null;
  }
  const expectedEvidence = durablePriceEvidence(persisted.data.priced);
  if (
    !expectedEvidence ||
    JSON.stringify(expectedEvidence) !==
      JSON.stringify(persisted.data.priceEvidence)
  ) {
    return null;
  }
  const recommendation = durableSnapshot(persisted.data.priced);
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
