import { z } from "zod";
import type {
  ItemSignal,
  PriceResult,
  PriceSource,
  PricingProvider,
} from "../types";
import {
  canonicalizeCondition,
  isPricedItemCondition,
  type PricedItemCondition,
} from "../../items/condition";
import {
  createDefaultSearchClient,
  resolvePricingModel,
  truncateSnippet,
  webSearchConfigured,
  type SearchClient,
  type SearchResult,
} from "./web-search";
import { resolveLanguageModel } from "../../llm";

/**
 * Tier 4 — the depreciation `PricingProvider` (`depreciation`), issue #11.
 *
 * PRD §"Pricing pipeline": a generic item where only a RETAIL price can be
 * found → retail × condition-based depreciation factor. Low confidence.
 *
 * This tier fires AFTER the web comp tiers declined (no resale comps found),
 * so its job is narrower than theirs: find the item's CURRENT NEW/RETAIL price
 * — a bounded retail search (at most `MAX_RETAIL_SEARCHES` queries, reusing the
 * web tiers' `SearchClient` seam) plus an injected LLM extraction of the retail
 * price from the hits — then apply a deterministic, documented depreciation
 * table. The LLM only EXTRACTS the retail anchor (so its model id is stamped
 * for provenance); the price math itself is pure arithmetic over the table.
 *
 * Anti-hallucination: every extracted retail finding must cite one of the
 * search-result URLs verbatim (post-hoc allowlist, same gate as web-search.ts);
 * a result without a checkable citation is dropped. When no cited retail price
 * survives, the tier DECLINES (returns `null`) so the router falls through to
 * the LLM-only floor — it never fabricates an anchor.
 *
 * `ItemSignal.retailPrice` (a retail price chained forward by a declining
 * upstream tier) is deliberately NOT consumed yet: it carries no citation URL,
 * and this tier's results must cite checkable evidence (the `sources` refine in
 * types.ts). Consuming it needs the producer slice to forward the discovering
 * source too; until then the tier performs its own bounded search.
 */

// ---------------------------------------------------------------------------
// The depreciation table — deterministic, documented, exported for audit
// ---------------------------------------------------------------------------

/**
 * Condition → fraction of CURRENT RETAIL a generic second-hand item resells
 * for. Rationale: generic used goods in good condition typically resell around
 * HALF of retail (the same anchor as the ISBN tier's `USED_PRICE_FRACTION`);
 * even a sealed/unworn item loses ~20% the moment it leaves a marketplace with
 * returns and warranty; a poor-condition item retains ~20%. The curve tracks
 * the ISBN tier's effective retail multipliers (`CONDITION_FACTORS` ×
 * `USED_PRICE_FRACTION`) through the middle grades, but is steeper at the
 * bottom — generic goods in fair/poor condition lack the price floor books have.
 */
export const DEPRECIATION_FACTORS = {
  new: 0.8,
  "like-new": 0.65,
  "very-good": 0.55,
  good: 0.5,
  acceptable: 0.4,
  fair: 0.35,
  poor: 0.2,
} satisfies Record<PricedItemCondition, number>;

/**
 * Unknown/unassessed condition prices at the "good" baseline: the tier's whole
 * output is already labeled a low-confidence estimate, so the midpoint of the
 * table is more honest than refusing or assuming the extremes.
 */
export const DEFAULT_DEPRECIATION_FACTOR = DEPRECIATION_FACTORS.good;

function depreciationFactor(condition?: string): number {
  if (!condition) return DEFAULT_DEPRECIATION_FACTOR;
  const key = canonicalizeCondition(condition);
  return isPricedItemCondition(key)
    ? DEPRECIATION_FACTORS[key]
    : DEFAULT_DEPRECIATION_FACTOR;
}

/**
 * Half-width of the quoted band as a fraction of the depreciated center (±30%
 * — wider than the ISBN tier's ±25%: a factor-table estimate is less precise
 * than a same-edition catalog anchor). The band's TOP is clamped to the cited
 * retail anchor — a used quote must never exceed the new price it cites (the
 * clamp binds for "new": 0.8 × 1.3 = 1.04 of retail before clamping).
 */
const BAND_SPREAD = 0.3;

/**
 * Provisional confidence — honestly LOW. The canonical composite recomputes
 * downstream from the tier signal (`depreciation` base 0.4), whose composite
 * maximum 0.6·0.4 + 0.25·1 + 0.15·1 = 0.64 sits below the 0.75 autopilot gate
 * BY CONSTRUCTION (asserted in tests): a depreciation estimate can never
 * auto-post no matter how well the item was identified.
 */
export const DEPRECIATION_CONFIDENCE = 0.35;

// ---------------------------------------------------------------------------
// Injected retail-extraction seam (the LLM call)
// ---------------------------------------------------------------------------

