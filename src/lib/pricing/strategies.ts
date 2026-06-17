import type { PriceResult, PricingTier } from "./types";

/**
 * Pricing STRATEGIES — turn one priced result into up to three seller-chooseable
 * price points: sell-fast / balanced / maximize. Each point is a POSITION in the
 * real comp distribution the pricing pipeline already produced, never an invented
 * number:
 *   - quick    → toward the lower end of the band (real items sold here and cleared fast)
 *   - balanced → the suggested price (the median of the comps)
 *   - maximize → toward the top of the band (real items sold this high, but fewer → longer wait)
 *
 * Pure function of an existing `PriceResult` (`suggested` + `range`), so it needs no
 * DB/pipeline change — the review surface calls it directly with the item's price.
 *
 * HONESTY GUARD: three strategies are offered ONLY when a real distribution backs
 * them — a comp-grounded tier with actual spread. A tight ISBN price or a
 * low-confidence depreciation/LLM guess returns a SINGLE "Suggested" point, never a
 * fabricated quick/maximize spread (false precision). The "time-to-sell" tradeoff is
 * the data talking: fewer real sales happened at the top, so that price waits longer.
 */

export type StrategyKey = "quick" | "balanced" | "maximize";

export interface PricingStrategy {
  key: StrategyKey;
  /** Seller-facing label. */
  label: string;
  /** The price (whole dollars, always within the real comp band). */
  price: number;
  /** Honest, data-grounded one-liner. */
  blurb: string;
}

export interface StrategyOptions {
  /**
   * How far DOWN toward the band's floor the quick price sits, as a fraction of the
   * gap between the median and the minimum. 0.5 (default) ≈ the 25th-percentile feel.
   */
  quickFraction?: number;
  /**
   * How far UP toward the band's ceiling the maximize price sits, as a fraction of
   * the gap between the median and the maximum. 0.6 (default) ≈ the ~80th-percentile feel.
   */
  maxFraction?: number;
}

/** Comp-grounded tiers — the ones that carry a real price DISTRIBUTION to split. */
const DISTRIBUTION_TIERS: ReadonlySet<PricingTier> = new Set<PricingTier>([
  "ebay-sold",
  "upc-aided-web",
  "branded-web",
]);

const DEFAULT_QUICK_FRACTION = 0.5;
const DEFAULT_MAX_FRACTION = 0.6;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function clampTo(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * The minimal price shape the strategies need. A full `PriceResult` satisfies it,
 * and so does the review page's assembled `{ suggested, range, tier }` — so the
 * caller never has to fabricate a whole PriceResult (sources, refinements) just to
 * split the band.
 */
export type StrategyInput = Pick<PriceResult, "suggested" | "range" | "tier">;

/** Does this result carry a real distribution we can honestly split three ways? */
export function hasStrategySpread(price: Pick<StrategyInput, "tier" | "range">): boolean {
  return DISTRIBUTION_TIERS.has(price.tier) && price.range.max > price.range.min;
}

/** "sold" for real completed-sale comps; "listed" for asking-price (web) comps. */
function basisFor(tier: PricingTier): "sold" | "listed" {
  return tier === "ebay-sold" ? "sold" : "listed";
}

/**
 * Derive seller pricing strategies from a priced result. Returns THREE points
 * (quick/balanced/maximize, ordered low→high, every price within the real band) when
 * a real distribution backs them, otherwise a SINGLE "Suggested" point.
 */
export function deriveStrategies(
  price: StrategyInput,
  options: StrategyOptions = {},
): PricingStrategy[] {
  // Clamp the rounded suggestion into the real comp band so rounding can't lift the
  // balanced/Suggested point OUTSIDE the range the UI promises (e.g. a $9.60 median
  // in an $8.50–$9.80 band rounding to $10) — the same clamp quick/maximize use,
  // applied in the single-point fallback too (Codex). A missing/degenerate band
  // (hi ≤ 0) skips the clamp so we never force the price to 0.
  const bandLo = Math.min(price.range.min, price.range.max);
  const bandHi = Math.max(price.range.min, price.range.max);
  const balancedPrice =
    bandHi > 0
      ? clampTo(Math.round(price.suggested), bandLo, bandHi)
      : Math.round(price.suggested);

  if (!hasStrategySpread(price)) {
    return [
      {
        key: "balanced",
        label: "Suggested",
        price: balancedPrice,
        blurb: "Our best estimate — not enough comparable sales for quick / maximize options.",
      },
    ];
  }

  const { min, max } = price.range;
  const med = price.suggested;
  const quickFraction = clamp01(options.quickFraction ?? DEFAULT_QUICK_FRACTION);
  const maxFraction = clamp01(options.maxFraction ?? DEFAULT_MAX_FRACTION);
  const basis = basisFor(price.tier);

  const quickPrice = clampTo(Math.round(med - quickFraction * (med - min)), min, max);
  const maximizePrice = clampTo(Math.round(med + maxFraction * (max - med)), min, max);

  return [
    {
      key: "quick",
      label: "Quick sell",
      price: quickPrice,
      blurb: `Priced to move — toward the lower end of real ${basis} prices.`,
    },
    {
      key: "balanced",
      label: "Balanced",
      price: balancedPrice,
      blurb: `The typical ${basis} price — a safe bet.`,
    },
    {
      key: "maximize",
      label: "Maximize",
      price: maximizePrice,
      blurb: `Top of what comparable items ${
        basis === "sold" ? "sold for" : "list for"
      } — expect a longer wait.`,
    },
  ];
}
