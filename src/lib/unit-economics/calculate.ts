import type { ParsedUnitEconomicsModel } from "./schema";

const round = (value: number, places = 6): number => {
  const scale = 10 ** places;
  return Math.round((value + Number.EPSILON) * scale) / scale;
};

function tokenStageCost(
  stage: ParsedUnitEconomicsModel["scenarios"][number]["stages"][keyof ParsedUnitEconomicsModel["scenarios"][number]["stages"]],
  rates: ParsedUnitEconomicsModel["providerRates"],
): number {
  if (stage.model === "gemini-2.5-flash") {
    return (
      stage.calls *
      ((stage.inputTokensPerCall * rates.gemini25Flash.inputPerMillionUsd) /
        1_000_000 +
        (stage.outputTokensPerCall * rates.gemini25Flash.outputPerMillionUsd) /
          1_000_000)
    );
  }

  const uncachedInput = stage.inputTokensPerCall * (1 - stage.cachedInputRate);
  const cachedInput = stage.inputTokensPerCall * stage.cachedInputRate;
  return (
    stage.calls *
    ((uncachedInput * rates.openaiGpt55.inputPerMillionUsd) / 1_000_000 +
      (cachedInput * rates.openaiGpt55.cachedInputPerMillionUsd) / 1_000_000 +
      (stage.outputTokensPerCall * rates.openaiGpt55.outputPerMillionUsd) /
        1_000_000)
  );
}

export interface ScenarioCostResult {
  scenarioId: "median" | "p90" | "stress";
  componentCostUsd: {
    vision: number;
    garmentMeasurement: number;
    pricingAgent: number;
    listing: number;
    embedding: number;
    webSearch: number;
    soldComps: number;
    infrastructure: number;
  };
  initialAttemptCostUsd: number;
  correctionCostUsd: number;
  restoredFailureBurdenUsd: number;
  directSuccessfulListingCogsUsd: number;
  freeActivationCostPerPaidSubscriberUsd: number;
}

export function calculateScenarioCosts(
  model: ParsedUnitEconomicsModel,
): ScenarioCostResult[] {
  return model.scenarios.map((scenario) => {
    const vision = tokenStageCost(scenario.stages.vision, model.providerRates);
    const garmentMeasurement =
      tokenStageCost(scenario.stages.garmentMeasurement, model.providerRates) *
      scenario.garmentShare;
    const pricingAgent = tokenStageCost(
      scenario.stages.pricingAgent,
      model.providerRates,
    );
    const listing = tokenStageCost(scenario.stages.listing, model.providerRates);
    const embedding =
      (scenario.embeddingTokens *
        model.providerRates.openaiEmbedding3Small.inputPerMillionUsd) /
      1_000_000;
    const webSearch =
      scenario.webSearchRequests * model.providerRates.tavilyPerCreditUsd;
    const soldComps =
      scenario.soldComp.attemptRate *
      (1 - scenario.soldComp.cacheHitRate) *
      scenario.soldComp.historicalCostPerQueryUsd;
    const infrastructure = scenario.infrastructurePerAttemptUsd;

    const initialAttemptCost =
      vision +
      garmentMeasurement +
      pricingAgent +
      listing +
      embedding +
      webSearch +
      soldComps +
      infrastructure;

    // The one included identity correction reruns pricing + grounded listing,
    // but not immutable-photo extraction. It consumes no second ledger credit.
    const correctionAttemptCost = pricingAgent + listing + webSearch + soldComps;
    const correctionCost = scenario.correctionRate * correctionAttemptCost;

    // Reservations restore on pre-value failure, but provider/compute spend is
    // still sunk. Geometric expected failures per durable success = f / (1-f).
    const restoredFailureBurden =
      (scenario.failedRunRate / (1 - scenario.failedRunRate)) *
      initialAttemptCost *
      scenario.failedAttemptCostShare;
    const directSuccessfulListingCogs =
      initialAttemptCost + correctionCost + restoredFailureBurden;

    return {
      scenarioId: scenario.id,
      componentCostUsd: {
        vision: round(vision),
        garmentMeasurement: round(garmentMeasurement),
        pricingAgent: round(pricingAgent),
        listing: round(listing),
        embedding: round(embedding),
        webSearch: round(webSearch),
        soldComps: round(soldComps),
        infrastructure: round(infrastructure),
      },
      initialAttemptCostUsd: round(initialAttemptCost),
      correctionCostUsd: round(correctionCost),
      restoredFailureBurdenUsd: round(restoredFailureBurden),
      directSuccessfulListingCogsUsd: round(directSuccessfulListingCogs),
      freeActivationCostPerPaidSubscriberUsd: round(
        scenario.freeActivationsPerPaidSubscriber * directSuccessfulListingCogs,
      ),
    };
  });
}

