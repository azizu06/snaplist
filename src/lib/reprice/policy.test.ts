import { describe, expect, it } from "vitest";
import {
  decideReprice,
  driftPct,
  isStale,
  resolveRepriceConfig,
  REPRICE_DEFAULTS,
  type RepriceDecisionInput,
} from "./policy";

/**
 * Crafted-signal unit tests for the pure repricing decisions (issue #102),
 * mirroring the confidence-function pattern: every guardrail — stale?
 * drifted? eligible? floor? — asserted directly, offline.
 */

const NOW = new Date("2026-07-02T12:00:00Z");

describe("isStale", () => {
  it("is stale when the last price event is older than the window", () => {
    expect(isStale("2026-06-01T00:00:00Z", NOW, 14)).toBe(true);
  });

  it("is fresh when the last price event is inside the window", () => {
    expect(isStale("2026-06-25T00:00:00Z", NOW, 14)).toBe(false);
  });

  it("is stale exactly at the window boundary", () => {
    expect(isStale("2026-06-18T12:00:00Z", NOW, 14)).toBe(true);
  });

  it("treats a missing or unparseable timestamp as stale (never priced)", () => {
    expect(isStale(null, NOW, 14)).toBe(true);
    expect(isStale(undefined, NOW, 14)).toBe(true);
    expect(isStale("not-a-date", NOW, 14)).toBe(true);
  });

  it("respects a configured (non-default) window", () => {
    expect(isStale("2026-06-25T00:00:00Z", NOW, 3)).toBe(true);
    expect(isStale("2026-07-01T00:00:00Z", NOW, 3)).toBe(false);
  });
});

describe("driftPct", () => {
  it("is signed: downward drift is negative, upward positive", () => {
    expect(driftPct(100, 80)).toBeCloseTo(-20);
    expect(driftPct(100, 125)).toBeCloseTo(25);
  });
});

function base(over: Partial<RepriceDecisionInput> = {}): RepriceDecisionInput {
  return {
    currentPrice: 100,
    suggestedPrice: 80,
    priceFloor: null,
    autopilotEligible: false,
    autoRepriceEnabled: false,
    driftThresholdPct: 10,
    ...over,
  };
}

describe("decideReprice — drifted?", () => {
  it("does nothing when drift is below the threshold", () => {
    const d = decideReprice(base({ suggestedPrice: 95 }));
    expect(d).toMatchObject({ action: "none", reason: "drift-immaterial" });
  });

  it("suggests on material downward drift", () => {
    const d = decideReprice(base({ suggestedPrice: 80 }));
    expect(d).toMatchObject({ action: "suggest", targetPrice: 80 });
    if (d.action !== "none") expect(d.driftPct).toBeCloseTo(-20);
  });

  it("suggests on material upward drift too (repricing goes both ways)", () => {
    const d = decideReprice(base({ suggestedPrice: 130 }));
    expect(d).toMatchObject({ action: "suggest", targetPrice: 130 });
    if (d.action !== "none") expect(d.driftPct).toBeCloseTo(30);
  });

  it("drift exactly at the threshold is material", () => {
    const d = decideReprice(base({ suggestedPrice: 90 }));
    expect(d.action).toBe("suggest");
  });

  it("does nothing without a usable current price", () => {
    for (const currentPrice of [null, undefined, 0, -5, NaN]) {
      const d = decideReprice(base({ currentPrice }));
      expect(d).toMatchObject({ action: "none", reason: "no-current-price" });
    }
  });

  it("does nothing on a non-positive or non-finite suggestion", () => {
    for (const suggestedPrice of [0, -10, NaN, Infinity]) {
      const d = decideReprice(base({ suggestedPrice }));
      expect(d).toMatchObject({ action: "none", reason: "invalid-suggestion" });
    }
  });
});

