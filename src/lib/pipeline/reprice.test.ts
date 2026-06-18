import { describe, expect, it } from "vitest";
import type { ItemSignal, PriceResult } from "../pricing";
import { mergeSpecs, repriceWithSpecs } from "./reprice";

/**
 * Re-price (clarify-variant) core tests. The seam under test is PURE given an
 * injected pricer: merge the seller-supplied discriminating specs, route them into
 * the pricing signal, and recompute confidence via the SAME calibrated bridge the
 * full pipeline uses. We assert behavior at that seam — never the real network.
 */

/** A schema-valid branded-web price with a controllable comp-agreement. */
function brandedPrice(agreement: number, suggested = 800): PriceResult {
  return {
    suggested,
    range: { min: suggested - 100, max: suggested + 100 },
    confidence: 0.5,
    sources: [{ url: "https://example.com/comp", kind: "asking-comp" }],
    tier: "branded-web",
    compAgreement: agreement,
  };
}

/**
 * A schema-valid SOLD-grounded price (a real completed-sale comp). The bridge maps
 * it to the high `sold` tier with UNCAPPED agreement, so identification completeness
 * is the isolated mover in the #3 tests (no asking-cap clouding the delta).
 */
function soldPrice(agreement: number, suggested = 130): PriceResult {
  return {
    suggested,
    range: { min: suggested - 10, max: suggested + 10 },
    confidence: 0.8,
    sources: [{ url: "https://www.ebay.com/itm/1", kind: "sold-comp" }],
    tier: "ebay-sold",
    compAgreement: agreement,
  };
}

describe("mergeSpecs", () => {
  it("appends new specs after existing, preserving order", () => {
    expect(mergeSpecs(["i7"], ["RTX 3060", "16GB RAM"])).toEqual([
      "i7",
      "RTX 3060",
      "16GB RAM",
    ]);
  });

  it("trims, drops blanks, and de-dupes case-insensitively", () => {
    expect(mergeSpecs(["RTX 3060"], ["  rtx 3060 ", "", "  ", "256GB SSD"])).toEqual([
      "RTX 3060",
      "256GB SSD",
    ]);
  });

  it("treats a missing existing list as empty", () => {
    expect(mergeSpecs(undefined, ["i5"])).toEqual(["i5"]);
  });

  it("caps the merged list so a runaway input can't bloat the signal", () => {
    const added = Array.from({ length: 40 }, (_, i) => `spec-${i}`);
    expect(mergeSpecs([], added).length).toBeLessThanOrEqual(12);
  });
});

describe("repriceWithSpecs", () => {
  it("forwards the MERGED specs into the pricing signal", async () => {
    let seen: ItemSignal | null = null;
    await repriceWithSpecs({
      attributes: { brand: "Acer", model: "Predator", specs: ["i7"] },
      addedSpecs: ["RTX 3060"],
      priceItem: async (signal) => {
        seen = signal;
        return brandedPrice(0.9);
      },
    });
    expect(seen).not.toBeNull();
    expect(seen!.specs).toEqual(["i7", "RTX 3060"]);
    // attributes carry through so the router can still tier correctly.
    expect(seen!.brand).toBe("Acer");
    expect(seen!.model).toBe("Predator");
  });

  it("earns higher confidence when the added spec tightens the comp cluster", async () => {
    const attributes = { brand: "Acer", model: "Predator Helios 300", category: "electronics" };

    // Before: scattered asking comps (low agreement).
    const before = await repriceWithSpecs({
      attributes,
      addedSpecs: [],
      priceItem: async () => brandedPrice(0.1),
    });
    // After: the variant detail tightens the cluster (high agreement).
    const after = await repriceWithSpecs({
      attributes,
      addedSpecs: ["RTX 3060", "16GB RAM"],
      priceItem: async () => brandedPrice(1),
    });

    expect(after.confidence.score).toBeGreaterThan(before.confidence.score);
    expect(after.mergedSpecs).toEqual(["RTX 3060", "16GB RAM"]);
  });

  it("does NOT inflate: a tighter ASKING cluster alone cannot reach the autopilot gate", async () => {
    // Fully-identified branded item, asking-only, perfectly tight cluster.
    const res = await repriceWithSpecs({
      attributes: {
        brand: "Acer",
        model: "Predator Helios 300",
        category: "electronics",
        upc: "012345678905",
      },
      addedSpecs: ["RTX 3060"],
      autopilotEnabled: true,
      priceItem: async () => brandedPrice(1),
    });
    // ASKING_AGREEMENT_CAP keeps no-sold-comp items sub-gate (PRD honesty).
    expect(res.confidence.autopilotEligible).toBe(false);
    expect(res.confidence.band).not.toBe("high");
  });

  it("returns attributes with the merged specs applied", async () => {
    const res = await repriceWithSpecs({
      attributes: { brand: "Acer", specs: ["i7"] },
      addedSpecs: ["RTX 3060"],
      priceItem: async () => brandedPrice(0.5),
    });
    expect(res.attributes.specs).toEqual(["i7", "RTX 3060"]);
    expect(res.attributes.brand).toBe("Acer");
  });
});

