import {
  assertSafeEbayUrl,
  EBAY_SOLD_BASE_URL_DEFAULT,
  buildSoldSearchUrl,
  createDefaultFetchPage,
  createEbaySoldPricingProvider,
  ebaySoldConfigured,
  type FetchPage,
} from "./providers/ebay-sold";
import { resolveEbaySoldEgressConfig } from "./ebay-sold-egress";
import type { EbaySoldEnvironment } from "./ebay-sold-egress";
import { PriceRouter } from "./router";
import type {
  ItemSignal,
  PriceResult,
  PricingProvider,
  PricingTier,
} from "./types";

export type SoldCompsSmokeMode = "dry-run" | "live";
export type SoldCompsFallbackReason =
  | "dry-run-no-network"
  | "disabled"
  | "unidentifiable"
  | "egress-blocked"
  | "no-usable-sold-comps";

export interface SoldCompsSmokeReport {
  mode: SoldCompsSmokeMode;
  status: "success" | "fallback";
  targetUrl: string | null;
  egressMode: "direct" | "proxy";
  externalRequests: number;
  selectedTier: PricingTier;
  sourceUrls: string[];
  fallbackReason?: SoldCompsFallbackReason;
  /** The lower tier is a no-network sentinel proving router fallthrough only. */
  fallbackSimulated: boolean;
}

export interface RunSoldCompsSmokeOptions {
  mode?: SoldCompsSmokeMode;
  signal: ItemSignal;
  env?: EbaySoldEnvironment;
  /** Test/operator injection. Omit in live mode to use configured real egress. */
  fetchPage?: FetchPage;
}

function nextFallbackTier(signal: ItemSignal): PricingTier {
  if (signal.upc?.trim()) return "upc-aided-web";
  if (
    (signal.brand?.trim() && signal.model?.trim()) ||
    signal.resolvedName?.trim()
  ) {
    return "branded-web";
  }
  return "depreciation";
}

function smokeFallbackProvider(signal: ItemSignal): PricingProvider {
  const tier = nextFallbackTier(signal);
  return {
    tier,
    async price(): Promise<PriceResult> {
      return {
        suggested: 0,
        range: { min: 0, max: 0 },
        confidence: 0,
        sources: [
          {
            url: "https://example.invalid/snaplist-sold-comps-smoke-fallback",
            title: "Offline smoke fallback sentinel (not a price source)",
            kind: "smoke-fallback",
          },
        ],
        tier,
      };
    },
  };
}

/**
 * Exercise the real sold-comps provider and the real PriceRouter seam without
 * ever invoking paid web-search/LLM fallbacks. Dry-run is the default and makes
 * zero requests. Live mode performs at most one caller-controlled sold-page
 * request; if it declines, a deterministic sentinel proves graceful routing.
 */
export async function runSoldCompsSmoke(
  options: RunSoldCompsSmokeOptions,
): Promise<SoldCompsSmokeReport> {
  const mode = options.mode ?? "dry-run";
  const env = options.env ?? process.env;
  const egress = resolveEbaySoldEgressConfig(env);
  const baseUrl = env.EBAY_SOLD_BASE_URL?.trim() || EBAY_SOLD_BASE_URL_DEFAULT;
  const builtTargetUrl = buildSoldSearchUrl(options.signal, baseUrl);
  let targetUrl: string | null = null;
  let targetRejected = false;
  if (builtTargetUrl) {
    try {
      targetUrl = assertSafeEbayUrl(builtTargetUrl).toString();
    } catch {
      targetRejected = true;
    }
  }
  const enabled = ebaySoldConfigured(env);

  let externalRequests = 0;
  let requestBlocked = false;

  const realFetch =
    options.fetchPage ??
    createDefaultFetchPage({
      proxyTemplate: egress.mode === "proxy" ? egress.template : "",
    });

  const observedFetch: FetchPage = async (url) => {
    if (mode === "dry-run") {
      requestBlocked = true;
      throw new Error("dry-run-no-network");
    }
    externalRequests += 1;
    try {
      return await realFetch(url);
    } catch {
      // Never pass an upstream error message into provider logs: proxy request
      // URLs can carry credentials. The report exposes only a bounded reason.
      requestBlocked = true;
      throw new Error("sold-comps-egress-request-failed");
    }
  };

  const provider = createEbaySoldPricingProvider({
    baseUrl,
    fetchPage: observedFetch,
    emitDiagnostic: () => undefined,
  });
  const soldProvider: PricingProvider = {
    tier: provider.tier,
    canHandle: provider.canHandle?.bind(provider),
    price:
      enabled && !targetRejected ? provider.price.bind(provider) : async () => null,
  };
  const router = new PriceRouter([
    soldProvider,
    smokeFallbackProvider(options.signal),
  ]);
  const selected = await router.price(options.signal);
  const success = selected.tier === "ebay-sold";

  let fallbackReason: SoldCompsFallbackReason | undefined;
  if (!success) {
    if (!enabled) fallbackReason = "disabled";
    else if (targetRejected) fallbackReason = "egress-blocked";
    else if (!targetUrl) fallbackReason = "unidentifiable";
    else if (mode === "dry-run") fallbackReason = "dry-run-no-network";
    else if (requestBlocked) fallbackReason = "egress-blocked";
    else fallbackReason = "no-usable-sold-comps";
  }

  return {
    mode,
    status: success ? "success" : "fallback",
    targetUrl,
    egressMode: egress.mode,
    externalRequests,
    selectedTier: selected.tier,
    sourceUrls: success ? selected.sources.map((source) => source.url) : [],
    ...(fallbackReason ? { fallbackReason } : {}),
    fallbackSimulated: !success,
  };
}
