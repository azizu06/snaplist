import { describe, expect, it } from "vitest";
import { buildPredictionLogRow } from "./prediction-log";
import type { PipelineResult } from "./types";
import type { PriceResult } from "../pricing";
import type { ConfidenceResult } from "../confidence/confidence";

/**
 * Pure unit tests for `buildPredictionLogRow` — the single source of truth for the
 * `prediction_logs` row shape. NO database: this asserts the result → row mapping
 * and its edge cases directly, so the write (logPrediction) and the eval-harness
 * read can never drift from the contract.
 */

/** A fully-populated, schema-shaped PipelineResult for the happy path. */
function makeResult(overrides: Partial<PipelineResult> = {}): PipelineResult {
  const price: PriceResult = {
    suggested: 180,
    range: { min: 150, max: 210 },
    confidence: 0.7,
    sources: [
      {
        url: "https://example.com/comp/sony-wh1000xm4-used",
        title: "Sony WH-1000XM4 (used) — comparable listing",
        kind: "asking-comp",
      },
    ],
    tier: "branded-web",
  };
  const confidence: ConfidenceResult = {
    score: 0.78,
    band: "high",
    autopilotEligible: true,
  };
  return {
    attributes: {
      brand: "Sony",
      model: "WH-1000XM4",
      category: "electronics",
      condition: "good",
      upc: "027242920866",
      specs: ["wireless", "noise-cancelling"],
      title: "Sony WH-1000XM4 Wireless Noise-Cancelling Headphones",
    },
    price,
    confidence,
    listing: {
      platform: "ebay",
      title: "Sony WH-1000XM4",
      description: "desc",
      fields: { brand: "Sony" },
    },
    model: "stub-pipeline-v1",
    ...overrides,
  };
}

describe("buildPredictionLogRow", () => {
  it("maps every PipelineResult field onto the exact insert payload", () => {
    const result = makeResult();
    const row = buildPredictionLogRow("user-1", "item-1", result);

    expect(row).toEqual({
      user_id: "user-1",
      item_id: "item-1",
      extracted_attrs: result.attributes,
      price: 180,
      price_range: { low: 150, high: 210 },
      confidence: 0.78,
      tier_fired: "branded-web",
      model: "stub-pipeline-v1",
      sources: result.price.sources,
    });
  });

  it("pins the user_id and item_id passed in (RLS ownership), not anything from result", () => {
    const row = buildPredictionLogRow("owner-uuid", "item-uuid", makeResult());
    expect(row.user_id).toBe("owner-uuid");
    expect(row.item_id).toBe("item-uuid");
  });

  it("derives price/price_range/tier from price, but confidence from the composite score", () => {
    const result = makeResult({
      price: {
        suggested: 50,
        range: { min: 40, max: 60 },
        // price.confidence is the provider's PROVISIONAL value; it must NOT be
        // logged. The logged confidence is the composite ConfidenceResult.score.
        confidence: 0.5,
        sources: [{ url: "https://example.com/x" }],
        tier: "depreciation",
      },
      confidence: { score: 0.42, band: "low", autopilotEligible: false },
    });
    const row = buildPredictionLogRow("u", "i", result);
    expect(row.price).toBe(50);
    expect(row.price_range).toEqual({ low: 40, high: 60 });
    // Composite score wins over the price's provisional confidence.
    expect(row.confidence).toBe(0.42);
    expect(row.tier_fired).toBe("depreciation");
  });

  it("carries empty sources through (llm-only fallback cites nothing)", () => {
    const result = makeResult({
      price: {
        suggested: 25,
        range: { min: 20, max: 30 },
        confidence: 0.2,
        sources: [],
        tier: "llm-only",
      },
    });
    const row = buildPredictionLogRow("u", "i", result);
    expect(row.sources).toEqual([]);
    expect(row.tier_fired).toBe("llm-only");
  });

  it("handles a sparse attribute set (generic item resolves few attrs)", () => {
    const result = makeResult({ attributes: { category: "misc" } });
    const row = buildPredictionLogRow("u", "i", result);
    // The whole extracted_attrs object is passed through verbatim — optional
    // fields simply absent, never invented.
    expect(row.extracted_attrs).toEqual({ category: "misc" });
    expect(row.extracted_attrs.brand).toBeUndefined();
  });

  it("preserves a degenerate zero-confidence / zero-price run without coercion", () => {
    const result = makeResult({
      price: {
        suggested: 0,
        range: { min: 0, max: 0 },
        confidence: 0,
        sources: [],
        tier: "llm-only",
      },
      confidence: { score: 0, band: "low", autopilotEligible: false },
    });
    const row = buildPredictionLogRow("u", "i", result);
    expect(row.price).toBe(0);
    expect(row.price_range).toEqual({ low: 0, high: 0 });
    expect(row.confidence).toBe(0);
  });
});