/** A retail (new) price the extractor pulled out of the search results. */
export const retailFindingSchema = z.object({
  /** Must be one of the search-result URLs (enforced post-hoc — anti-hallucination). */
  url: z.string().min(1),
  title: z.string().optional(),
  /** The item's CURRENT new/retail USD price at this source. */
  price: z.number().positive(),
});

export type RetailFinding = z.infer<typeof retailFindingSchema>;

const retailFindingListSchema = z.object({
  findings: z.array(retailFindingSchema),
});

/**
 * The injectable model call: given the item identity, the query, and the raw
 * search results, return the retail prices found (possibly none). Tests pass a
 * fake; the real default drives `generateObject` like the comp extractor.
 * Throwing is an upstream failure (hard error per the router contract), not a
 * decline.
 */
export type ExtractRetail = (args: {
  signal: ItemSignal;
  query: string;
  results: SearchResult[];
}) => Promise<RetailFinding[]>;

const RETAIL_EXTRACT_SYSTEM_PROMPT =
  "You extract the CURRENT NEW/RETAIL price of a SPECIFIC product from web " +
  "search results. Return only prices that clearly refer to the same product " +
  "sold NEW (not used, refurbished, or for parts). For each finding give the " +
  "USD price and the source URL (it MUST be one of the provided result URLs, " +
  "verbatim). Skip resale/used listings, accessories, bundles, and anything " +
  "you cannot tie to a concrete dollar amount. Return an empty list when " +
  "nothing fits.";

/**
 * Build the real retail extractor: a lazy wrapper around the AI SDK's
 * `generateObject` (lazy imports keep the SDK off the offline test path, same
 * as `createOpenAICompExtractor`).
 */
export function createOpenAIRetailExtractor(
  apiKey: string | undefined = undefined,
  model?: string,
): ExtractRetail {
  return async ({ signal, query, results }) => {
    const { generateObject } = await import("ai");
    const llmModel = await resolveLanguageModel("pricingAgent", {
      modelId: model,
      apiKey,
    });

    const identity = JSON.stringify(
      {
        brand: signal.brand,
        model: signal.model,
        category: signal.category,
        resolvedName: signal.resolvedName,
      },
      null,
      2,
    );
    // Re-truncate at the prompt boundary: injected SearchClients bypass the
    // default providers' caps, and the context window is THIS call's budget.
    const hits = results
      .map(
        (r, i) =>
          `Result ${i + 1}:\nurl: ${r.url}\ntitle: ${r.title ?? ""}\nsnippet: ${truncateSnippet(r.snippet) ?? ""}`,
      )
      .join("\n\n");

    const { object } = await generateObject({
      model: llmModel,
      schema: retailFindingListSchema,
      system: RETAIL_EXTRACT_SYSTEM_PROMPT,
      prompt: `Item identity:\n${identity}\n\nSearch query: ${query}\n\nSearch results:\n${hits}`,
    });
    return object.findings;
  };
}

// ---------------------------------------------------------------------------
// Query formulation — deterministic, bounded
// ---------------------------------------------------------------------------

/**
 * Hard cap on retail searches per pricing call. Tighter than the web tiers'
 * MAX_SEARCH_ITERATIONS (3): retail is a single number, not a comp cluster, so
 * the second query is a RETRY for an empty first pass, not a refinement loop.
 */
export const MAX_RETAIL_SEARCHES = 2;

/**
 * Formulate the retail query sequence. Identity preference mirrors the web
 * tiers: brand+model, else an externally resolved product name. A bare
 * brand+category ("Hamilton Beach" + "kitchen") still identifies a retail
 * PRICE CLASS well enough for a low-confidence estimate — this tier never
 * claims more than that — but category alone does not, so a fully generic
 * signal yields no queries and the provider declines to the LLM-only floor.
 */
export function buildRetailQueries(signal: ItemSignal): string[] {
  const brand = signal.brand?.trim() ?? "";
  const model = signal.model?.trim() ?? "";
  const resolved = signal.resolvedName?.trim() ?? "";
  const category = signal.category?.trim() ?? "";

  const fullyBranded = brand && model ? `${brand} ${model}` : "";
  const brandCategory = brand && category ? `${brand} ${category}` : "";
  const name = fullyBranded || resolved || brandCategory;
  if (!name) return [];

  const queries = [
    `${name} retail price new`,
    // The retry phrasing adds the category for disambiguation — unless the
    // name IS the brand+category fallback, which already contains it.
    [name, name === brandCategory ? "" : category, "buy new price"]
      .filter(Boolean)
      .join(" "),
  ];
  return [...new Set(queries)].slice(0, MAX_RETAIL_SEARCHES);
}

