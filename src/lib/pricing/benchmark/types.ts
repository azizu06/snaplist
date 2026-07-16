import type { ItemSignal } from "../types";

export type BenchmarkProvider =
  | "scrapingbee-public-page"
  | "caffein-apify";

export type BenchmarkTag =
  | "books-media"
  | "electronics"
  | "video-games"
  | "board-games"
  | "lego"
  | "sneakers"
  | "clothing"
  | "branded-gear"
  | "used"
  | "new"
  | "ambiguous-variant"
  | "accessory-as-product"
  | "weak-no-comp"
  | "product-research-subset";

export interface BenchmarkHumanRule {
  /** Each group requires at least one matching phrase in a relevant title. */
  requiredPhraseGroups: string[][];
  /** Phrases that identify a materially different variant or non-item result. */
  forbiddenPhrases: string[];
  targetCondition: "used" | "new" | "any";
}

export interface BenchmarkCorpusEntry {
  id: string;
  query: string;
  signal: ItemSignal;
  tags: BenchmarkTag[];
  humanRule: BenchmarkHumanRule;
}

export type PriceDisclosure =
  | "displayed-sold-price"
  | "asking-price-not-accepted-amount";

/**
 * Private, normalized review row. It deliberately has no URL, item id, seller,
 * feedback, image, cookie, token, or raw-response field. The title is retained
 * only in the operator-local review queue for human or disclosed agent-assisted
 * relevance review.
 */
export interface BenchmarkComp {
  id: string;
  title: string;
  price: number;
  currency: string;
  condition: string | null;
  endedAt: string | null;
  usableForPricing: boolean;
  isBestOfferAccepted: boolean;
  priceDisclosure: PriceDisclosure;
}

export interface ProviderQueryCapture {
  provider: BenchmarkProvider;
  queryId: string;
  status: "success" | "empty" | "blocked" | "error";
  latencyMs: number;
  attempts: number;
  retries: number;
  /** Exact ScrapingBee response-header cost when present. */
  creditsSpent: number | null;
  /** Incremental run charge. ScrapingBee prepaid-credit calls are USD 0 here. */
  actualUsdSpent: number | null;
  bestOfferPolicy: "excluded-by-parser" | "labeled-and-excluded";
  comps: BenchmarkComp[];
  boundedError?: "timeout" | "http-error" | "request-failed" | "actor-failed";
}

export interface ApifyPricingSnapshot {
  observedAt: string;
  actorId: string;
  actorBuildId: string;
  actorBuildNumber: string;
  actorBuildFinishedAt: string;
  pricingStartedAt: string;
  resultPriceUpperBoundUsd: number;
  actorStartPriceUsd: number;
  actorStartUnitsPerRun: number;
  source: "live-public-actor-metadata";
}

export interface ScrapingBeeCreditAccounting {
  /** Authoritative account-level delta across the isolated benchmark window. */
  accountDeltaCredits: number;
  /** Sum of exact SPB-cost response headers that arrived before client abort. */
  responseHeaderCredits: number;
  /** Charged credits that cannot honestly be assigned to an individual abort. */
  unattributedCredits: number;
}

export interface ProductResearchStatus {
  status: "operator-pending" | "complete";
  queryIds: string[];
  reviewMethod?: "codex-assisted-operator";
  rows?: Array<{
    queryId: string;
    condition: string;
    average: number;
    range: { min: number; max: number };
    sellThroughPct: number;
    totalSellers: number;
    capturedAt: string;
  }>;
}

export interface BenchmarkCapture {
  schemaVersion: 1;
  runId: string;
  mode: "dry-run" | "live";
  createdAt: string;
  corpusDigest: string;
  maxResultsPerQuery: number;
  apifyHardCeilingUsd: number;
  queries: ProviderQueryCapture[];
  apifyPricingSnapshot: ApifyPricingSnapshot | null;
  scrapingBeeCreditAccounting?: ScrapingBeeCreditAccounting;
  productResearch: ProductResearchStatus;
  liveLimitations?: string[];
}

export interface BenchmarkCompLabel {
  compId: string;
  relevant: boolean;
  variantCorrect: boolean;
  conditionCorrect: boolean;
  note?: string;
}

export interface LabelReviewStatus {
  status: "operator-pending" | "complete";
  reviewMethod: "human" | "codex-agent-assisted" | null;
  labelCount: number;
}

export interface ProviderSummary {
  provider: BenchmarkProvider;
  queryCount: number;
  successfulQueryCoverage: number;
  emptyResultRate: number;
  blockErrorRate: number;
  relevantPrecision: number | null;
  variantContaminationRate: number | null;
  conditionContaminationRate: number | null;
  labeledCompCount: number;
  usableCompCount: number;
  usablePricingQueryCount: number;
  medianUsableCompsPerSuccessfulQuery: number | null;
  medianSplitStabilityDelta: number | null;
  medianRangeWidthRatio: number | null;
  latencyMs: { p50: number | null; p95: number | null };
  retries: number;
  bestOfferRowsObserved: number;
  creditsSpent: number;
  actualUsdSpent: number | null;
  costPerQueryUsd: number | null;
  costPerUsableCompUsd: number | null;
  costPerUsablePricingResultUsd: number | null;
}

export interface RedactedBenchmarkArtifact {
  schemaVersion: 1;
  runId: string;
  mode: "dry-run" | "live";
  createdAt: string;
  corpusDigest: string;
  queryCount: number;
  maxResultsPerQuery: number;
  apifyHardCeilingUsd: number;
  candidate: {
    actorId: string;
    actorBuildId: string;
    actorBuildNumber: string;
    actorBuildFinishedAt: string;
    metadataObservedAt: string;
  } | null;
  providers: ProviderSummary[];
  perQuery: Array<{
    provider: BenchmarkProvider;
    queryId: string;
    status: ProviderQueryCapture["status"];
    compCount: number;
    usableCompCount: number;
    labeledCompCount: number;
    average: number | null;
    median: number | null;
    range: { min: number; max: number } | null;
    latencyMs: number;
    retries: number;
    creditsSpent: number | null;
    actualUsdSpent: number | null;
  }>;
  crossProvider: {
    comparableQueryCount: number;
    medianAbsoluteMedianDeltaRate: number | null;
    medianRangeOverlapRate: number | null;
  };
  labelReview: LabelReviewStatus;
  productResearchComparison: {
    byProvider: Array<{
      provider: BenchmarkProvider;
      comparableQueryCount: number;
      medianAbsoluteAverageDeltaRate: number | null;
      medianRangeOverlapRate: number | null;
    }>;
    rows: Array<{
      provider: BenchmarkProvider;
      queryId: string;
      providerAverage: number;
      referenceAverage: number;
      absoluteAverageDeltaRate: number;
      rangeOverlapRate: number;
    }>;
  };
  maintainability: Record<BenchmarkProvider, {
    schemaBurden: string;
    blockRetryBehavior: string;
    lockInRisk: string;
  }>;
  costAccounting: {
    scrapingBee: ScrapingBeeCreditAccounting | null;
  };
  productResearch: ProductResearchStatus;
  recommendation: {
    status: "operator-pending" | "apify-primary" | "apify-fallback" | "reject-apify";
    reason: string;
    monthlyCrossoverQueries: number | null;
  };
  redaction: {
    rawResponsesPersisted: false;
    sellerFieldsPersisted: false;
    sourceUrlsPersisted: false;
    reviewTitlesPersisted: false;
  };
}
