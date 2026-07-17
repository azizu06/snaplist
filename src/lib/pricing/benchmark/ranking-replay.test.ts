import { describe, expect, it } from "vitest";
import { formatSoldCompRankingReplay, replaySoldCompRanking } from "./ranking-replay";
import type {
  BenchmarkCapture,
  BenchmarkComp,
  BenchmarkCompLabel,
  ProviderQueryCapture,
  ProductResearchStatus,
} from "./types";

const comp = (
  id: string,
  title: string,
  condition: string,
  price: number,
): BenchmarkComp => ({
  id,
  title,
  condition,
  price,
  currency: "USD",
  endedAt: null,
  usableForPricing: true,
  isBestOfferAccepted: false,
  priceDisclosure: "displayed-sold-price",
});

describe("replaySoldCompRanking", () => {
  it("reports retrieval separately from matcher ranking without exposing rows", () => {
    const comps = [
      comp("same", "Apple iPhone 14 Pro 256GB", "Like New", 700),
      comp("adjacent", "Apple iPhone 14 Pro 256 GB", "Open Box", 740),
      comp("distant", "Apple iPhone 14 Pro 256GB", "Acceptable", 560),
      comp("wrong", "Apple iPhone 14 Pro Max 256GB", "Like New", 920),
    ];
    const query: ProviderQueryCapture = {
      provider: "caffein-apify",
      queryId: "Q05",
      status: "success",
      latencyMs: 10,
      attempts: 1,
      retries: 0,
      creditsSpent: null,
      actualUsdSpent: 0.01,
      bestOfferPolicy: "labeled-and-excluded",
      comps,
    };
    const capture: BenchmarkCapture = {
      schemaVersion: 1,
      runId: "offline-test",
      mode: "live",
      createdAt: "2026-07-16T00:00:00.000Z",
      corpusDigest: "test",
      maxResultsPerQuery: 25,
      apifyHardCeilingUsd: 5,
      queries: [query],
      apifyPricingSnapshot: null,
      productResearch: { status: "operator-pending", queryIds: [] },
    };
    const labels: BenchmarkCompLabel[] = [
      { compId: "same", relevant: true, variantCorrect: true, conditionCorrect: true },
      { compId: "adjacent", relevant: true, variantCorrect: true, conditionCorrect: true },
      { compId: "distant", relevant: true, variantCorrect: true, conditionCorrect: false },
      { compId: "wrong", relevant: false, variantCorrect: false, conditionCorrect: true },
    ];

    const summary = replaySoldCompRanking(capture, labels);

    expect(summary.retrieval).toEqual({
      queryCount: 1,
      labeledRows: 4,
      relevantPrecision: 0.75,
    });
    expect(summary.ranking).toMatchObject({
      anchorRows: 2,
      corroborationRows: 1,
      rejectedRows: 1,
      anchorPrecision: 0.5,
      validAnchorRecall: 0.5,
      pricingQueryCoverage: 1,
      usablePricingQueries: 1,
    });
    expect(JSON.stringify(summary)).not.toContain("iPhone");
    expect(formatSoldCompRankingReplay(summary)).toContain("50.00%");
    expect(formatSoldCompRankingReplay(summary)).not.toContain("iPhone");
  });

  it("compares matcher-selected suggestions with aggregate Product Research without row leakage", () => {
    const comps = [
      comp("same", "Apple iPhone 14 Pro 256GB", "Like New", 700),
      comp("fair", "Apple iPhone 14 Pro 256GB", "Acceptable", 560),
      comp("wrong", "Apple iPhone 14 Pro Max 256GB", "Like New", 920),
    ];
    const capture: BenchmarkCapture = {
      schemaVersion: 1,
      runId: "reference-test",
      mode: "live",
      createdAt: "2026-07-16T00:00:00.000Z",
      corpusDigest: "test",
      maxResultsPerQuery: 25,
      apifyHardCeilingUsd: 5,
      queries: [{
        provider: "caffein-apify",
        queryId: "Q05",
        status: "success",
        latencyMs: 10,
        attempts: 1,
        retries: 0,
        creditsSpent: null,
        actualUsdSpent: 0.01,
        bestOfferPolicy: "labeled-and-excluded",
        comps,
      }],
      apifyPricingSnapshot: null,
      productResearch: { status: "operator-pending", queryIds: [] },
    };
    const labels: BenchmarkCompLabel[] = comps.map(({ id }) => ({
      compId: id,
      relevant: true,
      variantCorrect: true,
      conditionCorrect: true,
    }));
    const reference: ProductResearchStatus = {
      status: "complete",
      queryIds: ["Q05"],
      reviewMethod: "codex-assisted-operator",
      rows: [{
        queryId: "Q05",
        condition: "Used",
        average: 630,
        range: { min: 500, max: 750 },
        sellThroughPct: 50,
        totalSellers: 10,
        capturedAt: "2026-07-16T00:00:00.000Z",
      }],
    };

    const summary = replaySoldCompRanking(capture, labels, reference);

    expect(summary.productResearchReference).toMatchObject({
      status: "complete",
      referenceQueryCount: 1,
      comparableQueryCount: 1,
    });
    expect(summary.productResearchReference.medianAbsoluteSuggestedErrorRate).not.toBeNull();
    expect(summary.productResearchReference.medianRangeOverlapRate).not.toBeNull();
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("iPhone");
    expect(serialized).not.toContain("totalSellers");
    expect(formatSoldCompRankingReplay(summary)).toContain("Product Research reference");
  });

  it("never lets matching non-USD anchors make a query usable for pricing", () => {
    const eurComps = [
      {
        ...comp("eur-1", "Apple iPhone 14 Pro 256GB", "Like New", 700),
        currency: "EUR",
      },
      {
        ...comp("eur-2", "Apple iPhone 14 Pro 256 GB", "Like New", 720),
        currency: "EUR",
      },
    ];
    const query: ProviderQueryCapture = {
      provider: "caffein-apify",
      queryId: "Q05",
      status: "success",
      latencyMs: 10,
      attempts: 1,
      retries: 0,
      creditsSpent: null,
      actualUsdSpent: 0.01,
      bestOfferPolicy: "labeled-and-excluded",
      comps: eurComps,
    };
    const capture: BenchmarkCapture = {
      schemaVersion: 1,
      runId: "non-usd-test",
      mode: "live",
      createdAt: "2026-07-16T00:00:00.000Z",
      corpusDigest: "test",
      maxResultsPerQuery: 25,
      apifyHardCeilingUsd: 5,
      queries: [query],
      apifyPricingSnapshot: null,
      productResearch: { status: "operator-pending", queryIds: [] },
    };
    const labels: BenchmarkCompLabel[] = eurComps.map(({ id }) => ({
      compId: id,
      relevant: true,
      variantCorrect: true,
      conditionCorrect: true,
    }));

    const summary = replaySoldCompRanking(capture, labels);

    expect(summary.ranking.anchorRows).toBe(2);
    expect(summary.ranking.validAnchorRows).toBe(0);
    expect(summary.ranking.validComparableRows).toBe(0);
    expect(summary.ranking.anchorPrecision).toBe(0);
    expect(summary.ranking.validAnchorRecall).toBeNull();
    expect(summary.ranking.usablePricingQueries).toBe(0);
    expect(summary.ranking.pricingQueryCoverage).toBe(0);
  });
});
