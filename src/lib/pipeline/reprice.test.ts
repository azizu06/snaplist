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
