import { describe, expect, it } from "vitest";
import { GOLD_SET, JUDGE_HUMAN_LABELS, SAMPLE_PREDICTIONS } from "./fixtures";
import { REFERENCE_CORPUS } from "../rag/corpus-data";

/**
 * Fixture integrity (issue #16 acceptance: "Gold set defined (~30–50 hero
 * items) as a checked-in fixture with ground-truth ID fields and price bands",
 * overlapping the seed corpus). These tests pin the fixtures' invariants so a
 * careless edit cannot silently break the eval's ground truth.
 */

const HERO_CATEGORIES = new Set([
  "books",
  "electronics",
  "board-games",
  "branded-gear",
  "generic",
]);

describe("gold set fixture", () => {
  it("has 30-50 items with unique ids", () => {
    expect(GOLD_SET.length).toBeGreaterThanOrEqual(30);
    expect(GOLD_SET.length).toBeLessThanOrEqual(50);
    expect(new Set(GOLD_SET.map((g) => g.id)).size).toBe(GOLD_SET.length);
  });

  it("stays within the hero domains", () => {
    for (const g of GOLD_SET) {
      expect(HERO_CATEGORIES.has(g.truth.category), g.id).toBe(true);
    }
  });

  it("has valid price bands (positive, low <= high)", () => {
    for (const g of GOLD_SET) {
      expect(g.priceBand.low, g.id).toBeGreaterThan(0);
      expect(g.priceBand.low, g.id).toBeLessThanOrEqual(g.priceBand.high);
    }
  });

  it("gives every book ISBN ground truth (exercises the ISBN tier)", () => {
    for (const g of GOLD_SET.filter((g) => g.truth.category === "books")) {
      expect(g.truth.isbn, g.id).toMatch(/^\d{10}(\d{3})?$/);
    }
  });

  it("gives every non-generic item brand and model ground truth", () => {
    for (const g of GOLD_SET.filter((g) => g.truth.category !== "generic")) {
      expect(g.truth.brand, g.id).toBeTruthy();
      expect(g.truth.model, g.id).toBeTruthy();
    }
  });

  it("overlaps the seeded reference corpus completely (every seed ref is gold)", () => {
    const goldRefs = new Set(GOLD_SET.map((g) => g.sourceRef).filter(Boolean));
    for (const ref of REFERENCE_CORPUS) {
      expect(goldRefs.has(ref.sourceRef), ref.sourceRef).toBe(true);
    }
  });

  it("only references corpus refs that actually exist", () => {
    const corpusRefs = new Set(REFERENCE_CORPUS.map((r) => r.sourceRef));
    for (const g of GOLD_SET) {
      if (g.sourceRef !== undefined) {
        expect(corpusRefs.has(g.sourceRef), g.id).toBe(true);
      }
    }
  });
});

describe("sample predictions fixture", () => {
  it("covers every gold item exactly once (a full offline demo run)", () => {
    const goldIds = new Set(GOLD_SET.map((g) => g.id));
    const predictedIds = SAMPLE_PREDICTIONS.map((p) => p.goldId);
    expect(new Set(predictedIds).size).toBe(predictedIds.length);
    expect(predictedIds.length).toBe(GOLD_SET.length);
    for (const id of predictedIds) {
      expect(goldIds.has(id), id).toBe(true);
    }
  });

  it("spreads confidence across calibration buckets (high, medium, low)", () => {
    const confidences = SAMPLE_PREDICTIONS.map((p) => p.confidence);
    expect(confidences.some((c) => c >= 0.75)).toBe(true);
    expect(confidences.some((c) => c >= 0.5 && c < 0.75)).toBe(true);
    expect(confidences.some((c) => c < 0.5)).toBe(true);
  });
});

describe("judge human-labels fixture", () => {
  it("ships a small labeled subset with unique ids", () => {
    expect(JUDGE_HUMAN_LABELS.length).toBeGreaterThanOrEqual(5);
    expect(new Set(JUDGE_HUMAN_LABELS.map((l) => l.id)).size).toBe(
      JUDGE_HUMAN_LABELS.length,
    );
  });

  it("covers both strong and weak listings (scores span the rubric)", () => {
    const overall = JUDGE_HUMAN_LABELS.map((l) => l.human.overall);
    expect(Math.max(...overall)).toBe(5);
    expect(Math.min(...overall)).toBeLessThanOrEqual(3);
  });
});
