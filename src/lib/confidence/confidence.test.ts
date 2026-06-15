import { describe, it, expect } from "vitest";
import { computeConfidence, parseSignals } from "./confidence";
import type { ConfidenceSignals } from "./confidence";

/**
 * A maximally-confident baseline: ISBN tier, perfect comp agreement, fully
 * resolved identification. Individual tests clone-and-tweak one signal so each
 * assertion isolates the effect of that signal (external behavior, not internals).
 */
const ideal: ConfidenceSignals = {
  tier: "isbn",
  compAgreement: 1,
  identification: {
    brandResolved: true,
    modelResolved: true,
    barcodeDecoded: true,
    categoryUnambiguous: true,
  },
};

const fullId = ideal.identification;

describe("computeConfidence — bands by pricing tier", () => {
  it("ISBN tier with full identification lands in the high band", () => {
    const r = computeConfidence(ideal);
    expect(r.band).toBe("high");
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
  });

  it("a tight web comp cluster lands in the high band", () => {
    const r = computeConfidence({
      ...ideal,
      tier: "web_tight",
      compAgreement: 1,
    });
    expect(r.band).toBe("high");
  });

  it("wide comp dispersion drops out of the high band", () => {
    const tight = computeConfidence({ ...ideal, tier: "web_wide", compAgreement: 1 });
    const wide = computeConfidence({ ...ideal, tier: "web_wide", compAgreement: 0 });
    expect(wide.score).toBeLessThan(tight.score);
    expect(wide.band).not.toBe("high");
  });

  it("a generic depreciation estimate is not high confidence", () => {
    const r = computeConfidence({
      ...ideal,
      tier: "depreciation",
      compAgreement: 0,
    });
    expect(r.band).toBe("low");
  });

  it("an LLM-only fallback is low confidence even with full identification", () => {
    const r = computeConfidence({ tier: "llm_only", compAgreement: 0, identification: fullId });
    expect(r.band).toBe("low");
    expect(r.autopilotEligible).toBe(false);
  });
});

describe("computeConfidence — tier ordering", () => {
  it("ranks tiers ISBN > sold > web_tight > web_wide > depreciation > llm_only when other signals are equal", () => {
    const at = (tier: ConfidenceSignals["tier"]) =>
      computeConfidence({ ...ideal, tier, compAgreement: 0.5 }).score;
    expect(at("isbn")).toBeGreaterThan(at("sold"));
    expect(at("sold")).toBeGreaterThan(at("web_tight"));
    expect(at("web_tight")).toBeGreaterThan(at("web_wide"));
    expect(at("web_wide")).toBeGreaterThan(at("depreciation"));
    expect(at("depreciation")).toBeGreaterThan(at("llm_only"));
  });
});

describe("computeConfidence — sold-comp tier (issue #60)", () => {
  // The signature outcome of #60: a real completed-sale comp is the strongest
  // USED-price signal, so the `sold` tier must outrank the asking/web tiers in
  // the composite (ADR-0001: "sold beats asking"). The pricing→confidence bridge
  // only routes a sold comp here when its cluster is TIGHT; a scattered sold set
  // degrades to `web_wide` upstream (tested in vision/pipeline), so within the
  // composite the `sold` tier represents a tight, sold-grounded price.
  it("a sold comp outranks a strong asking comp at identical other signals", () => {
    const sold = computeConfidence({ ...ideal, tier: "sold", compAgreement: 0.8 });
    const asking = computeConfidence({ ...ideal, tier: "web_tight", compAgreement: 0.8 });
    expect(sold.score).toBeGreaterThan(asking.score);
  });

  it("ranks below a structured ISBN lookup (exact identity still beats a sale comp)", () => {
    const sold = computeConfidence({ ...ideal, tier: "sold", compAgreement: 1 });
    const isbn = computeConfidence({ ...ideal, tier: "isbn", compAgreement: 1 });
    expect(sold.score).toBeLessThan(isbn.score);
  });

  it("a tight, fully-identified sold cluster is high-band and autopilot eligible", () => {
    const r = computeConfidence({ ...ideal, tier: "sold", compAgreement: 1 });
    expect(r.band).toBe("high");
    expect(r.autopilotEligible).toBe(true);
  });

  it("tighter sold agreement yields a higher score (the tight-vs-scattered signal)", () => {
    const looser = computeConfidence({ ...ideal, tier: "sold", compAgreement: 0.5 });
    const tighter = computeConfidence({ ...ideal, tier: "sold", compAgreement: 1 });
    expect(tighter.score).toBeGreaterThan(looser.score);
  });

  it("parseSignals accepts the sold tier", () => {
    expect(() => parseSignals({ ...ideal, tier: "sold" })).not.toThrow();
  });
});

