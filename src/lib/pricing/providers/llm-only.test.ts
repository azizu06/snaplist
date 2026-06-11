import { describe, it, expect, vi } from "vitest";
import {
  LLM_ONLY_CONFIDENCE,
  createLlmOnlyPricingProvider,
  llmPriceEstimateSchema,
  type EstimatePrice,
  type LlmPriceEstimate,
} from "./llm-only";
import { priceResultSchema, type ItemSignal } from "../types";
import { computeConfidence } from "../../confidence/confidence";

/**
 * Tier 5 — the LLM-only provider (issue #11). Every test runs fully OFFLINE:
 * the estimator (the LLM call) is an injected fake.
 *
 * Acceptance criteria covered:
 *  - the floor NEVER declines: any signal (even empty) → schema-valid estimate;
 *  - a failing/invalid model call THROWS (upstream failure), never declines;
 *  - the result is honest: empty sources, floor confidence, model provenance
 *    only when the estimating model is actually known;
 *  - the llm_only composite can NEVER reach the 0.75 autopilot gate.
 */

const ESTIMATE: LlmPriceEstimate = { suggested: 25, min: 10, max: 45 };

function fakeEstimator(estimate: LlmPriceEstimate = ESTIMATE) {
  return vi.fn(async (args: { signal: ItemSignal }) => {
    void args;
    return estimate;
  });
}

describe("llm-only pricing (the routing floor)", () => {
  it("never declines: an EMPTY signal still yields a schema-valid estimate", async () => {
    const provider = createLlmOnlyPricingProvider({ estimatePrice: fakeEstimator() });
    const result = await provider.price({});

    expect(result).not.toBeNull();
    expect(priceResultSchema.safeParse(result).success).toBe(true);
    expect(result!.tier).toBe("llm-only");
    expect(result!.suggested).toBe(25);
    expect(result!.range).toEqual({ min: 10, max: 45 });
  });

  it("defines no canHandle — the floor must never pre-decline either", () => {
    const provider = createLlmOnlyPricingProvider({ estimatePrice: fakeEstimator() });
    expect(provider.canHandle).toBeUndefined();
  });

  it("passes the full signal to the estimator", async () => {
    const estimate = fakeEstimator();
    const signal: ItemSignal = { brand: "Acme", category: "kitchen", condition: "fair" };
    await createLlmOnlyPricingProvider({ estimatePrice: estimate }).price(signal);
    expect(estimate).toHaveBeenCalledOnce();
    expect(estimate).toHaveBeenCalledWith({ signal });
  });

  it("claims NO checkable evidence: sources are empty and confidence is the floor", async () => {
    const provider = createLlmOnlyPricingProvider({ estimatePrice: fakeEstimator() });
    const result = await provider.price({});
    expect(result!.sources).toEqual([]);
    expect(result!.confidence).toBe(LLM_ONLY_CONFIDENCE);
  });

  it("rounds the estimate to cents (order-preserving)", async () => {
    const provider = createLlmOnlyPricingProvider({
      estimatePrice: fakeEstimator({ suggested: 19.999, min: 9.991, max: 39.998 }),
    });
    const result = await provider.price({});
    expect(result!.suggested).toBe(20);
    expect(result!.range).toEqual({ min: 9.99, max: 40 });
    expect(priceResultSchema.safeParse(result).success).toBe(true);
  });
});

describe("model failure = hard error (never a decline)", () => {
  it("propagates a thrown estimator", async () => {
    const provider = createLlmOnlyPricingProvider({
      estimatePrice: async () => {
        throw new Error("model API down");
      },
    });
    await expect(provider.price({})).rejects.toThrow(/model API down/);
  });

  it.each([
    [{ suggested: 25, min: 30, max: 45 }, "suggested below min"],
    [{ suggested: 50, min: 10, max: 45 }, "suggested above max"],
    [{ suggested: 0, min: 0, max: 0 }, "zero estimate"],
    [{ suggested: -5, min: -10, max: -1 }, "negative estimate"],
    [{ suggested: Infinity, min: 1, max: Infinity }, "non-finite estimate"],
  ] as Array<[LlmPriceEstimate, string]>)(
    "throws on an invalid estimate (%j — %s) instead of repairing or declining",
    async (estimate) => {
      // The provider re-validates even injected estimators: an unusable
      // estimate is an upstream failure, not a number to silently fix.
      const provider = createLlmOnlyPricingProvider({
        estimatePrice: (async () => estimate) as EstimatePrice,
      });
      await expect(provider.price({})).rejects.toThrow(/failed validation/);
    },
  );

  it("the estimate schema itself rejects min > max", () => {
    expect(
      llmPriceEstimateSchema.safeParse({ suggested: 20, min: 30, max: 10 }).success,
    ).toBe(false);
  });
});

describe("provenance honesty", () => {
  it("stamps the declared model for a custom estimator", async () => {
    const provider = createLlmOnlyPricingProvider({
      estimatePrice: fakeEstimator(),
      model: "test-estimator-model",
    });
    const result = await provider.price({});
    expect(result!.model).toBe("test-estimator-model");
  });

  it("claims NO model for a custom estimator without a declared model", async () => {
    const provider = createLlmOnlyPricingProvider({ estimatePrice: fakeEstimator() });
    const result = await provider.price({});
    // An injected estimator may use any model — an undeclared one logs no
    // claim (undefined → pricing_model NULL) rather than a wrong one.
    expect(result!.model).toBeUndefined();
  });
});

describe("autopilot sub-gate by construction", () => {
  it("the llm_only composite maxes out at 0.52 < the 0.75 gate", () => {
    // Even a PERFECTLY identified item cannot clear the gate off an LLM guess:
    // 0.6·0.2 + 0.25·1 + 0.15·1 = 0.52.
    const best = computeConfidence({
      tier: "llm_only",
      compAgreement: 1,
      identification: {
        brandResolved: true,
        modelResolved: true,
        barcodeDecoded: true,
        categoryUnambiguous: true,
      },
    });
    expect(best.score).toBeCloseTo(0.52, 10);
    expect(best.score).toBeLessThan(0.75);
    expect(best.band).not.toBe("high");
    expect(best.autopilotEligible).toBe(false);
  });
});
