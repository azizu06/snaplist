import { describe, expect, it } from "vitest";
import {
  confidenceSignalsFor,
  identificationSignalsFrom,
  priceToConfidence,
} from "./from-price";
import type { ExtractedAttributes } from "../pipeline/types";
import type { PriceResult } from "../pricing/types";

/**
 * `from-price.ts` bridges the pricing-tier vocabulary onto the confidence-tier
 * vocabulary (#31/#32/#60 calibration). It has no dedicated test file; the tier
 * mappings below (`ebay-sold`, `upc-aided-web`) are exercised elsewhere only
 * indirectly (tier-selection ordering, not the confidence they produce), so
 * this covers the calibration directly at its own seam per AGENTS.md's "pure
 * confidence function" test guidance.
 */

const fullIdentification: ExtractedAttributes = {
  brand: "Sony",
  model: "WH-1000XM4",
  category: "electronics",
  upc: "027242920866",
};

function price(overrides: Partial<PriceResult>): PriceResult {
  return {
    suggested: 100,
    range: { min: 80, max: 120 },
    confidence: 0.7,
    sources: [],
    tier: "llm-only",
    ...overrides,
  };
}

describe("identificationSignalsFrom", () => {
  it("resolves each signal independently from the attributes that establish it", () => {
    expect(identificationSignalsFrom({})).toEqual({
      brandResolved: false,
      modelResolved: false,
      barcodeDecoded: false,
      categoryUnambiguous: false,
    });
    expect(identificationSignalsFrom({ brand: "Sony" }).brandResolved).toBe(true);
    expect(identificationSignalsFrom({ model: "WH-1000XM4" }).modelResolved).toBe(true);
    expect(identificationSignalsFrom({ category: "electronics" }).categoryUnambiguous).toBe(
      true,
    );
  });

  it("decodes the barcode signal from either ISBN or UPC alone", () => {
    expect(identificationSignalsFrom({ isbn: "9780131103627" }).barcodeDecoded).toBe(true);
    expect(identificationSignalsFrom({ upc: "027242920866" }).barcodeDecoded).toBe(true);
    expect(identificationSignalsFrom({}).barcodeDecoded).toBe(false);
  });
});

describe("confidenceSignalsFor — ebay-sold tier mapping (#60)", () => {
  const soldSources = [
    { url: "https://example.com/sold/1", title: "Sold comp", kind: "sold-comp" },
  ];

  it("a tight sold cluster earns the first-class `sold` confidence tier, uncapped", () => {
    const signals = confidenceSignalsFor(
      fullIdentification,
      price({ tier: "ebay-sold", sources: soldSources, compAgreement: 0.9 }),
    );
    expect(signals.tier).toBe("sold");
    expect(signals.compAgreement).toBe(0.9);
  });

  it("a scattered sold cluster degrades to `web_wide`, keeping the raw agreement", () => {
    const signals = confidenceSignalsFor(
      fullIdentification,
      price({ tier: "ebay-sold", sources: soldSources, compAgreement: 0.1 }),
    );
    expect(signals.tier).toBe("web_wide");
    expect(signals.compAgreement).toBe(0.1);
  });

  it("unreported agreement is treated as tight (no objection) and gets the 0.7 fallback", () => {
    const signals = confidenceSignalsFor(
      fullIdentification,
      price({ tier: "ebay-sold", sources: soldSources }),
    );
    expect(signals.tier).toBe("sold");
    expect(signals.compAgreement).toBe(0.7);
  });

  it("end-to-end: only a tight sold cluster clears the publish-eligibility gate", () => {
    const tight = priceToConfidence(
      fullIdentification,
      price({ tier: "ebay-sold", sources: soldSources, compAgreement: 0.9 }),
    );
    const scattered = priceToConfidence(
      fullIdentification,
      price({ tier: "ebay-sold", sources: soldSources, compAgreement: 0.1 }),
    );
    expect(tight.autopilotEligible).toBe(true);
    expect(scattered.autopilotEligible).toBe(false);
    expect(tight.score).toBeGreaterThan(scattered.score);
  });
});

describe("confidenceSignalsFor — upc-aided-web strongly-corroborated asking gate", () => {
  const askingFrom = (urls: string[]) =>
    urls.map((url, i) => ({ url, title: `Asking ${i}`, kind: "asking-comp" }));

  it("a tight cluster across 4+ INDEPENDENT hosts earns `web_tight`, uncapped agreement", () => {
    const signals = confidenceSignalsFor(
      fullIdentification,
      price({
        tier: "upc-aided-web",
        compAgreement: 0.9,
        sources: askingFrom([
          "https://www.ebay.com/itm/1",
          "https://mercari.com/item/2",
          "https://poshmark.com/listing/3",
          "https://depop.com/products/4",
        ]),
      }),
    );
    expect(signals.tier).toBe("web_tight");
    expect(signals.compAgreement).toBe(0.9);
  });

  it("counts www.host.com and host.com as the SAME independent source, not two", () => {
    // Four raw sources, but only 3 DISTINCT hosts once "www." is folded — below
    // the 4-independent-host bar. A naive `sources.length >= 4` check would
    // wrongly pass this; the real host-dedup must not.
    const signals = confidenceSignalsFor(
      fullIdentification,
      price({
        tier: "upc-aided-web",
        compAgreement: 0.9,
        sources: askingFrom([
          "https://www.ebay.com/itm/1",
          "https://ebay.com/itm/2",
          "https://mercari.com/item/3",
          "https://poshmark.com/listing/4",
        ]),
      }),
    );
    expect(signals.tier).toBe("web_wide");
    // Not strongly corroborated → the asking-agreement cap applies even though
    // the provider reported a tight 0.9.
    expect(signals.compAgreement).toBe(0.4);
  });
});
