import { describe, expect, it } from "vitest";
import { EBAY_TITLE_MAX, parseReviewEdits } from "./review-edits";

const base = {
  hasListing: true,
  title: "Sony WH-1000XM4 Wireless Headphones",
  description: "Tested and working.",
  category: "Consumer electronics",
  condition: "Good",
  price: "178",
  costBasis: "",
};

describe("parseReviewEdits", () => {
  it("normalizes a full valid form", () => {
    expect(parseReviewEdits(base)).toEqual({
      listing: {
        title: "Sony WH-1000XM4 Wireless Headphones",
        description: "Tested and working.",
      },
      category: "Consumer electronics",
      condition: "Good",
      override: 178,
      costBasis: null,
    });
  });

  it("trims whitespace on every field", () => {
    const edits = parseReviewEdits({
      ...base,
      title: "  Camera  ",
      description: "  Nice.  ",
      category: "  Film cameras ",
      condition: "  Used ",
    });
    expect(edits.listing).toEqual({ title: "Camera", description: "Nice." });
    expect(edits.category).toBe("Film cameras");
    expect(edits.condition).toBe("Used");
  });

  it("skips listing fields when the item has no listing", () => {
    const edits = parseReviewEdits({
      ...base,
      hasListing: false,
      title: "",
      description: "",
    });
    expect(edits.listing).toBeNull();
  });

  it("maps blank category/condition/price to null (clear)", () => {
    const edits = parseReviewEdits({
      ...base,
      category: "  ",
      condition: "",
      price: "",
    });
    expect(edits.category).toBeNull();
    expect(edits.condition).toBeNull();
    expect(edits.override).toBeNull();
  });

  it("rejects an empty title when a listing exists", () => {
    expect(() => parseReviewEdits({ ...base, title: "  " })).toThrow(/Title/);
  });

  it("rejects a title over the eBay ceiling", () => {
    const long = "x".repeat(EBAY_TITLE_MAX + 1);
    expect(() => parseReviewEdits({ ...base, title: long })).toThrow(/80/);
  });

  it("rejects an empty description when a listing exists", () => {
    expect(() => parseReviewEdits({ ...base, description: "" })).toThrow(
      /Description/,
    );
  });

  it("rejects junk prices instead of silently clearing the override", () => {
    expect(() => parseReviewEdits({ ...base, price: "abc" })).toThrow(/price/i);
    expect(() => parseReviewEdits({ ...base, price: "-5" })).toThrow(/price/i);
  });

  it("normalizes price strings to cents", () => {
    expect(parseReviewEdits({ ...base, price: "12.345" }).override).toBe(12.35);
  });

  it("parses the cost basis (#101): blank clears, $0 is real, junk throws", () => {
    expect(parseReviewEdits({ ...base, costBasis: "" }).costBasis).toBeNull();
    expect(parseReviewEdits({ ...base, costBasis: "0" }).costBasis).toBe(0);
    expect(parseReviewEdits({ ...base, costBasis: "12.345" }).costBasis).toBe(12.35);
    expect(() => parseReviewEdits({ ...base, costBasis: "abc" })).toThrow(
      /cost basis/i,
    );
    expect(() => parseReviewEdits({ ...base, costBasis: "-5" })).toThrow(
      /cost basis/i,
    );
  });

  it("rejects non-string field payloads (multipart abuse)", () => {
    expect(() =>
      parseReviewEdits({ ...base, category: 7 as unknown as string }),
    ).toThrow(/category/);
  });
});
