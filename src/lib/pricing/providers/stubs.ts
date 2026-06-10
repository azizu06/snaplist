import type { ItemSignal, PriceResult, PricingProvider, PricingTier } from "../types";

/**
 * Test-only stub providers for exercising the router seam. These are NOT the real
 * tier implementations (those land in later slices) — they let the router tests
 * assert tier selection and fallthrough deterministically.
 *
 * Kept in the source tree (not just a test file) so any pricing test can reuse the
 * same stub without redefining the shape.
 */

/**
 * Build a stub `PricingProvider` for a given tier. The `handles` predicate decides
 * whether the provider HANDLES the signal (returns a canned `PriceResult` stamped
 * with its tier) or DECLINES (returns `null` so the router falls through).
 */
export function makeStubProvider(
  tier: PricingTier,
  handles: (signal: ItemSignal) => boolean,
): PricingProvider {
  return {
    tier,
    price: async (signal: ItemSignal): Promise<PriceResult | null> => {
      if (!handles(signal)) return null;
      return {
        suggested: 10,
        range: { min: 5, max: 15 },
        confidence: 0.5,
        sources: [{ url: `https://stub.example/${tier}`, kind: tier }],
        tier,
      };
    },
  };
}