// ---------------------------------------------------------------------------
// Synthesis — deterministic math over the cited retail anchor
// ---------------------------------------------------------------------------

function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Build the `PriceResult` from the cited retail findings: anchor = median of
 * the cited retail prices, center = anchor × condition factor, band = ±30%
 * clamped so the top never exceeds the retail anchor. Every finding becomes a
 * cited `kind: "retail-price"` source — the user can check the anchor.
 */
function synthesize(
  signal: ItemSignal,
  findings: readonly RetailFinding[],
  model: string | undefined,
): PriceResult {
  const prices = findings.map((f) => f.price).sort((a, b) => a - b);
  const retail = median(prices);
  const center = retail * depreciationFactor(signal.condition);

  let min = center * (1 - BAND_SPREAD);
  let max = center * (1 + BAND_SPREAD);
  if (max > retail) max = retail; // A used quote never exceeds the cited new price.
  if (min > max) min = max;
  const suggested = Math.min(Math.max(center, min), max);

  const sources: PriceSource[] = findings.map((f) => ({
    url: f.url,
    title: f.title,
    // Distinct from the comp vocabulary on purpose: a retail price is NOT a
    // resale comp, and must never read as "sold-comp" downstream (the
    // confidence mapping treats sold-comp as autopilot-grade evidence).
    kind: "retail-price",
  }));

  return {
    suggested: round2(suggested),
    range: { min: round2(min), max: round2(max) },
    confidence: DEPRECIATION_CONFIDENCE,
    sources,
    tier: "depreciation",
    // Provenance: the model that EXTRACTED the retail anchor (the math is
    // deterministic, but the anchor came from an LLM read of the search hits).
    ...(model ? { model } : {}),
  };
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export interface DepreciationPricingProviderOptions {
  /** Injected search client; defaults to Tavily-primary / Exa-secondary over env keys. */
  searchClient?: SearchClient;
  /** Injected retail extraction (the model call); defaults to the real `generateObject` wrapper. */
  extractRetail?: ExtractRetail;
  /** Model id override forwarded to the default extractor (else `PRICING_MODEL` env). */
  model?: string;
}

/**
 * Create the tier-4 depreciation `PricingProvider`. Inject `searchClient` and
 * `extractRetail` in tests to run offline; production defaults to the shared
 * Tavily/Exa client and the real extractor (keyless deployments make the tier
 * decline gracefully, same as the web tiers).
 */
export function createDepreciationPricingProvider(
  options: DepreciationPricingProviderOptions = {},
): PricingProvider {
  const searchClient = options.searchClient ?? createDefaultSearchClient();
  const extractRetail =
    options.extractRetail ?? createOpenAIRetailExtractor(undefined, options.model);
  const customExtractor = options.extractRetail != null;
  // Only the DEFAULT client depends on env keys; an injected client is
  // self-sufficient and must not be gated on the environment.
  const requireEnvKeys = options.searchClient == null;

  return {
    tier: "depreciation",

    canHandle(signal: ItemSignal): boolean {
      return buildRetailQueries(signal).length > 0;
    },

    async price(signal: ItemSignal): Promise<PriceResult | null> {
      // Keyless deployment → this tier is unavailable; degrade to the floor.
      if (requireEnvKeys && !webSearchConfigured()) return null;

      const queries = buildRetailQueries(signal);
      if (queries.length === 0) return null; // Nothing identifiable to search for.

      const findings: RetailFinding[] = [];
      const seenUrls = new Set<string>();
      for (const query of queries) {
        const results = await searchClient.search(query);
        if (results.length > 0) {
          const extracted = await extractRetail({ signal, query, results });
          const allowedUrls = new Set(results.map((r) => r.url));
          for (const finding of extracted) {
            // Anti-hallucination: a finding must cite one of THIS search's
            // result URLs, carry a positive price, and not duplicate a source.
            if (!allowedUrls.has(finding.url)) continue;
            if (!(finding.price > 0)) continue;
            if (seenUrls.has(finding.url)) continue;
            seenUrls.add(finding.url);
            findings.push(finding);
          }
        }
        // One cited retail price is a usable anchor; later queries exist only
        // to retry an empty pass (bounded by MAX_RETAIL_SEARCHES either way).
        if (findings.length > 0) break;
      }

      // No cited retail anchor → decline so the router falls to the LLM floor.
      if (findings.length === 0) return null;

      // Provenance honesty (same rule as web-search): a custom extractor may
      // use a different model — or none — so only its explicitly declared
      // options.model may be claimed; the env/default resolution applies
      // solely to the default extractor.
      const provenance = customExtractor
        ? options.model?.trim() || undefined
        : resolvePricingModel(options.model);
      return synthesize(signal, findings, provenance);
    },
  };
}