describe("decideReprice — eligible? (auto-apply gate)", () => {
  it("auto-applies ONLY when confidence-gate eligible AND the toggle is on", () => {
    expect(
      decideReprice(base({ autopilotEligible: true, autoRepriceEnabled: true }))
        .action,
    ).toBe("auto_apply");
    // toggle off (the DEFAULT) → suggest-only, however confident the run is
    expect(
      decideReprice(base({ autopilotEligible: true, autoRepriceEnabled: false }))
        .action,
    ).toBe("suggest");
    // toggle on but the run is below the composite confidence gate → suggest
    expect(
      decideReprice(base({ autopilotEligible: false, autoRepriceEnabled: true }))
        .action,
    ).toBe("suggest");
  });

  it("auto-apply carries the target price and drift as evidence", () => {
    const d = decideReprice(
      base({ autopilotEligible: true, autoRepriceEnabled: true, suggestedPrice: 79.999 }),
    );
    expect(d).toMatchObject({
      action: "auto_apply",
      targetPrice: 80, // rounded to cents
      flooredToMinimum: false,
    });
  });
});

describe("decideReprice — floor?", () => {
  it("clamps the target up to the seller's floor", () => {
    const d = decideReprice(
      base({
        suggestedPrice: 60,
        priceFloor: 75,
        autopilotEligible: true,
        autoRepriceEnabled: true,
      }),
    );
    // floor raised the target against a DOWNWARD market move → the seller
    // decides; never silently auto-apply while the market sits below the floor.
    expect(d).toMatchObject({
      action: "suggest",
      targetPrice: 75,
      flooredToMinimum: true,
    });
  });

  it("never auto-applies a floor clamp that lands back on the current price", () => {
    const d = decideReprice(
      base({
        suggestedPrice: 60,
        priceFloor: 100, // == current
        autopilotEligible: true,
        autoRepriceEnabled: true,
      }),
    );
    expect(d).toMatchObject({
      action: "suggest",
      targetPrice: 100,
      flooredToMinimum: true,
    });
  });

  it("a floor below the suggestion changes nothing", () => {
    const d = decideReprice(
      base({
        suggestedPrice: 80,
        priceFloor: 50,
        autopilotEligible: true,
        autoRepriceEnabled: true,
      }),
    );
    expect(d).toMatchObject({
      action: "auto_apply",
      targetPrice: 80,
      flooredToMinimum: false,
    });
  });

  it("ignores junk floors (zero / negative / NaN)", () => {
    for (const priceFloor of [0, -10, NaN]) {
      const d = decideReprice(
        base({
          suggestedPrice: 80,
          priceFloor,
          autopilotEligible: true,
          autoRepriceEnabled: true,
        }),
      );
      expect(d).toMatchObject({ action: "auto_apply", targetPrice: 80 });
    }
  });

  it("an upward reprice is unaffected by the floor", () => {
    const d = decideReprice(
      base({
        suggestedPrice: 130,
        priceFloor: 75,
        autopilotEligible: true,
        autoRepriceEnabled: true,
      }),
    );
    expect(d).toMatchObject({
      action: "auto_apply",
      targetPrice: 130,
      flooredToMinimum: false,
    });
  });
});

describe("resolveRepriceConfig", () => {
  it("defaults when unset", () => {
    expect(resolveRepriceConfig({})).toEqual(REPRICE_DEFAULTS);
  });

  it("reads the env overrides", () => {
    expect(
      resolveRepriceConfig({
        REPRICE_STALE_DAYS: "7",
        REPRICE_BATCH_SIZE: "3",
        REPRICE_DRIFT_THRESHOLD_PCT: "15",
      }),
    ).toEqual({ staleDays: 7, batchSize: 3, driftThresholdPct: 15 });
  });

  it("falls back to defaults on junk (never a zero threshold or batch)", () => {
    expect(
      resolveRepriceConfig({
        REPRICE_STALE_DAYS: "soon",
        REPRICE_BATCH_SIZE: "-2",
        REPRICE_DRIFT_THRESHOLD_PCT: "0",
      }),
    ).toEqual(REPRICE_DEFAULTS);
  });
});
