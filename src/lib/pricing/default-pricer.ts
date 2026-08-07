import { PriceRouter } from "./router";
import type { ItemSignal, PriceResult, PricingProvider } from "./types";
import { getTtlCache } from "./comp-cache";
import {
  createIsbnPricingProvider,
  type IsbnPricingProviderOptions,
} from "./providers/isbn";
import {
  createEbaySoldPricingProvider,
  resolveSoldCacheTtlMs,
  type EbaySoldComp,
  type EbaySoldPricingProviderOptions,
} from "./providers/ebay-sold";
import {
  apifySoldActivated,
  createApifySoldPricingProvider,
  type ApifySoldComp,
  type ApifySoldPricingProviderOptions,
} from "./providers/apify-sold";
import {
  createBrandedWebPricingProvider,
  createUpcWebPricingProvider,
  type WebSearchPricingProviderOptions,
} from "./providers/web-search";
import {
  createDepreciationPricingProvider,
  type DepreciationPricingProviderOptions,
} from "./providers/depreciation";
import {
  createLlmOnlyPricingProvider,
  type LlmOnlyPricingProviderOptions,
} from "./providers/llm-only";
import { logEvent, type LogFields } from "../observability";

/**
 * The default real pricer — the PriceRouter composition root over all six PRD
 * tiers. Moved here from `vision/pipeline.ts` so the pricing module owns its own
 * composition and consumers (the vision pipeline, `pipeline/reprice.ts`) import
 * it as peers instead of reaching into the vision module.
 */

/**
 * Per-tier dependency overrides for `createDefaultPricer`. Production passes
 * nothing (every tier defaults to its real network/model deps); tests inject
 * fakes per tier so the FULL PRD-order fallthrough runs offline.
 */
export interface CreateDefaultPricerOptions {
  /** Tier-1 ISBN lookup deps (offline tests inject `fetchJson`). */
  isbn?: IsbnPricingProviderOptions;
  /** eBay-sold scraper deps (offline tests inject `fetchPage`; #56). */
  ebaySold?: EbaySoldPricingProviderOptions;
  /** Default-off Caffein Apify sold-comps adapter deps (#200). */
  apifySold?: ApifySoldPricingProviderOptions;
  /** Web-search agent deps (shared by the UPC-aided and branded tiers). */
  webSearch?: WebSearchPricingProviderOptions;
  /** Tier-5 depreciation deps (retail search + extraction). */
  depreciation?: DepreciationPricingProviderOptions;
  /** Tier-6 LLM-only estimator deps. */
  llmOnly?: LlmOnlyPricingProviderOptions;
}

/**
 * Activate the #59 freshness layer on the eBay-sold tier for PRODUCTION: the real
 * wall clock (age-decay) + the configured TTL cache of sold-comp scrapes (Upstash
 * when configured, process-local otherwise). Both are opt-in at the raw provider so
 * unit tests stay deterministic; this composition root is the one place they're
 * turned on. A caller-supplied `now`/`cache` (tests) is preserved.
 */
function withSoldFreshness(
  opts: EbaySoldPricingProviderOptions = {},
): EbaySoldPricingProviderOptions {
  return {
    ...opts,
    now: opts.now ?? (() => Date.now()),
    cache: opts.cache ?? getTtlCache<EbaySoldComp[]>("sold", resolveSoldCacheTtlMs()),
  };
}

function withApifySoldFreshness(
  opts: ApifySoldPricingProviderOptions = {},
): ApifySoldPricingProviderOptions {
  return {
    ...opts,
    now: opts.now ?? (() => Date.now()),
    cache:
      opts.cache ??
      getTtlCache<ApifySoldComp[]>("apify-sold", resolveSoldCacheTtlMs()),
  };
}

/**
 * Emitted once per sold-comp strategy the ordered tier declined to even ATTEMPT.
 * A `canHandle` decline used to be a bare `continue`, so an unconfigured primary
 * adapter produced a run that was byte-identical to one where it ran and honestly
 * found nothing (#715). `reason: "unconfigured"` is the operator-actionable case:
 * the activation flag or the token is missing/misspelled.
 */
export const SOLD_STRATEGY_SKIPPED_EVENT = "pricing.sold_comps.strategy_skipped";

