import { describe, expect, it } from "vitest";
import {
  marketplaceCurrency,
  toEbayAspects,
  toEbayCondition,
  toEbayPrice,
  toEbayPublishRequest,
  type ListingForPublish,
} from "./map";
import { PublishValidationError } from "./errors";

/**
 * Pure mapping tests (issue #14): SnapList's persisted listing shape -> the
 * provider-shaped EbayPublishRequest. No network, no database.
 */

describe("toEbayCondition", () => {
  it("maps the common SnapList condition vocabulary onto eBay's enum", () => {
    expect(toEbayCondition("new")).toBe("NEW");
    expect(toEbayCondition("Brand New")).toBe("NEW");
    expect(toEbayCondition("like new")).toBe("LIKE_NEW");
    expect(toEbayCondition("excellent")).toBe("USED_EXCELLENT");
    expect(toEbayCondition("very good")).toBe("USED_VERY_GOOD");
    expect(toEbayCondition("good")).toBe("USED_GOOD");
    expect(toEbayCondition("fair")).toBe("USED_ACCEPTABLE");
    expect(toEbayCondition("for parts")).toBe("FOR_PARTS_OR_NOT_WORKING");
  });

  it("maps poor to the least-overstating supported used grade", () => {
    expect(toEbayCondition("poor")).toBe("USED_ACCEPTABLE");
  });

  it("is case/whitespace tolerant", () => {
    expect(toEbayCondition("  GOOD ")).toBe("USED_GOOD");
    expect(toEbayCondition("Like New")).toBe("LIKE_NEW");
  });

  it("defaults CONSERVATIVELY to USED_GOOD (never NEW) for unknown/missing", () => {
    expect(toEbayCondition(undefined)).toBe("USED_GOOD");
    expect(toEbayCondition(null)).toBe("USED_GOOD");
    expect(toEbayCondition("gently loved")).toBe("USED_GOOD");
  });
});

describe("toEbayAspects", () => {
  it("converts itemSpecifics (name -> string) into Sell API aspects (name -> string[])", () => {
    expect(
      toEbayAspects({ itemSpecifics: { Brand: "Sony", Model: "WH-1000XM4" } }),
    ).toEqual({ Brand: ["Sony"], Model: ["WH-1000XM4"] });
  });

  it("drops non-string and empty values instead of sending them malformed", () => {
    expect(
      toEbayAspects({
        itemSpecifics: { Brand: "Sony", Broken: 42, Empty: "", Weird: ["a"] },
      }),
    ).toEqual({ Brand: ["Sony"] });
  });

  it("returns {} when copy has no itemSpecifics (or a non-object one)", () => {
    expect(toEbayAspects({})).toEqual({});
    expect(toEbayAspects({ itemSpecifics: "nope" })).toEqual({});
    expect(toEbayAspects({ itemSpecifics: ["nope"] })).toEqual({});
  });
});

describe("toEbayPrice", () => {
  it("formats as a 2-decimal string with the currency (Sell API money type)", () => {
    expect(toEbayPrice(24)).toEqual({ value: "24.00", currency: "USD" });
    expect(toEbayPrice(19.999)).toEqual({ value: "20.00", currency: "USD" });
    expect(toEbayPrice(12.5, "EUR")).toEqual({ value: "12.50", currency: "EUR" });
  });

  it("throws on non-positive / non-finite prices", () => {
    expect(() => toEbayPrice(0)).toThrowError(/non-positive/);
    expect(() => toEbayPrice(-3)).toThrowError(/non-positive/);
    expect(() => toEbayPrice(Number.NaN)).toThrowError(/non-positive/);
  });

  it("throws a user-actionable PublishValidationError, not a redactable internal error (#57)", () => {
    // The caller surfaces PublishValidationError.message but redacts plain Errors,
    // so validation failures must carry this type to remain actionable to the seller.
    expect(() => toEbayPrice(0)).toThrow(PublishValidationError);
    expect(() =>
      toEbayPublishRequest({
        listingId: "l1",
        title: "",
        description: "",
        copy: {},
        condition: null,
        price: 10,
        imageUrls: ["https://img"],
        categoryId: "88433",
        currency: "USD",
      }),
    ).toThrow(PublishValidationError);
  });
});

describe("toEbayPublishRequest", () => {
  const base: ListingForPublish = {
    listingId: "11111111-2222-3333-4444-555555555555",
    title: "Sony WH-1000XM4 Wireless Headphones",
    description: "Great condition, fully working.",
    copy: { itemSpecifics: { Brand: "Sony" }, tags: ["headphones"] },
    condition: "good",
    price: 149.5,
    imageUrls: ["https://example.com/signed/photo.png"],
    categoryId: "112529",
  };

  it("assembles the full provider-shaped request", () => {
    expect(toEbayPublishRequest(base)).toEqual({
      sku: base.listingId,
      title: base.title,
      description: base.description,
      aspects: { Brand: ["Sony"] },
      condition: "USED_GOOD",
      price: { value: "149.50", currency: "USD" },
      quantity: 1,
      categoryId: "112529",
      imageUrls: ["https://example.com/signed/photo.png"],
    });
  });

  it("uses the listing id as the SKU (idempotent inventory upsert key)", () => {
    expect(toEbayPublishRequest(base).sku).toBe(base.listingId);
  });

  it("never publishes poor condition as USED_GOOD", () => {
    expect(toEbayPublishRequest({ ...base, condition: "poor" }).condition).toBe(
      "USED_ACCEPTABLE",
    );
  });

  it("throws on a missing title or description", () => {
    expect(() => toEbayPublishRequest({ ...base, title: "  " })).toThrowError(
      /title or description/,
    );
    expect(() => toEbayPublishRequest({ ...base, description: "" })).toThrowError(
      /title or description/,
    );
  });
});

describe("marketplaceCurrency", () => {
  it("maps the configured marketplace to its currency (never an unconditional USD)", () => {
    expect(marketplaceCurrency("EBAY_US")).toBe("USD");
    expect(marketplaceCurrency("EBAY_GB")).toBe("GBP");
    expect(marketplaceCurrency("EBAY_DE")).toBe("EUR");
    expect(marketplaceCurrency("EBAY_CA")).toBe("CAD");
  });

  it("honors the EBAY_CURRENCY override and falls back to USD for unknown ids", () => {
    expect(marketplaceCurrency("EBAY_GB", "usd")).toBe("USD");
    expect(marketplaceCurrency("EBAY_XX")).toBe("USD");
    expect(marketplaceCurrency(undefined)).toBe("USD");
    expect(marketplaceCurrency("EBAY_GB", "  ")).toBe("GBP"); // blank override ignored
  });
});
