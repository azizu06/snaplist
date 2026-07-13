import { describe, expect, it } from "vitest";
import {
  calibration,
  fieldMatches,
  idAccuracy,
  matchPredictions,
  median,
  normalizeField,
  observedCorrect,
  pricingAccuracy,
  priceWithinBand,
  recommendAutopilotThreshold,
  type EvalPair,
} from "./metrics";
import type { EvalPrediction, GoldItem } from "./types";

/** Minimal gold item builder for crafted metric inputs. */
function gold(overrides: Partial<GoldItem> & { id: string }): GoldItem {
  return {
    truth: { category: "electronics" },
    priceBand: { low: 50, high: 100 },
    ...overrides,
  };
}

/** Minimal prediction builder. */
function prediction(
  overrides: Partial<EvalPrediction> & { goldId: string },
): EvalPrediction {
  return {
    attrs: {},
    price: 75,
    confidence: 0.8,
    ...overrides,
  };
}

function pair(g: GoldItem, p: EvalPrediction): EvalPair {
  return { gold: g, prediction: p };
}

describe("normalizeField", () => {
  it("lowercases, folds hyphens/underscores, collapses whitespace", () => {
    expect(normalizeField("  WH-1000XM4 ")).toBe("wh 1000xm4");
    expect(normalizeField("Very-Good")).toBe("very good");
    expect(normalizeField("a__b   c")).toBe("a b c");
  });
});

describe("fieldMatches", () => {
  it("returns null when truth is undefined (field not evaluated)", () => {
    expect(fieldMatches(undefined, "anything")).toBeNull();
  });

  it("returns false when truth exists but prediction is missing or blank", () => {
    expect(fieldMatches("Sony", undefined)).toBe(false);
    expect(fieldMatches("Sony", "   ")).toBe(false);
  });

  it("matches normalized equality regardless of case and punctuation", () => {
    expect(fieldMatches("WH-1000XM4", "wh 1000xm4")).toBe(true);
    expect(fieldMatches("very-good", "Very Good")).toBe(true);
  });

  it("matches containment in either direction", () => {
    // Extraction resolved a superstring of the identity — still correct.
    expect(fieldMatches("WH-1000XM4", "Sony WH-1000XM4 Headphones")).toBe(true);
    expect(fieldMatches("Sony WH-1000XM4 Headphones", "WH-1000XM4")).toBe(true);
  });

  it("rejects a genuinely different value", () => {
    expect(fieldMatches("QuietComfort 35 II", "QuietComfort 45")).toBe(false);
  });
});

describe("idAccuracy", () => {
  it("scores per field and overall, skipping undefined truth", () => {
    const pairs: EvalPair[] = [
      pair(
        gold({
          id: "g1",
          truth: { brand: "Sony", model: "WH-1000XM4", category: "electronics" },
        }),
        prediction({
          goldId: "g1",
          attrs: { brand: "Sony", model: "WH-1000XM4", category: "electronics" },
        }),
      ),
      pair(
        gold({
          id: "g2",
          truth: { brand: "Bose", model: "QC35 II", category: "electronics" },
        }),
        prediction({
          goldId: "g2",
          attrs: { brand: "Sony", category: "electronics" }, // wrong brand, missing model
        }),
      ),
      pair(
        // Generic item: no brand/model ground truth — must not pad accuracy.
        gold({ id: "g3", truth: { category: "generic" } }),
        prediction({ goldId: "g3", attrs: { category: "generic" } }),
      ),
    ];
    const report = idAccuracy(pairs);
    expect(report.perField.brand).toEqual({ evaluated: 2, correct: 1, accuracy: 0.5 });
    expect(report.perField.model).toEqual({ evaluated: 2, correct: 1, accuracy: 0.5 });
    expect(report.perField.category).toEqual({ evaluated: 3, correct: 3, accuracy: 1 });
    expect(report.perField.condition).toEqual({ evaluated: 0, correct: 0, accuracy: null });
    expect(report.perField.isbn).toEqual({ evaluated: 0, correct: 0, accuracy: null });
    // 2+2+3 evaluated cells, 1+1+3 correct.
    expect(report.overall).toEqual({ evaluated: 7, correct: 5, accuracy: 5 / 7 });
  });

  it("returns null accuracies for an empty pair set", () => {
    const report = idAccuracy([]);
    expect(report.overall.accuracy).toBeNull();
  });
});

