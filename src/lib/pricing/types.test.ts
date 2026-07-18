import { describe, it, expect } from "vitest";
import {
  PRICE_RESULT_MAX_SOURCES,
  PRICE_SOURCE_KIND_MAX_LENGTH,
  PRICE_SOURCE_TITLE_MAX_LENGTH,
  PRICE_SOURCE_URL_MAX_LENGTH,
  priceResultSchema,
  PRICING_TIERS,
  type PriceResult,
} from "./types";

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

  it("requires every citation URL to be absolute HTTP(S)", () => {
    for (const url of [
      "https://example.com/item/1",
      "http://example.com/item/1",
    ]) {
      expect(
        priceResultSchema.safeParse({
          ...valid,
          sources: [{ url }],
        }).success,
      ).toBe(true);
    }

    for (const url of [
      "/item/1",
      "//example.com/item/1",
      "not a URL",
      "javascript:alert(1)",
      "data:text/plain,hidden",
      "ftp://example.com/item/1",
    ]) {
      expect(
        priceResultSchema.safeParse({
          ...valid,
          sources: [{ url }],
        }).success,
      ).toBe(false);
    }
  });

  it("bounds citation strings and source count at the pricing contract", () => {
    const source = {
      url: `https://example.com/${"u".repeat(
        PRICE_SOURCE_URL_MAX_LENGTH - "https://example.com/".length,
      )}`,
      title: "t".repeat(PRICE_SOURCE_TITLE_MAX_LENGTH),
      kind: "k".repeat(PRICE_SOURCE_KIND_MAX_LENGTH),
    };
    expect(
      priceResultSchema.safeParse({
        ...valid,
        sources: Array.from(
          { length: PRICE_RESULT_MAX_SOURCES },
          (_unused, index) => ({ ...source, url: `${source.url.slice(0, -2)}${index}` }),
        ),
      }).success,
    ).toBe(true);
    for (const oversizedSource of [
      { ...source, url: `${source.url}x` },
      { ...source, title: `${source.title}x` },
      { ...source, kind: `${source.kind}x` },
    ]) {
      expect(
        priceResultSchema.safeParse({ ...valid, sources: [oversizedSource] })
          .success,
      ).toBe(false);
    }
    expect(
      priceResultSchema.safeParse({
        ...valid,
        sources: Array.from(
          { length: PRICE_RESULT_MAX_SOURCES + 1 },
          () => source,
        ),
      }).success,
    ).toBe(false);
  });

  it("rejects malformed surrogate strings that PostgreSQL JSONB cannot encode", () => {
    const loneHighSurrogate = "\ud83d";
    expect(JSON.stringify({ value: loneHighSurrogate })).toContain("\\ud83d");

    for (const malformedSource of [
      { url: `https://example.com/${loneHighSurrogate}` },
      { url: "https://example.com", title: loneHighSurrogate },
      { url: "https://example.com", kind: loneHighSurrogate },
    ]) {
      expect(
        priceResultSchema.safeParse({
          ...valid,
          sources: [malformedSource],
        }).success,
      ).toBe(false);
    }
  });

  it("rejects U+0000 source text that PostgreSQL JSONB cannot encode", () => {
    const nul = "\u0000";
    expect(JSON.stringify({ value: nul })).toContain("\\u0000");

    for (const malformedSource of [
      { url: "https://example.com", title: `hidden${nul}title` },
      { url: "https://example.com", kind: `sold${nul}comp` },
    ]) {
      expect(
        priceResultSchema.safeParse({
          ...valid,
          sources: [malformedSource],
        }).success,
      ).toBe(false);
    }
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