describe("repriceWithSpecs — seller-confirmed identity (#3 confidence lever)", () => {
  it("merges confirmed brand/model/category into the pricing signal (narrows the search)", async () => {
    let seen: ItemSignal | null = null;
    await repriceWithSpecs({
      // Vision read everything but the model.
      attributes: { brand: "Sony", category: "electronics", upc: "027242920569" },
      addedSpecs: [],
      confirmedIdentity: { model: "WH-1000XM4" },
      priceItem: async (signal) => {
        seen = signal;
        return soldPrice(0.9);
      },
    });
    expect(seen!.model).toBe("WH-1000XM4");
    // Untouched fields carry through unchanged.
    expect(seen!.brand).toBe("Sony");
    expect(seen!.category).toBe("electronics");
  });

  it("a confirmed field vision missed raises identification completeness (≈ +0.0625)", async () => {
    // 3/4 identified (brand + barcode + category; model missing). The price signal
    // is held IDENTICAL across both runs, so the only mover is the id term.
    const base = { brand: "Sony", category: "electronics", upc: "027242920569" };
    const before = await repriceWithSpecs({
      attributes: base,
      addedSpecs: [],
      priceItem: async () => soldPrice(0.9),
    });
    const after = await repriceWithSpecs({
      attributes: base,
      addedSpecs: [],
      confirmedIdentity: { model: "WH-1000XM4" }, // → 4/4
      priceItem: async () => soldPrice(0.9),
    });
    expect(after.confidence.score).toBeGreaterThan(before.confidence.score);
    // One of four id fields × the 0.25 identification weight = 0.0625.
    expect(after.confidence.score - before.confidence.score).toBeCloseTo(0.0625, 4);
  });

  it("a seller correction OVERRIDES a misidentified attribute (the seller is the authority)", async () => {
    let seen: ItemSignal | null = null;
    await repriceWithSpecs({
      attributes: { brand: "Acer", model: "Wrong Model", category: "electronics" },
      addedSpecs: [],
      confirmedIdentity: { brand: "Asus", model: "ROG Strix G15" },
      priceItem: async (signal) => {
        seen = signal;
        return soldPrice(0.9);
      },
    });
    expect(seen!.brand).toBe("Asus");
    expect(seen!.model).toBe("ROG Strix G15");
  });

  it("ignores blank/whitespace confirmations (never overwrites a real value with empty)", async () => {
    let seen: ItemSignal | null = null;
    await repriceWithSpecs({
      attributes: { brand: "Sony", model: "WH-1000XM4", category: "electronics" },
      addedSpecs: [],
      confirmedIdentity: { brand: "  ", model: "" },
      priceItem: async (signal) => {
        seen = signal;
        return soldPrice(0.9);
      },
    });
    expect(seen!.brand).toBe("Sony");
    expect(seen!.model).toBe("WH-1000XM4");
  });

  it("persists the confirmed identity onto the returned attributes", async () => {
    const res = await repriceWithSpecs({
      attributes: { category: "electronics" },
      addedSpecs: [],
      confirmedIdentity: { brand: "Sony", model: "WH-1000XM4" },
      priceItem: async () => soldPrice(0.9),
    });
    expect(res.attributes.brand).toBe("Sony");
    expect(res.attributes.model).toBe("WH-1000XM4");
  });
});