describe("median", () => {
  it("returns null for empty input", () => {
    expect(median([])).toBeNull();
  });

  it("handles odd and even lengths without mutating the input", () => {
    const values = [3, 1, 2];
    expect(median(values)).toBe(2);
    expect(values).toEqual([3, 1, 2]);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe("pricingAccuracy", () => {
  it("counts band membership inclusively at both edges", () => {
    const g = gold({ id: "g1", priceBand: { low: 50, high: 100 } });
    expect(priceWithinBand(pair(g, prediction({ goldId: "g1", price: 50 })))).toBe(true);
    expect(priceWithinBand(pair(g, prediction({ goldId: "g1", price: 100 })))).toBe(true);
    expect(priceWithinBand(pair(g, prediction({ goldId: "g1", price: 49.99 })))).toBe(false);
    expect(priceWithinBand(pair(g, prediction({ goldId: "g1", price: 100.01 })))).toBe(false);
  });

  it("computes pct within band and median errors vs the band midpoint", () => {
    const pairs: EvalPair[] = [
      // band 50-100, midpoint 75: price 75 → error 0, within.
      pair(gold({ id: "a" }), prediction({ goldId: "a", price: 75 })),
      // price 90 → abs error 15, within.
      pair(gold({ id: "b" }), prediction({ goldId: "b", price: 90 })),
      // price 120 → abs error 45, OUT of band.
      pair(gold({ id: "c" }), prediction({ goldId: "c", price: 120 })),
    ];
    const report = pricingAccuracy(pairs);
    expect(report.evaluated).toBe(3);
    expect(report.withinBand).toBe(2);
    expect(report.pctWithinBand).toBeCloseTo(2 / 3);
    expect(report.medianAbsError).toBe(15);
    expect(report.medianRelError).toBeCloseTo(15 / 75);
  });

  it("returns nulls for an empty pair set", () => {
    const report = pricingAccuracy([]);
    expect(report.pctWithinBand).toBeNull();
    expect(report.medianAbsError).toBeNull();
    expect(report.medianRelError).toBeNull();
  });
});

describe("observedCorrect", () => {
  const identityGold = gold({
    id: "g",
    truth: { brand: "Sony", model: "WH-1000XM4", category: "electronics" },
    priceBand: { low: 100, high: 200 },
  });

  it("requires the price in band AND identity fields recovered", () => {
    expect(
      observedCorrect(
        pair(
          identityGold,
          prediction({ goldId: "g", price: 150, attrs: { brand: "Sony", model: "WH-1000XM4" } }),
        ),
      ),
    ).toBe(true);
  });

  it("fails on out-of-band price even with perfect identity", () => {
    expect(
      observedCorrect(
        pair(
          identityGold,
          prediction({ goldId: "g", price: 300, attrs: { brand: "Sony", model: "WH-1000XM4" } }),
        ),
      ),
    ).toBe(false);
  });

  it("fails on a wrong brand/model even with the price in band", () => {
    expect(
      observedCorrect(
        pair(
          identityGold,
          prediction({ goldId: "g", price: 150, attrs: { brand: "Bose", model: "WH-1000XM4" } }),
        ),
      ),
    ).toBe(false);
  });

  it("ignores brand/model when the gold item defines no identity truth", () => {
    const genericGold = gold({ id: "g", truth: { category: "generic" } });
    expect(
      observedCorrect(pair(genericGold, prediction({ goldId: "g", price: 75, attrs: {} }))),
    ).toBe(true);
  });
});

describe("calibration", () => {
  // Identity-true gold so correctness is purely price-in-band.
  const g = (id: string) => gold({ id, truth: { category: "generic" } });
  const p = (goldId: string, confidence: number, inBand: boolean) =>
    prediction({ goldId, confidence, price: inBand ? 75 : 200 });

  it("buckets by confidence and reports per-bucket reliability + ECE", () => {
    const pairs: EvalPair[] = [
      pair(g("a"), p("a", 0.9, true)),
      pair(g("b"), p("b", 0.8, false)),
      pair(g("c"), p("c", 0.6, true)),
      pair(g("d"), p("d", 0.1, false)),
    ];
    const report = calibration(pairs, [0, 0.5, 1]);
    expect(report.buckets).toHaveLength(2);

    const [low, high] = report.buckets;
    expect(low.count).toBe(1);
    expect(low.meanConfidence).toBeCloseTo(0.1);
    expect(low.observedAccuracy).toBe(0);
    expect(low.gap).toBeCloseTo(0.1);

    expect(high.count).toBe(3);
    expect(high.meanConfidence).toBeCloseTo((0.9 + 0.8 + 0.6) / 3);
    expect(high.observedAccuracy).toBeCloseTo(2 / 3);
    // ECE = (1/4)*|0.1-0| + (3/4)*|0.7667-0.6667|
    expect(report.ece).toBeCloseTo(0.25 * 0.1 + 0.75 * Math.abs((0.9 + 0.8 + 0.6) / 3 - 2 / 3));
  });

  it("includes confidence 1.0 in the final bucket", () => {
    const pairs = [pair(g("a"), p("a", 1, true))];
    const report = calibration(pairs);
    expect(report.buckets.at(-1)?.count).toBe(1);
  });

  it("reports empty buckets as null and a null ECE for no pairs", () => {
    const report = calibration([]);
    expect(report.buckets.every((b) => b.count === 0 && b.gap === null)).toBe(true);
    expect(report.ece).toBeNull();
  });

  it("rejects malformed bucket edges", () => {
    expect(() => calibration([], [0])).toThrow(/at least two/);
    expect(() => calibration([], [0, 0.5, 0.5, 1])).toThrow(/ascending/);
  });
});

describe("matchPredictions", () => {
  it("joins by goldId and reports missing + unmatched", () => {
    const goldSet = [gold({ id: "g1" }), gold({ id: "g2" })];
    const predictions = [
      prediction({ goldId: "g1" }),
      prediction({ goldId: "nope" }),
    ];
    const result = matchPredictions(goldSet, predictions);
    expect(result.pairs.map((p) => p.gold.id)).toEqual(["g1"]);
    expect(result.missingGoldIds).toEqual(["g2"]);
    expect(result.unmatchedGoldIds).toEqual(["nope"]);
  });

  it("keeps the LAST prediction when one gold item has several (most recent run)", () => {
    const goldSet = [gold({ id: "g1" })];
    const result = matchPredictions(goldSet, [
      prediction({ goldId: "g1", price: 10 }),
      prediction({ goldId: "g1", price: 20 }),
    ]);
    expect(result.pairs[0].prediction.price).toBe(20);
  });
});

describe("recommendAutopilotThreshold (#4 — evidence-driven gate)", () => {
  // Default gold has no brand/model truth, so observedCorrect == priceWithinBand
  // ([50,100]): price 75 is correct, price 150 is wrong. Confidence is set freely.
  const correctAt = (c: number, id = `c${c}`) =>
    pair(gold({ id }), prediction({ goldId: id, price: 75, confidence: c }));
  const wrongAt = (c: number, id = `w${c}`) =>
    pair(gold({ id }), prediction({ goldId: id, price: 150, confidence: c }));

  it("finds the clean boundary when confidence separates correct from wrong runs", () => {
    const rec = recommendAutopilotThreshold([
      correctAt(0.9),
      correctAt(0.85),
      wrongAt(0.3),
      wrongAt(0.2),
    ]);
    // Lowest gate with full precision: 0.85 admits both correct, no wrong.
    expect(rec.threshold).toBeCloseTo(0.85, 5);
    expect(rec.precision).toBe(1);
    expect(rec.recall).toBe(1);
    expect(rec.targetMet).toBe(true);
    expect(rec.eligibleCount).toBe(2);
  });

  it("raises the gate to hold target precision when confidences overlap (trades recall)", () => {
    // A wrong run at 0.7 sits between two correct runs (0.9, 0.6): any gate that
    // admits 0.6 also admits the wrong 0.7, so target precision forces gate 0.9.
    const rec = recommendAutopilotThreshold(
      [correctAt(0.9), correctAt(0.6), wrongAt(0.7), wrongAt(0.4)],
      { targetPrecision: 0.9 },
    );
    expect(rec.threshold).toBeCloseTo(0.9, 5);
    expect(rec.precision).toBe(1);
    expect(rec.recall).toBe(0.5);
    expect(rec.targetMet).toBe(true);
  });

  it("a looser target precision lets the gate mark more items eligible (higher recall)", () => {
    // At target 0.6 the gate 0.6 (precision 2/3 ≈ 0.667 ≥ 0.6) beats gate 0.9.
    const rec = recommendAutopilotThreshold(
      [correctAt(0.9), correctAt(0.6), wrongAt(0.7), wrongAt(0.4)],
      { targetPrecision: 0.6 },
    );
    expect(rec.threshold).toBeCloseTo(0.6, 5);
    expect(rec.recall).toBe(1);
    expect(rec.targetMet).toBe(true);
  });

  it("reports targetMet=false when even the strictest gate is too loose", () => {
    const rec = recommendAutopilotThreshold([wrongAt(0.9), wrongAt(0.8)], {
      targetPrecision: 0.9,
    });
    expect(rec.targetMet).toBe(false);
    expect(rec.precision).toBe(0); // no correct runs anywhere
    expect(rec.threshold).toBeCloseTo(0.9, 5); // most conservative fallback
  });

  it("throws on an empty pair set and on an out-of-range target", () => {
    expect(() => recommendAutopilotThreshold([])).toThrow(/at least one/);
    expect(() =>
      recommendAutopilotThreshold([correctAt(0.9)], { targetPrecision: 1.5 }),
    ).toThrow(/targetPrecision/);
  });
});
