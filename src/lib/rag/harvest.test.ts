import { describe, expect, it } from "vitest";
import {
  HARVEST_MIN_COMPS,
  MAX_EXEMPLARS_PER_PRODUCT,
  exemplarFromComps,
  exemplarsFromComps,
  harvestSourceRef,
  referenceItemFromListing,
} from "./harvest";
import { referenceItemSchema } from "./types";
import type { EbaySoldComp } from "../pricing/providers/ebay-sold";

/**
 * Harvest + flywheel corpus builders (real data, replacing the synthetic seed). Both
 * are PURE — tested offline with crafted comps/listings. The live harvest script does
 * the (credit-spending) fetching; these pin the mapping into the corpus shape.
 */

const comp = (price: number, title?: string, condition?: string): EbaySoldComp => ({
  url: `https://www.ebay.com/itm/${price}-${(title ?? "x").slice(0, 6)}`,
  price,
  title,
  condition,
});

describe("exemplarFromComps", () => {
  const query = { category: "electronics", brand: "Sony", model: "WH-1000XM4" };

  it("mints a real, schema-valid exemplar: robust median price + a real title exemplar", () => {
    const item = exemplarFromComps(
      [
        comp(160, "Sony WH-1000XM4 Wireless Headphones Black", "Pre-Owned"),
        comp(170, "Sony WH-1000XM4 Black", "Pre-Owned"),
        comp(180, "Sony WH-1000XM4 Wireless Noise Cancelling Headphones Black Used", "Pre-Owned"),
      ],
      query,
    );
    expect(item).not.toBeNull();
    expect(() => referenceItemSchema.parse(item)).not.toThrow();
    expect(item!.price).toBeCloseTo(170, 2); // median of real sold prices
    expect(item!.brand).toBe("Sony");
    expect(item!.category).toBe("electronics");
    expect(item!.sourceRef).toBe("harvest-electronics-sony-wh-1000xm4");
    // content = the longest REAL title + the condition fact.
    expect(item!.content).toContain("Sony WH-1000XM4");
    expect(item!.content).toMatch(/Pre-Owned condition/i);
    expect(item!.metadata.source).toBe("ebay-harvest");
    expect(item!.metadata.compCount).toBe(3);
  });

  it("NEVER writes the price into the copy (honest-grounded-copy: no unverifiable price claims)", () => {
    const item = exemplarFromComps(
      [comp(170, "Sony WH-1000XM4 Black", "Pre-Owned"), comp(180, "Sony WH-1000XM4", "Pre-Owned")],
      query,
    );
    expect(item!.content).not.toMatch(/170|175|180|\$/);
  });

  it("reuses #1's robust core: a junk sale can't skew the harvested median", () => {
    const item = exemplarFromComps(
      [
        comp(160, "t1"),
        comp(165, "t2"),
        comp(170, "t3"),
        comp(175, "t4"),
        comp(180, "t5"),
        comp(900, "t6 bundle lot"), // outlier
      ],
      query,
    );
    expect(item!.price).toBeCloseTo(170, 2); // 900 trimmed before the median
    expect(item!.metadata.compCount).toBe(5); // outlier not counted as evidence
    expect((item!.metadata.priceRange as { max: number }).max).toBe(180);
  });

  it("returns null when there isn't enough real evidence (< HARVEST_MIN_COMPS)", () => {
    expect(HARVEST_MIN_COMPS).toBeGreaterThanOrEqual(2);
    expect(exemplarFromComps([comp(100, "only one")], query)).toBeNull();
    expect(exemplarFromComps([], query)).toBeNull();
  });

  it("falls back to the queried identity when no comp carried a title", () => {
    const item = exemplarFromComps([comp(40), comp(50)], {
      category: "board-games",
      brand: "Catan Studio",
      model: "Settlers of Catan",
    });
    expect(item!.content).toContain("Catan Studio Settlers of Catan");
  });

  it("harvestSourceRef is stable + slugged so a re-harvest UPSERTs, never duplicates", () => {
    expect(harvestSourceRef(query)).toBe("harvest-electronics-sony-wh-1000xm4");
    expect(harvestSourceRef({ category: "generic" })).toBe("harvest-generic");
  });
});

describe("exemplarsFromComps — many exemplars per page (density per credit)", () => {
  const query = { category: "electronics", brand: "Sony", model: "WH-1000XM4" };

  it("mints several DISTINCT-title exemplars from a single page, sharing identity + price", () => {
    const items = exemplarsFromComps(
      [
        comp(160, "Sony WH-1000XM4 Black", "Pre-Owned"),
        comp(170, "Sony WH-1000XM4 Wireless Headphones Silver", "Pre-Owned"),
        comp(165, "Sony WH-1000XM4 Noise Cancelling Over-Ear", "Open Box"),
        comp(175, "Sony WH-1000XM4 Headphones with Original Case", "Pre-Owned"),
      ],
      query,
    );
    expect(items.length).toBe(4);
    // Distinct copy exemplars (varied real seller phrasing).
    expect(new Set(items.map((i) => i.content)).size).toBe(4);
    // Same product identity + the one robust price across all rows.
    expect(items.every((i) => i.brand === "Sony" && i.price === items[0].price)).toBe(true);
    // Unique sourceRefs: first un-indexed (back-compat), rest -1, -2, …
    expect(new Set(items.map((i) => i.sourceRef)).size).toBe(4);
    expect(items[0].sourceRef).toBe("harvest-electronics-sony-wh-1000xm4");
    expect(items[1].sourceRef).toBe("harvest-electronics-sony-wh-1000xm4-1");
    // Price never leaks into any exemplar's copy.
    expect(items.every((i) => !/\$|160|165|170|175/.test(i.content))).toBe(true);
  });

  it("caps the exemplars per product so one item can't flood the corpus", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      comp(160 + i, `Sony WH-1000XM4 distinct variant number ${i}`, "Pre-Owned"),
    );
    expect(exemplarsFromComps(many, query).length).toBe(MAX_EXEMPLARS_PER_PRODUCT);
  });

  it("de-dupes identical titles case-insensitively (not real variety)", () => {
    const items = exemplarsFromComps(
      [
        comp(160, "Sony WH-1000XM4 Black"),
        comp(170, "sony wh-1000xm4 black"),
        comp(180, "SONY WH-1000XM4  BLACK"),
      ],
      query,
    );
    expect(items.length).toBe(1);
  });

  it("returns [] when there isn't enough real evidence", () => {
    expect(exemplarsFromComps([comp(100, "only one")], query)).toEqual([]);
  });
});

describe("referenceItemFromListing (flywheel)", () => {
  it("turns a seller-approved listing into a fully-owned corpus exemplar", () => {
    const item = referenceItemFromListing({
      id: "item-123",
      attributes: { brand: "Sony", model: "WH-1000XM4", category: "electronics" },
      content:
        "Sony WH-1000XM4 Wireless Noise-Cancelling Headphones — Black. Excellent used " +
        "condition, includes original case and cables. Tested and fully functional.",
      price: 165,
    });
    expect(() => referenceItemSchema.parse(item)).not.toThrow();
    expect(item.sourceRef).toBe("flywheel-item-123");
    expect(item.content).toContain("Sony WH-1000XM4");
    expect(item.metadata.source).toBe("flywheel");
    expect(item.category).toBe("electronics");
    expect(item.price).toBe(165);
  });

  it("degrades a missing category to 'generic' so graceful-degradation still has data", () => {
    const item = referenceItemFromListing({
      id: "x",
      attributes: {},
      content: "A used desk lamp, works fine.",
      price: 10,
    });
    expect(item.category).toBe("generic");
  });
});