export function calculateUnitEconomics(model: ParsedUnitEconomicsModel) {
  const scenarioCosts = calculateScenarioCosts(model);
  const candidateRow = (
    candidate: ParsedUnitEconomicsModel["candidates"][number],
    usage: ParsedUnitEconomicsModel["usageCases"][number],
    scenario: ParsedUnitEconomicsModel["scenarios"][number],
    cost: ScenarioCostResult,
  ) => {
    const usedListings = Math.max(
      1,
      candidate.monthlyAllowance * usage.allowanceUtilizationRate,
    );
    const variableCogs =
      usedListings * cost.directSuccessfulListingCogsUsd +
      cost.freeActivationCostPerPaidSubscriberUsd;
    const directUsageCogs =
      usedListings * cost.directSuccessfulListingCogsUsd;
    const monthlyGrossAfterRefund =
      candidate.monthlyPriceUsd * (1 - scenario.refundRate);
    const monthlyNetRevenue =
      monthlyGrossAfterRefund *
      (1 -
        scenario.appleCommissionRate -
        scenario.indirectTaxWithheldRate -
        scenario.revenueCatMarginalRate);
    const annualRecognizedGrossAfterRefund =
      (candidate.annualPriceUsd / 12) * (1 - scenario.refundRate);
    const annualRecognizedNetRevenue =
      annualRecognizedGrossAfterRefund *
      (1 -
        scenario.appleCommissionRate -
        scenario.indirectTaxWithheldRate -
        scenario.revenueCatMarginalRate);
    const monthlyContribution = monthlyNetRevenue - variableCogs;
    const annualContribution = annualRecognizedNetRevenue - variableCogs;
    const monthlyFixedCost = scenario.fixedCosts.reduce(
      (total, entry) => total + entry.monthlyUsd,
      0,
    );

    return {
      candidateId: candidate.id,
      usageCase: usage.id,
      scenarioId: scenario.id,
      usedListings: round(usedListings, 2),
      monthly: {
        netRevenueUsd: round(monthlyNetRevenue),
        directUsageCogsUsd: round(directUsageCogs),
        freeActivationSubsidyUsd: round(
          cost.freeActivationCostPerPaidSubscriberUsd,
        ),
        variableCogsUsd: round(variableCogs),
        grossMarginRate: round(
          (monthlyNetRevenue - directUsageCogs) / monthlyNetRevenue,
        ),
        contributionUsd: round(monthlyContribution),
        contributionMarginRate: round(monthlyContribution / monthlyNetRevenue),
        subscribersToCoverFixedCosts:
          monthlyContribution > 0
            ? Math.ceil(monthlyFixedCost / monthlyContribution)
            : null,
      },
      annual: {
        recognizedNetRevenuePerMonthUsd: round(annualRecognizedNetRevenue),
        directUsageCogsUsd: round(directUsageCogs),
        freeActivationSubsidyUsd: round(
          cost.freeActivationCostPerPaidSubscriberUsd,
        ),
        variableCogsUsd: round(variableCogs),
        grossMarginRate: round(
          (annualRecognizedNetRevenue - directUsageCogs) /
            annualRecognizedNetRevenue,
        ),
        contributionPerRecognizedMonthUsd: round(annualContribution),
        contributionMarginRate: round(
          annualContribution / annualRecognizedNetRevenue,
        ),
        subscribersToCoverFixedCosts:
          annualContribution > 0
            ? Math.ceil(monthlyFixedCost / annualContribution)
            : null,
      },
    };
  };

  const matrix = model.candidates.flatMap((candidate) =>
    model.usageCases.flatMap((usage) =>
      model.scenarios.map((scenario) => {
        const cost = scenarioCosts.find(
          (entry) => entry.scenarioId === scenario.id,
        )!;
        return candidateRow(candidate, usage, scenario, cost);
      }),
    ),
  );

  const recommendedCandidate = model.candidates.find(
    (candidate) => candidate.id === model.recommendation.candidateId,
  )!;
  const expectedUsage = model.usageCases.find((usage) => usage.id === "expected")!;
  const medianScenario = model.scenarios.find((scenario) => scenario.id === "median")!;
  const medianCost = scenarioCosts.find((cost) => cost.scenarioId === "median")!;
  const baseline = candidateRow(
    recommendedCandidate,
    expectedUsage,
    medianScenario,
    medianCost,
  );
  const sensitivityChanges = [
    {
      id: "cache-hit-rate-to-zero",
      mutate: (scenario: typeof medianScenario) => {
        scenario.soldComp.cacheHitRate = 0;
      },
    },
    {
      id: "failed-run-rate-to-15pct",
      mutate: (scenario: typeof medianScenario) => {
        scenario.failedRunRate = 0.15;
      },
    },
    {
      id: "correction-rate-to-50pct",
      mutate: (scenario: typeof medianScenario) => {
        scenario.correctionRate = 0.5;
      },
    },
    {
      id: "free-activations-per-paid-to-two",
      mutate: (scenario: typeof medianScenario) => {
        scenario.freeActivationsPerPaidSubscriber = 2;
      },
    },
    {
      id: "refund-rate-to-10pct",
      mutate: (scenario: typeof medianScenario) => {
        scenario.refundRate = 0.1;
      },
    },
  ].map(({ id, mutate }) => {
    const changedScenario = structuredClone(medianScenario);
    mutate(changedScenario);
    const changedModel = structuredClone(model);
    changedModel.scenarios = model.scenarios.map((scenario) =>
      scenario.id === "median" ? changedScenario : scenario,
    );
    const changedCost = calculateScenarioCosts(changedModel).find(
      (cost) => cost.scenarioId === "median",
    )!;
    const changed = candidateRow(
      recommendedCandidate,
      expectedUsage,
      changedScenario,
      changedCost,
    );
    return {
      id,
      monthlyVariableCogsUsd: changed.monthly.variableCogsUsd,
      monthlyContributionMarginRate: changed.monthly.contributionMarginRate,
      variableCogsDeltaUsd: round(
        changed.monthly.variableCogsUsd - baseline.monthly.variableCogsUsd,
      ),
      contributionMarginDeltaRate: round(
        changed.monthly.contributionMarginRate -
          baseline.monthly.contributionMarginRate,
      ),
    };
  });

  const expectedMedian = matrix.find(
    (row) =>
      row.candidateId === recommendedCandidate.id &&
      row.usageCase === "expected" &&
      row.scenarioId === "median",
  )!;
  const highP90 = matrix.find(
    (row) =>
      row.candidateId === recommendedCandidate.id &&
      row.usageCase === "high" &&
      row.scenarioId === "p90",
  )!;
  const highStress = matrix.find(
    (row) =>
      row.candidateId === recommendedCandidate.id &&
      row.usageCase === "high" &&
      row.scenarioId === "stress",
  )!;

  const measuredApifyQueryCost =
    model.scenarios[0].soldComp.historicalCostPerQueryUsd;
  const measuredMatcherUsableCost = measuredApifyQueryCost / 0.4;
  return {
    schemaVersion: 1,
    modelId: model.modelId,
    generatedAt: model.asOf,
    status: model.status,
    scenarioCosts,
    candidateMatrix: matrix,
    sensitivity: {
      baseline: {
        candidateId: recommendedCandidate.id,
        usageCase: expectedUsage.id,
        scenarioId: medianScenario.id,
        monthlyVariableCogsUsd: baseline.monthly.variableCogsUsd,
        monthlyContributionMarginRate:
          baseline.monthly.contributionMarginRate,
      },
      changes: sensitivityChanges,
    },
    currentGateEvaluation: {
      status: "not-ready-testflight-evidence-missing",
      expectedMedianMonthlyMarginPasses:
        expectedMedian.monthly.contributionMarginRate >=
        model.testflightGate.minimumExpectedContributionMarginRate,
      p90HighUseMonthlyMarginPasses:
        highP90.monthly.contributionMarginRate >=
        model.testflightGate.minimumP90HighUseContributionMarginRate,
      p90HighUseAnnualMarginPasses:
        highP90.annual.contributionMarginRate >=
        model.testflightGate.minimumP90HighUseContributionMarginRate,
      stressMonthlyNonNegative: highStress.monthly.contributionUsd >= 0,
      stressAnnualNonNegative:
        highStress.annual.contributionPerRecognizedMonthUsd >= 0,
    },
    planBreakpoints: {
      scrapingBeeVsMeasuredApifyQueries: Math.ceil(
        model.planBreakpoints.scrapingBeeMonthlyUsd / measuredApifyQueryCost,
      ),
      scrapingBeeVsMatcherUsableListings: Math.ceil(
        model.planBreakpoints.scrapingBeeMonthlyUsd / measuredMatcherUsableCost,
      ),
      revenueCatFreeMtrUsd: model.planBreakpoints.revenueCatFreeMtrUsd,
      posthogFreeListingsAtAssumedEventVolume: Math.floor(
        model.planBreakpoints.posthogFreeEvents /
          model.planBreakpoints.assumedPosthogEventsPerListing,
      ),
      supabaseProMonthlyUsd: model.planBreakpoints.supabaseProMonthlyUsd,
    },
  };
}

export type UnitEconomicsResults = ReturnType<typeof calculateUnitEconomics>;
