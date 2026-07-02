import { describe, expect, it } from "vitest";
import {
  PLATFORM_FEE_MODELS,
  aggregateProfit,
  estimateFees,
  estimateNetProfit,
  type FeePlatform,
} from "./fees";

/**
 * Fee + net-profit math (#101) — the confidence-function pattern: a pure,
 * deterministic function unit-tested directly with crafted cases. The models
 * are ESTIMATES (documented per platform); these tests pin the arithmetic and
 * the honesty rules (no cost basis → null, never a fake zero).
 */

describe("estimateFees", () => {
  it("eBay: ~13.25% final value + $0.30 fixed", () => {
    // 100 * 0.1325 + 0.30 = 13.55
    expect(estimateFees(100, "ebay")).toBe(13.55);
  });

  it("facebook: 5% of price, no fixed part", () => {
    expect(estimateFees(100, "facebook")).toBe(5);
  });

  it("mercari: ~12.9% + $0.50 fixed", () => {
    expect(estimateFees(100, "mercari")).toBe(13.4);
  });

  it("rounds to cents", () => {
    // 19.99 * 0.1325 + 0.30 = 2.948675 → 2.95
    expect(estimateFees(19.99, "ebay")).toBe(2.95);
  });

  it("rejects a non-positive or non-finite price with null", () => {
    expect(estimateFees(0, "ebay")).toBeNull();
    expect(estimateFees(-5, "ebay")).toBeNull();
    expect(estimateFees(Number.NaN, "ebay")).toBeNull();
    expect(estimateFees(Number.POSITIVE_INFINITY, "ebay")).toBeNull();
  });

  it("every platform model has a sane shape (0 ≤ rate < 1, fixed ≥ 0)", () => {
    for (const platform of Object.keys(PLATFORM_FEE_MODELS) as FeePlatform[]) {
      const m = PLATFORM_FEE_MODELS[platform];
      expect(m.rate).toBeGreaterThanOrEqual(0);
      expect(m.rate).toBeLessThan(1);
      expect(m.fixed).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("estimateNetProfit", () => {
  it("price − fees − cost basis, rounded to cents", () => {
    // 100 − 13.55 − 40 = 46.45
    expect(estimateNetProfit(100, "ebay", 40)).toBe(46.45);
  });

  it("a free find (cost basis 0) is a REAL zero cost, not 'unknown'", () => {
    expect(estimateNetProfit(100, "ebay", 0)).toBe(86.45);
  });

  it("no cost basis → null, NEVER a fake zero", () => {
    expect(estimateNetProfit(100, "ebay", null)).toBeNull();
    expect(estimateNetProfit(100, "ebay", undefined)).toBeNull();
  });

  it("an honest LOSS goes negative rather than clamping", () => {
    // 10 − (1.325 + 0.30 → 1.63) − 20 = −11.63
    expect(estimateNetProfit(10, "ebay", 20)).toBe(-11.63);
  });

  it("invalid price or junk cost basis → null", () => {
    expect(estimateNetProfit(0, "ebay", 5)).toBeNull();
    expect(estimateNetProfit(Number.NaN, "ebay", 5)).toBeNull();
    expect(estimateNetProfit(100, "ebay", Number.NaN)).toBeNull();
    expect(estimateNetProfit(100, "ebay", -3)).toBeNull();
  });

  it("platform changes the fee slice", () => {
    expect(estimateNetProfit(100, "facebook", 40)).toBe(55);
    expect(estimateNetProfit(100, "mercari", 40)).toBe(46.6);
  });
});

describe("aggregateProfit", () => {
  it("sums invested + projected net over items WITH a cost basis only", () => {
    const agg = aggregateProfit(
      [
        { price: 100, costBasis: 40 }, // net 46.45
        { price: 100, costBasis: 0 }, // net 86.45 (free find still counts)
        { price: 50, costBasis: null }, // no cost basis → excluded entirely
        { price: null, costBasis: 10 }, // cost known but unpriced → invested only
      ],
      "ebay",
    );
    expect(agg.itemsWithCost).toBe(3);
    expect(agg.invested).toBe(50);
    expect(agg.projectedProfit).toBe(132.9); // 46.45 + 86.45
    expect(agg.itemsProjected).toBe(2);
  });

  it("empty input → zeros with zero counts (the UI hides the band)", () => {
    expect(aggregateProfit([], "ebay")).toEqual({
      invested: 0,
      projectedProfit: 0,
      itemsWithCost: 0,
      itemsProjected: 0,
    });
  });

  it("skips junk cost bases instead of poisoning the totals", () => {
    const agg = aggregateProfit(
      [
        { price: 100, costBasis: Number.NaN },
        { price: 100, costBasis: -5 },
        { price: 100, costBasis: 40 },
      ],
      "ebay",
    );
    expect(agg.itemsWithCost).toBe(1);
    expect(agg.invested).toBe(40);
    expect(agg.projectedProfit).toBe(46.45);
  });

  it("keeps cent math tidy across many rows", () => {
    const rows = Array.from({ length: 3 }, () => ({ price: 19.99, costBasis: 0.1 }));
    // per row: 19.99 − 2.95 − 0.10 = 16.94 → total 50.82
    expect(aggregateProfit(rows, "ebay").projectedProfit).toBe(50.82);
    expect(aggregateProfit(rows, "ebay").invested).toBe(0.3);
  });
});
