import { describe, it, expect } from "vitest";
import {
  recencyWeight,
  isStaleComp,
  selectFreshComps,
  weightedMedian,
  SOLD_STALE_DAYS_DEFAULT,
  SOLD_HALFLIFE_DAYS_DEFAULT,
} from "./freshness";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 14); // fixed reference "now"
const daysAgo = (d: number) => NOW - d * DAY;

describe("recencyWeight", () => {
  it("weights a sale today at ~1", () => {
    expect(recencyWeight(NOW, NOW)).toBeCloseTo(1, 5);
  });

  it("halves the weight at exactly one half-life", () => {
    const w = recencyWeight(daysAgo(SOLD_HALFLIFE_DAYS_DEFAULT), NOW);
    expect(w).toBeCloseTo(0.5, 5);
  });

  it("decays monotonically: older sales weigh less", () => {
    const recent = recencyWeight(daysAgo(10), NOW);
    const older = recencyWeight(daysAgo(90), NOW);
    expect(recent).toBeGreaterThan(older);
    expect(older).toBeGreaterThan(0);
  });

  it("treats an unknown sale date as neutral (weight 1) — never penalized for missing metadata", () => {
    expect(recencyWeight(undefined, NOW)).toBe(1);
  });

  it("clamps clock-skew (future-dated) sales to weight 1", () => {
    expect(recencyWeight(NOW + 5 * DAY, NOW)).toBe(1);
  });
});

describe("isStaleComp", () => {
  it("a known date within the cutoff is not stale", () => {
    expect(isStaleComp(daysAgo(SOLD_STALE_DAYS_DEFAULT - 1), NOW)).toBe(false);
  });

  it("a known date beyond the cutoff is stale", () => {
    expect(isStaleComp(daysAgo(SOLD_STALE_DAYS_DEFAULT + 1), NOW)).toBe(true);
  });

  it("an unknown date is never stale (kept — can't judge what we can't date)", () => {
    expect(isStaleComp(undefined, NOW)).toBe(false);
  });
});

describe("selectFreshComps", () => {
  it("drops only the known-stale comps, keeping fresh and undated ones", () => {
    const comps = [
      { id: "fresh", soldAt: daysAgo(5) },
      { id: "stale", soldAt: daysAgo(SOLD_STALE_DAYS_DEFAULT + 30) },
      { id: "undated" },
    ];
    const fresh = selectFreshComps(comps, NOW);
    expect(fresh.map((c) => c.id)).toEqual(["fresh", "undated"]);
  });
});

describe("weightedMedian", () => {
  it("reduces to the plain median when weights are equal (odd count)", () => {
    expect(weightedMedian([1, 2, 3], [1, 1, 1])).toBe(2);
  });

  it("reduces to the plain median when weights are equal (even count → average of middles)", () => {
    expect(weightedMedian([1, 2, 3, 4], [1, 1, 1, 1])).toBe(2.5);
  });

  it("shifts toward the more heavily weighted (recent) values", () => {
    // Three sales; the high one is far heavier → median pulls up off the plain 100.
    const plain = weightedMedian([50, 100, 200], [1, 1, 1]);
    const recentHeavy = weightedMedian([50, 100, 200], [0.2, 0.3, 1]);
    expect(plain).toBe(100);
    expect(recentHeavy).toBeGreaterThan(plain);
  });

  it("handles a single value", () => {
    expect(weightedMedian([42], [0.7])).toBe(42);
  });

  it("falls back to the plain median if all weights are zero", () => {
    expect(weightedMedian([10, 20, 30], [0, 0, 0])).toBe(20);
  });
});

describe("freshness defaults", () => {
  it("exposes sane, positive defaults", () => {
    expect(SOLD_STALE_DAYS_DEFAULT).toBeGreaterThan(0);
    expect(SOLD_HALFLIFE_DAYS_DEFAULT).toBeGreaterThan(0);
    expect(SOLD_HALFLIFE_DAYS_DEFAULT).toBeLessThan(SOLD_STALE_DAYS_DEFAULT);
  });
});
