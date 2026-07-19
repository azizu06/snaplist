import { describe, it, expect } from "vitest";
import { priceResultSchema, PRICING_TIERS, type PriceResult } from "./types";

/**
 * The PriceResult contract is the data shape every PricingProvider returns and
 * the confidence function (built separately) later consumes. These tests pin
 * the contract from the PRD ("always { suggested, range, confidence, sources[] }")
 * plus the carried-along signal (tier) the confidence composite needs.
 */
describe("PriceResult contract", () => {
  const valid: PriceResult = {
    suggested: 42,
    range: { min: 30, max: 55 },
    confidence: 0.8,
    sources: [{ url: "https://openlibrary.org/isbn/123", title: "Open Library", kind: "isbn-lookup" }],
    tier: "isbn-lookup",
  };

  it("accepts a well-formed price recommendation", () => {
    expect(() => priceResultSchema.parse(valid)).not.toThrow();
  });

  it("requires a range with min <= max", () => {
    const bad = { ...valid, range: { min: 90, max: 10 } };
    expect(() => priceResultSchema.parse(bad)).toThrow();
  });

  it("keeps confidence within [0, 1]", () => {
    expect(() => priceResultSchema.parse({ ...valid, confidence: 1.5 })).toThrow();
    expect(() => priceResultSchema.parse({ ...valid, confidence: -0.1 })).toThrow();
  });

  it("allows an empty sources array (e.g. LLM-only fallback)", () => {
    const llmOnly: PriceResult = { ...valid, sources: [], tier: "llm-only" };
    expect(() => priceResultSchema.parse(llmOnly)).not.toThrow();
  });

  it("source title and kind are optional, url required", () => {
    const sourced = { ...valid, sources: [{ url: "https://example.com" }] };
    expect(() => priceResultSchema.parse(sourced)).not.toThrow();
    const noUrl = { ...valid, sources: [{ title: "no url" }] };
    expect(() => priceResultSchema.parse(noUrl)).toThrow();
  });

  it("requires source URLs to be bounded URIs for mobile contract parity", () => {
    expect(() =>
      priceResultSchema.parse({
        ...valid,
        sources: [{ url: "not a uri", kind: "sold-comp" }],
      }),
    ).toThrow();
  });

  it("rejects an unknown tier identifier", () => {
    expect(() => priceResultSchema.parse({ ...valid, tier: "not-a-tier" })).toThrow();
  });

  it("requires the suggested price to fall within [range.min, range.max]", () => {
    expect(() => priceResultSchema.parse({ ...valid, suggested: 100 })).toThrow();
  });

  it("rejects empty sources for a non-LLM tier", () => {
    expect(() =>
      priceResultSchema.parse({ ...valid, sources: [], tier: "isbn-lookup" }),
    ).toThrow();
  });

  it("exposes the tiers in PRD priority order", () => {
    expect(PRICING_TIERS).toEqual([
      "isbn-lookup",
      "ebay-sold",
      "upc-aided-web",
      "branded-web",
      "depreciation",
      "llm-only",
    ]);
  });
});
