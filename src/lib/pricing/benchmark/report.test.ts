import { describe, expect, it } from "vitest";
import { formatBenchmarkReport } from "./report";
import type { RedactedBenchmarkArtifact } from "./types";

const artifact: RedactedBenchmarkArtifact = {
  schemaVersion: 1,
  runId: "partial-live",
  mode: "live",
  createdAt: "2026-07-16T00:00:00.000Z",
  corpusDigest: "sha256:test",
  queryCount: 40,
  maxResultsPerQuery: 25,
  apifyHardCeilingUsd: 5,
  candidate: {
    actorId: "oTtB3VgfuE9GtxQt2",
    actorBuildId: "build-1-18-3",
    actorBuildNumber: "1.18.3",
    actorBuildFinishedAt: "2026-07-07T13:31:08.410Z",
    metadataObservedAt: "2026-07-16T00:00:00.000Z",
  },
  providers: [
    {
      provider: "scrapingbee-public-page",
      queryCount: 40,
      successfulQueryCoverage: 0.8,
      emptyResultRate: 0.15,
      blockErrorRate: 0.05,
      relevantPrecision: null,
      variantContaminationRate: null,
      conditionContaminationRate: null,
      labeledCompCount: 0,
      usableCompCount: 100,
      usablePricingQueryCount: 30,
      medianUsableCompsPerSuccessfulQuery: 4,
      medianSplitStabilityDelta: 0.1,
      medianRangeWidthRatio: 0.4,
      latencyMs: { p50: 1200, p95: 4500 },
      retries: 0,
      bestOfferRowsObserved: 0,
      creditsSpent: 400,
      actualUsdSpent: 0,
      costPerQueryUsd: 0,
      costPerUsablePricingResultUsd: 0,
    },
  ],
  perQuery: [],
  crossProvider: {
    comparableQueryCount: 0,
    medianAbsoluteMedianDeltaRate: null,
    medianRangeOverlapRate: null,
  },
  maintainability: {
    "scrapingbee-public-page": {
      schemaBurden: "parser",
      blockRetryBehavior: "declines",
      lockInRisk: "low",
    },
    "caffein-apify": {
      schemaBurden: "schema",
      blockRetryBehavior: "opaque",
      lockInRisk: "moderate",
    },
  },
  costAccounting: {
    scrapingBee: {
      accountDeltaCredits: 400,
      responseHeaderCredits: 400,
      unattributedCredits: 0,
    },
  },
  productResearch: { status: "operator-pending", queryIds: ["Q01"] },
  recommendation: {
    status: "operator-pending",
    reason: "candidate access missing",
    monthlyCrossoverQueries: null,
  },
  redaction: {
    rawResponsesPersisted: false,
    sellerFieldsPersisted: false,
    sourceUrlsPersisted: false,
    reviewTitlesPersisted: false,
  },
};

describe("concise benchmark report", () => {
  it("distinguishes the implemented harness from an incomplete live comparison", () => {
    const report = formatBenchmarkReport(artifact, {
      apifyPricing: {
        observedAt: "2026-07-16T00:00:00.000Z",
        actorId: "oTtB3VgfuE9GtxQt2",
        actorBuildId: "build-1-18-3",
        actorBuildNumber: "1.18.3",
        actorBuildFinishedAt: "2026-07-07T13:31:08.410Z",
        pricingStartedAt: "2026-07-14T00:00:00.000Z",
        resultPriceUpperBoundUsd: 0.004,
        actorStartPriceUsd: 0.00005,
        actorStartUnitsPerRun: 4,
        source: "live-public-actor-metadata",
      },
      liveLimitations: ["APIFY_TOKEN absent"],
    });

    expect(report).toContain("Harness status: complete");
    expect(report).toContain("1.18.3");
    expect(report).toContain("Live benchmark status: incomplete");
    expect(report).toContain("operator-pending");
    expect(report).toContain("Best Offer");
    expect(report).toContain("asking price");
    expect(report).toContain("Product Research");
    expect(report).toContain("~490 queries/month");
    expect(report).toContain("cache");
    expect(report).toContain("kill switch");
    expect(report).toContain("APIFY_TOKEN absent");
  });
});
