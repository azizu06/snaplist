import { describe, expect, it } from "vitest";
import { deriveStrategies, hasStrategySpread } from "./strategies";
import { priceResultSchema, type PriceResult, type PricingTier } from "./types";

/**
 * Pricing strategies — pure derivation over an existing PriceResult. Tested directly
 * with crafted results: ordering, band-containment, the aggressiveness knob, and the
 * honesty guard (no fabricated spread for tight / low-confidence tiers).
 */

const result = (over: Partial<PriceResult> & { tier: PricingTier }): PriceResult =>
  priceResultSchema.parse({
    suggested: 100,
    range: { min: 60, max: 160 },
    confidence: 0.8,
    sources: over.tier === "llm-only" ? [] : [{ url: "https://ebay.com/itm/1" }],
    ...over,
  });

describe("deriveStrategies — comp-backed distribution", () => {
  const sold = result({ tier: "ebay-sold", suggested: 100, range: { min: 60, max: 160 } });

  it("returns three points ordered quick < balanced < maximize", () => {
    const s = deriveStrategies(sold);
    expect(s.map((x) => x.key)).toEqual(["quick", "balanced", "maximize"]);
    expect(s[0].price).toBeLessThan(s[1].price);
    expect(s[1].price).toBeLessThan(s[2].price);
  });

  it("balanced equals the suggested price; every price stays within the real band", () => {
    const s = deriveStrategies(sold);
    expect(s.find((x) => x.key === "balanced")!.price).toBe(100);
    for (const x of s) {
      expect(x.price).toBeGreaterThanOrEqual(60);
      expect(x.price).toBeLessThanOrEqual(160);
    }
  });

  it("defaults sit at ~25th/median/~80th of the band", () => {
    const s = deriveStrategies(sold);
    // quick = 100 - 0.5*(100-60) = 80 ; maximize = 100 + 0.6*(160-100) = 136
    expect(s[0].price).toBe(80);
    expect(s[2].price).toBe(136);
  });

  it("respects the aggressiveness knob (wider fractions spread the points out)", () => {
    const s = deriveStrategies(sold, { quickFraction: 1, maxFraction: 1 });
    expect(s[0].price).toBe(60); // all the way to the floor
    expect(s[2].price).toBe(160); // all the way to the ceiling
  });

  it("labels sold tiers as 'sold' and web tiers as 'listed'", () => {
    expect(deriveStrategies(sold)[0].blurb).toMatch(/sold/);
    const web = result({ tier: "branded-web" });
    expect(deriveStrategies(web)[2].blurb).toMatch(/list for/);
  });
});

describe("deriveStrategies — honesty guard", () => {
  it("returns a single 'Suggested' point for a low-confidence / non-comp tier", () => {
    const llm = deriveStrategies(result({ tier: "llm-only", confidence: 0.2 }));
    expect(llm).toHaveLength(1);
    expect(llm[0].label).toBe("Suggested");
    const dep = deriveStrategies(result({ tier: "depreciation" }));
    expect(dep).toHaveLength(1);
  });

  it("returns a single point when there is no real spread (min == max)", () => {
    const flat = result({ tier: "ebay-sold", suggested: 100, range: { min: 100, max: 100 } });
    expect(hasStrategySpread(flat)).toBe(false);
    expect(deriveStrategies(flat)).toHaveLength(1);
  });

  it("treats a tight ISBN lookup as a single suggested price", () => {
    const isbn = result({ tier: "isbn-lookup", suggested: 18, range: { min: 15, max: 22 } });
    expect(deriveStrategies(isbn)).toHaveLength(1);
  });
});
