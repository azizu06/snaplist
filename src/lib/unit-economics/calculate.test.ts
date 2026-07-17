import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { calculateScenarioCosts, calculateUnitEconomics } from "./calculate";
import { unitEconomicsModelSchema } from "./schema";

const modelPath = fileURLToPath(
  new URL("../../../docs/unit-economics/snaplist-pro-model.json", import.meta.url),
);

function loadModel() {
  return unitEconomicsModelSchema.parse(
    JSON.parse(readFileSync(modelPath, "utf8")),
  );
}

describe("SnapList Pro unit-economics model", () => {
  it("validates the machine-readable contract and source references", () => {
    const model = loadModel();
    const sourceIds = new Set(model.sources.map((source) => source.id));

    expect(model.status).toBe("provisional-testflight-required");
    expect(model.boundaries).toMatchObject({
      firstSuccessfulListingFree: true,
      includedGuidedCorrection: 1,
      annualAllowanceReset: "monthly",
      rollover: false,
      unlimited: false,
      productionCommitment: false,
    });
    expect(model.costInventory.length).toBeGreaterThanOrEqual(12);
    for (const entry of model.costInventory) {
      for (const sourceId of entry.sourceIds) {
        expect(sourceIds.has(sourceId), `${entry.service}: ${sourceId}`).toBe(true);
      }
    }
  });

  it("preserves measured #188 cost and separates cache, correction, and restored-failure burdens", () => {
    const model = loadModel();
    const costs = calculateScenarioCosts(model);

    expect(model.scenarios[0].soldComp.historicalCostPerQueryUsd).toBe(0.091435);
    expect(costs.map((cost) => cost.scenarioId)).toEqual([
      "median",
      "p90",
      "stress",
    ]);
    for (const cost of costs) {
      expect(cost.initialAttemptCostUsd).toBeGreaterThan(0);
      expect(cost.correctionCostUsd).toBeGreaterThan(0);
      expect(cost.restoredFailureBurdenUsd).toBeGreaterThan(0);
      expect(cost.directSuccessfulListingCogsUsd).toBeGreaterThan(
        cost.initialAttemptCostUsd,
      );
    }
    expect(costs[0].directSuccessfulListingCogsUsd).toBeLessThan(
      costs[1].directSuccessfulListingCogsUsd,
    );
    expect(costs[1].directSuccessfulListingCogsUsd).toBeLessThan(
      costs[2].directSuccessfulListingCogsUsd,
    );
  });

  it("models three price/allowance candidates under low, expected, and high use", () => {
    const model = loadModel();
    const result = calculateUnitEconomics(model);

    expect(model.candidates).toHaveLength(3);
    expect(result.candidateMatrix).toHaveLength(27);
    expect(new Set(result.candidateMatrix.map((row) => row.usageCase))).toEqual(
      new Set(["low", "expected", "high"]),
    );
    for (const candidate of model.candidates) {
      expect(candidate.annualDiscountRate).toBeGreaterThan(0);
      expect(candidate.annualReset).toBe("monthly");
      expect(candidate.rollover).toBe(false);
      expect(candidate.unlimited).toBe(false);
    }
  });

  it("makes higher usage and adverse assumptions reduce contribution margin", () => {
    const result = calculateUnitEconomics(loadModel());
    const find = (
      usageCase: "low" | "expected" | "high",
      scenarioId: "median" | "p90" | "stress",
    ) =>
      result.candidateMatrix.find(
        (row) =>
          row.candidateId === "balanced-10" &&
          row.usageCase === usageCase &&
          row.scenarioId === scenarioId,
      )!;

    expect(find("low", "median").monthly.contributionMarginRate).toBeGreaterThan(
      find("expected", "median").monthly.contributionMarginRate,
    );
    expect(
      find("expected", "median").monthly.contributionMarginRate,
    ).toBeGreaterThan(find("high", "median").monthly.contributionMarginRate);
    expect(find("expected", "median").monthly.contributionMarginRate).toBeGreaterThan(
      find("expected", "p90").monthly.contributionMarginRate,
    );
    expect(find("expected", "p90").monthly.contributionMarginRate).toBeGreaterThan(
      find("expected", "stress").monthly.contributionMarginRate,
    );
  });

  it("shows annual cadence as discounted monthly recognition with the same entitlement usage", () => {
    const result = calculateUnitEconomics(loadModel());
    const rows = result.candidateMatrix.filter(
      (row) =>
        row.candidateId === "balanced-10" &&
        row.usageCase === "expected" &&
        row.scenarioId === "median",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].monthly.variableCogsUsd).toBe(
      rows[0].annual.variableCogsUsd,
    );
    expect(rows[0].annual.recognizedNetRevenuePerMonthUsd).toBeLessThan(
      rows[0].monthly.netRevenueUsd,
    );
  });

  it("computes transparent provider-plan breakpoints", () => {
    const result = calculateUnitEconomics(loadModel());

    expect(result.planBreakpoints.scrapingBeeVsMeasuredApifyQueries).toBe(536);
    expect(result.planBreakpoints.scrapingBeeVsMatcherUsableListings).toBe(215);
    expect(result.planBreakpoints.posthogFreeListingsAtAssumedEventVolume).toBe(
      40_000,
    );
  });
});
