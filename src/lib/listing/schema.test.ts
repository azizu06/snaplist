import { describe, expect, it } from "vitest";
import {
  ebayListingRawSchema,
  itemSpecificsFromPairs,
  type EbayListing,
} from "./schema";
import { itemSpecificsToPairs } from "./schema.testing";
import { fallbackEbayListing } from "./generate";

function needsValidatedEbayListing(listing: EbayListing): void {
  void listing;
}

/**
 * The model-facing item-specifics representation (issue #691).
 *
 * OpenAI structured outputs cannot express an open-ended dictionary, so the model
 * emits an ORDERED LIST of `{ name, value }` pairs. Everything downstream still
 * consumes the name→value record, which makes the conversion — and specifically its
 * duplicate-name rule — load-bearing: a list can carry two entries under one name,
 * a record cannot.
 */
describe("itemSpecificsFromPairs", () => {
  it("converts an ordered pair list into the name→value record consumers expect", () => {
    expect(
      itemSpecificsFromPairs([
        { name: "Brand", value: "Sony" },
        { name: "Model", value: "WH-1000XM4" },
      ]),
    ).toEqual({ Brand: "Sony", Model: "WH-1000XM4" });
  });

  it("keeps the FIRST value when a name repeats, and never merges or corrupts values", () => {
    // Collision rule: first occurrence wins. A later duplicate cannot overwrite an
    // earlier, better-grounded value, and the two values are never concatenated.
    expect(
      itemSpecificsFromPairs([
        { name: "Brand", value: "Sony" },
        { name: "Brand", value: "Bose" },
      ]),
    ).toEqual({ Brand: "Sony" });
  });

  it("treats names differing only by case or surrounding whitespace as the same name", () => {
    expect(
      itemSpecificsFromPairs([
        { name: "Brand", value: "Sony" },
        { name: " brand ", value: "Bose" },
      ]),
    ).toEqual({ Brand: "Sony" });
  });

  it("trims the retained name so a padded key cannot shadow the clean one", () => {
    expect(itemSpecificsFromPairs([{ name: "  Brand  ", value: "Sony" }])).toEqual({
      Brand: "Sony",
    });
  });

  it("drops an entry whose name is blank rather than creating an empty key", () => {
    expect(
      itemSpecificsFromPairs([
        { name: "   ", value: "Sony" },
        { name: "Model", value: "WH-1000XM4" },
      ]),
    ).toEqual({ Model: "WH-1000XM4" });
  });

  it("returns an empty record for an empty list", () => {
    expect(itemSpecificsFromPairs([])).toEqual({});
  });
});

describe("itemSpecificsToPairs", () => {
  it("round-trips a record through the model-facing pair list", () => {
    const record = { Brand: "Sony", Model: "WH-1000XM4" };
    expect(itemSpecificsFromPairs(itemSpecificsToPairs(record))).toEqual(record);
  });
});

describe("ebayListingRawSchema (the schema handed to generateObject)", () => {
  it("does not treat a fallback candidate as a validated listing", () => {
    // @ts-expect-error A candidate must pass the strict parse before this boundary.
    needsValidatedEbayListing(fallbackEbayListing({ title: "Vintage lamp" }));
  });

  it("accepts the pair-list shape", () => {
    const parsed = ebayListingRawSchema.safeParse({
      title: "Sony WH-1000XM4 Headphones",
      itemSpecifics: [{ name: "Brand", value: "Sony" }],
      description: "Headphones.",
      tags: ["sony"],
    });
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  });

  it("still accepts an EMPTY specifics list so deterministic repair can run (#691 criterion 5)", () => {
    // The permissive schema must not throw inside `generateObject`; the strict
    // `ebayListingSchema` is what enforces "at least one item specific", AFTER repair.
    const parsed = ebayListingRawSchema.safeParse({
      title: "Mystery item",
      itemSpecifics: [],
      description: "An item.",
      tags: [],
    });
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  });

  it("still accepts an over-long title so deterministic repair can run (#691 criterion 5)", () => {
    const parsed = ebayListingRawSchema.safeParse({
      title: "x".repeat(200),
      itemSpecifics: [{ name: "Brand", value: "Sony" }],
      description: "An item.",
      tags: [],
    });
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  });

  it("rejects a name→value record — the shape OpenAI cannot express", () => {
    const parsed = ebayListingRawSchema.safeParse({
      title: "Sony WH-1000XM4 Headphones",
      itemSpecifics: { Brand: "Sony" },
      description: "Headphones.",
      tags: ["sony"],
    });
    expect(parsed.success).toBe(false);
  });
});
