import { describe, expect, it } from "vitest";
import { formatSoldCompRankingReplay, replaySoldCompRanking } from "./ranking-replay";
import type {
  BenchmarkCapture,
  BenchmarkComp,
  BenchmarkCompLabel,
  ProviderQueryCapture,
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

  it("never treats a non-USD row as valid pricing evidence", () => {
    const eur = { ...comp("eur", "Apple iPhone 14 Pro 256GB", "Like New", 700), currency: "EUR" };
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
      comps: [eur],
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
    const labels: BenchmarkCompLabel[] = [
      { compId: "eur", relevant: true, variantCorrect: true, conditionCorrect: true },
    ];

    const summary = replaySoldCompRanking(capture, labels);

    expect(summary.ranking.anchorRows).toBe(1);
    expect(summary.ranking.validAnchorRows).toBe(0);
    expect(summary.ranking.validComparableRows).toBe(0);
    expect(summary.ranking.anchorPrecision).toBe(0);
    expect(summary.ranking.validAnchorRecall).toBeNull();
  });
});