describe("computeConfidence — comp agreement", () => {
  it("higher comp agreement yields a higher score (monotonic)", () => {
    const low = computeConfidence({ ...ideal, tier: "web_wide", compAgreement: 0 });
    const mid = computeConfidence({ ...ideal, tier: "web_wide", compAgreement: 0.5 });
    const high = computeConfidence({ ...ideal, tier: "web_wide", compAgreement: 1 });
    expect(mid.score).toBeGreaterThan(low.score);
    expect(high.score).toBeGreaterThan(mid.score);
  });
});

describe("computeConfidence — identification completeness", () => {
  it("each missing identification field lowers the score monotonically", () => {
    const base = { ...ideal, tier: "web_tight" as const, compAgreement: 1 };
    const all = computeConfidence(base).score;
    const noBrand = computeConfidence({
      ...base,
      identification: { ...fullId, brandResolved: false },
    }).score;
    const noBrandNoModel = computeConfidence({
      ...base,
      identification: { ...fullId, brandResolved: false, modelResolved: false },
    }).score;
    const none = computeConfidence({
      ...base,
      identification: {
        brandResolved: false,
        modelResolved: false,
        barcodeDecoded: false,
        categoryUnambiguous: false,
      },
    }).score;

    expect(noBrand).toBeLessThan(all);
    expect(noBrandNoModel).toBeLessThan(noBrand);
    expect(none).toBeLessThan(noBrandNoModel);
  });

  it("dropping any single identification field reduces the score", () => {
    const base = { ...ideal, tier: "web_tight" as const, compAgreement: 1 };
    const all = computeConfidence(base).score;
    for (const field of [
      "brandResolved",
      "modelResolved",
      "barcodeDecoded",
      "categoryUnambiguous",
    ] as const) {
      const dropped = computeConfidence({
        ...base,
        identification: { ...fullId, [field]: false },
      }).score;
      expect(dropped).toBeLessThan(all);
    }
  });
});

describe("computeConfidence — autopilot gate", () => {
  it("a score at or above the threshold is autopilot eligible", () => {
    const r = computeConfidence(ideal);
    expect(r.score).toBeGreaterThanOrEqual(0.75);
    expect(r.autopilotEligible).toBe(true);
  });

  it("a score below the threshold is not eligible", () => {
    const r = computeConfidence({ tier: "llm_only", compAgreement: 0, identification: fullId });
    expect(r.score).toBeLessThan(0.75);
    expect(r.autopilotEligible).toBe(false);
  });

  it("disabling autopilot forces not-eligible even for a high score", () => {
    const r = computeConfidence(ideal, { autopilotEnabled: false });
    expect(r.band).toBe("high");
    expect(r.autopilotEligible).toBe(false);
  });

  it("respects a custom threshold and is eligible exactly at the boundary", () => {
    const score = computeConfidence(ideal).score;
    const atBoundary = computeConfidence(ideal, { threshold: score });
    expect(atBoundary.autopilotEligible).toBe(true);

    const justAbove = computeConfidence(ideal, { threshold: score + 1e-9 });
    expect(justAbove.autopilotEligible).toBe(false);
  });

  it("defaults autopilot to enabled when no options are passed", () => {
    expect(computeConfidence(ideal).autopilotEligible).toBe(true);
  });
});

describe("computeConfidence — purity & robustness", () => {
  it("is deterministic: identical inputs give identical output", () => {
    expect(computeConfidence(ideal)).toEqual(computeConfidence(ideal));
  });

  it("does not mutate its input signals", () => {
    const frozen = Object.freeze({
      ...ideal,
      identification: Object.freeze({ ...fullId }),
    });
    expect(() => computeConfidence(frozen)).not.toThrow();
  });
});

describe("parseSignals — input validation", () => {
  it("accepts a well-formed signal object", () => {
    expect(() => parseSignals(ideal)).not.toThrow();
  });

  it("rejects an out-of-range comp agreement", () => {
    expect(() => parseSignals({ ...ideal, compAgreement: 1.5 })).toThrow();
  });

  it("rejects an unknown tier", () => {
    expect(() => parseSignals({ ...ideal, tier: "auction" })).toThrow();
  });
});

describe("computeConfidence — threshold validation (autopilot safety gate)", () => {
  it("throws on a negative threshold (would make everything eligible)", () => {
    expect(() => computeConfidence(ideal, { threshold: -0.1 })).toThrow();
  });

  it("throws on a threshold above 1 (would silently disable the gate)", () => {
    expect(() => computeConfidence(ideal, { threshold: 1.5 })).toThrow();
  });

  it("throws on a non-finite threshold (NaN)", () => {
    expect(() => computeConfidence(ideal, { threshold: NaN })).toThrow();
  });

  it("accepts the boundary thresholds 0 and 1", () => {
    expect(() => computeConfidence(ideal, { threshold: 0 })).not.toThrow();
    expect(() => computeConfidence(ideal, { threshold: 1 })).not.toThrow();
  });
});
