import type { ItemSignal, PriceResult, PricingProvider } from "./types";
import { canonicalizeRoutedSoldEvidence } from "./approved-sold-provider";

/**
 * The pricing router (PRD: "Pricing is a routing pipeline behind a PricingProvider
 * interface"). It tries its injected providers in order and returns the first
 * non-null `PriceResult`.
 *
 * Design:
 *  - Providers are injected (constructor), so a tier can be added/replaced without
 *    touching this class — the primary pricing seam (PRD Testing Decisions).
 *  - The router is ORDER-AGNOSTIC: it walks the list as given. The caller wires
 *    providers in PRD priority order (ISBN → UPC-aided web → branded web →
 *    depreciation → LLM-only); the router itself encodes no tier priority.
 *  - A provider DECLINES by returning `null` (optionally short-circuited by
 *    `canHandle`). The router then falls through to the next provider.
 *  - A thrown error from a provider is a HARD error (upstream failure) and
 *    propagates — it is not treated as a decline.
 */
export class PriceRouter {
  private readonly providers: readonly PricingProvider[];

  constructor(providers: readonly PricingProvider[]) {
    if (providers.length === 0) {
      throw new Error("PriceRouter requires at least one PricingProvider");
    }
    this.providers = providers;
  }

  /**
   * Route a signal through the providers and return the first handled result.
   * Throws if every provider declines (no tier could price the item).
   */
  async price(signal: ItemSignal): Promise<PriceResult> {
    for (const provider of this.providers) {
      // Cheap pre-check: a `false` canHandle is an explicit decline, skip the call.
      if (provider.canHandle && !provider.canHandle(signal)) continue;

      const result = await provider.price(signal);
      if (result !== null) {
        // A provider must stamp its own tier; a mismatch would corrupt downstream
        // logging/confidence ("which tier fired"), so fail loud rather than trust it.
        if (result.tier !== provider.tier) {
          throw new Error(
            `PricingProvider for tier "${provider.tier}" returned a result tagged "${result.tier}"`,
          );
        }
        return canonicalizeRoutedSoldEvidence(provider, result);
      }
    }

    throw new Error("No PricingProvider handled the item signal");
  }
}
