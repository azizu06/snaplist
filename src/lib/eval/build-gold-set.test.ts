import { describe, expect, it } from "vitest";
import {
  GOLD_MIN_PRICES,
  buildGoldItem,
  buildGoldSet,
  priceBandFromSoldPrices,
  seedsFromGoldSet,
  type GoldSeed,
  type GoldSetSources,
} from "./build-gold-set";
import { goldItemSchema } from "./types";

const seed = (id: string, extra: Partial<GoldSeed> = {}): GoldSeed => ({
  id,
  truth: { brand: "Sony", model: "WH-1000XM4", category: "electronics", condition: "good" },
  ...extra,
});

/** A source returning a fixed price list per seed id. */
function sourceFrom(map: Record<string, number[]>): GoldSetSources {
  return { async soldPrices(s) {
    return map[s.id] ?? [];
  } };
}

describe("priceBandFromSoldPrices", () => {
  it("uses observed min..max for a small set (3-4 points)", () => {
    expect(priceBandFromSoldPrices([170, 180, 190])).toEqual({ low: 170, high: 190 });
  });

  it("trims the single low/high outlier once there are >=5 points", () => {
    // 50 and 500 are flukes; the band should be the trimmed [170, 200].
    expect(priceBandFromSoldPrices([50, 170, 185, 200, 500])).toEqual({ low: 170, high: 200 });
  });

  it("returns null below the minimum comp count (no defensible band)", () => {
    expect(priceBandFromSoldPrices([180, 190])).toBeNull();
    expect(priceBandFromSoldPrices([])).toBeNull();
    expect(GOLD_MIN_PRICES).toBeGreaterThanOrEqual(3);
  });

  it("ignores non-positive/non-finite prices", () => {
    expect(priceBandFromSoldPrices([0, -5, NaN, 170, 180, 190])).toEqual({ low: 170, high: 190 });
  });

  it("guarantees low < high even when all sales are identical", () => {
    const band = priceBandFromSoldPrices([100, 100, 100]);
    expect(band).not.toBeNull();
    expect(band!.low).toBeLessThan(band!.high);
  });
});

describe("buildGoldItem", () => {
  it("derives the band from live sold prices and emits a schema-valid item", async () => {
    const result = await buildGoldItem(
      seed("gold-sony-xm4", { sourceRef: "ref-x", notes: "n" }),
      sourceFrom({ "gold-sony-xm4": [170, 180, 190, 200] }),
    );
    expect(result.item).toBeDefined();
    expect(() => goldItemSchema.parse(result.item)).not.toThrow();
    expect(result.item!.priceBand).toEqual({ low: 170, high: 200 });
    expect(result.item!.truth.model).toBe("WH-1000XM4");
    expect(result.item!.sourceRef).toBe("ref-x");
  });

  it("skips (with a reason) when there is too little sold data", async () => {
    const result = await buildGoldItem(seed("thin"), sourceFrom({ thin: [180] }));
    expect(result.item).toBeUndefined();
    expect(result.skipped).toMatch(/thin: only 1 sold price/);
  });
});

describe("buildGoldSet", () => {
  it("builds items, dedups by id, sorts by id, and reports skips", async () => {
    const seeds = [
      seed("b-item"),
      seed("a-item"),
      seed("thin-item"),
      seed("a-item"), // duplicate id
    ];
    const { items, skipped } = await buildGoldSet(
      seeds,
      sourceFrom({
        "b-item": [100, 110, 120],
        "a-item": [200, 210, 220],
        "thin-item": [50], // < MIN → skipped
      }),
    );
    expect(items.map((i) => i.id)).toEqual(["a-item", "b-item"]); // sorted, deduped
    expect(skipped).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/thin-item: only 1 sold price/),
        expect.stringMatching(/a-item: duplicate id/),
      ]),
    );
  });
});

describe("seedsFromGoldSet", () => {
  it("maps the curated gold set into seeds, preserving truth + sourceRef", () => {
    const seeds = seedsFromGoldSet([
      { id: "g1", sourceRef: "ref-1", truth: { category: "books", isbn: "978..." }, priceBand: { low: 5, high: 20 } },
    ]);
    expect(seeds).toEqual([
      { id: "g1", sourceRef: "ref-1", truth: { category: "books", isbn: "978..." } },
    ]);
  });
});