/** One named retrieval strategy inside the single `ebay-sold` tier. */
export interface OrderedSoldStrategy {
  /** Stable identifier reported by `SOLD_STRATEGY_SKIPPED_EVENT`. */
  name: string;
  provider: PricingProvider;
  /**
   * Why this strategy can never handle anything in this process — an activation
   * fact, not a per-signal one. Absent means a decline is signal-specific.
   */
  inactiveReason?: string;
  /** Same sink the strategy's own provider logs to; defaults to `logEvent`. */
  emitDiagnostic?: (event: string, fields: LogFields) => void;
}

/**
 * One sold tier with ordered, fail-soft retrieval strategies. Falling through is
 * still silent to the SELLER (the tier just declines and the router continues),
 * but it is no longer silent to the OPERATOR.
 */
export function createOrderedSoldProvider(
  strategies: readonly OrderedSoldStrategy[],
): PricingProvider {
  return {
    tier: "ebay-sold",
    canHandle(signal) {
      return strategies.some(
        ({ provider }) => provider.canHandle?.(signal) ?? true,
      );
    },
    async price(signal) {
      for (const strategy of strategies) {
        const { provider } = strategy;
        if (provider.canHandle && !provider.canHandle(signal)) {
          (strategy.emitDiagnostic ?? logEvent)(SOLD_STRATEGY_SKIPPED_EVENT, {
            strategy: strategy.name,
            reason: strategy.inactiveReason ?? "signal-not-identifiable",
          });
          continue;
        }
        const result = await provider.price(signal);
        if (result) return result;
      }
      return null;
    },
  };
}

/**
 * The default real pricer in PRD priority order: ISBN structured lookup, then the
 * default-off Caffein Apify adapter followed by the #56 eBay PUBLIC sold-comps
 * scraper (both normalized through the same matcher and declining gracefully),
 * then the #10 web-search
 * agent tiers (UPC-aided → branded; Tavily/Exa + comp extraction, env-key gated —
 * a keyless deployment makes those tiers decline gracefully), then the #11 fallback
 * tiers: depreciation (retail anchor × condition factor, low confidence) and last
 * the LLM-only floor, which never declines — so the router always returns a
 * schema-valid price. Exported so the fallthrough ORDER itself is testable
 * end-to-end with injected fakes.
 */
export function createDefaultPricer(
  options: CreateDefaultPricerOptions = {},
): (signal: ItemSignal) => Promise<PriceResult> {
  // One eBay-sold provider instance, reused two ways: as the standalone sold tier
  // AND as the ISBN tier's sold-comp lookup (#2) — so a book is priced from REAL
  // used sales (earning the top `isbn` tier) and the shared TTL cache means it's
  // fetched at most once (the router returns the ISBN result before reaching the
  // standalone tier). Searching by the exact ISBN pins the precise edition, so the
  // comps cluster tightly — exactly what the agreement signal rewards.
  const apifySold = withApifySoldFreshness(options.apifySold);
  const publicSold = withSoldFreshness(options.ebaySold);
  const soldProvider = createOrderedSoldProvider([
    {
      name: "apify-sold",
      provider: createApifySoldPricingProvider(apifySold),
      // Resolved through the adapter's OWN activation gate, so a skipped primary
      // is reported as unconfigured by the same rule that disarmed it.
      ...(apifySoldActivated(apifySold) ? {} : { inactiveReason: "unconfigured" }),
      ...(apifySold.emitDiagnostic
        ? { emitDiagnostic: apifySold.emitDiagnostic }
        : {}),
    },
    {
      name: "ebay-sold-public-page",
      provider: createEbaySoldPricingProvider(publicSold),
      ...(publicSold.emitDiagnostic
        ? { emitDiagnostic: publicSold.emitDiagnostic }
        : {}),
    },
  ]);
  const router = new PriceRouter([
    createIsbnPricingProvider({
      ...options.isbn,
      soldLookup: options.isbn?.soldLookup ?? ((signal) => soldProvider.price(signal)),
    }),
    soldProvider,
    createUpcWebPricingProvider(options.webSearch),
    createBrandedWebPricingProvider(options.webSearch),
    createDepreciationPricingProvider(options.depreciation),
    createLlmOnlyPricingProvider(options.llmOnly),
  ]);
  return async (signal) => {
    const result = await router.price(signal);
    return { ...result, evidence: result.evidence ?? [] };
  };
}
