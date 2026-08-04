import { selectFreshComps } from "../freshness";
import { selectSoldCompEvidence } from "../sold-comp-matcher";
import { synthesizeSoldResult, type EbaySoldComp } from "../providers/ebay-sold";
import { SOLD_COMPS_BENCHMARK_CORPUS } from "./corpus";
import { migrateDuplicateCompIds } from "./core";
import type {
  BenchmarkCapture,
  BenchmarkComp,
  BenchmarkCompLabel,
  ProductResearchStatus,
  ProviderQueryCapture,
} from "./types";

export interface SoldCompRankingReplaySummary {
  schemaVersion: 1;
  runId: string;
  retrieval: {
    queryCount: number;
    labeledRows: number;
    relevantPrecision: number | null;
  };
  ranking: {
    anchorRows: number;
    corroborationRows: number;
    rejectedRows: number;
    labeledAnchorRows: number;
    validAnchorRows: number;
    validComparableRows: number;
    anchorPrecision: number | null;
    validAnchorRecall: number | null;
    usablePricingQueries: number;
    pricingQueryCoverage: number | null;
    missingCorpusQueries: number;
  };
  productResearchReference: {
    status: "not-provided" | "complete";
    referenceQueryCount: number;
    comparableQueryCount: number;
    medianAbsoluteSuggestedErrorRate: number | null;
    medianRangeOverlapRate: number | null;
    basis: "aggregate-average-and-range";
  };
}

const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

/**
 * Mirrors normalization's hard price constraints without reusing
 * `usableForPricing`, which also carries the superseded binary relevance gate
 * in saved Issue #188 captures.
 */
const hasUsablePricingAmount = (comp: BenchmarkComp): boolean =>
  comp.currency === "USD" &&
  Number.isFinite(comp.price) &&
  comp.price > 0 &&
  comp.priceDisclosure === "displayed-sold-price" &&
  !comp.isBestOfferAccepted;

const isValidComparable = (
  comp: BenchmarkComp,
  label: BenchmarkCompLabel,
): boolean =>
  hasUsablePricingAmount(comp) &&
  label.relevant &&
  label.variantCorrect &&
  label.conditionCorrect;

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

function rangeOverlapRate(
  left: { min: number; max: number },
  right: { min: number; max: number },
): number {
  const overlap = Math.max(0, Math.min(left.max, right.max) - Math.max(left.min, right.min));
  const union = Math.max(left.max, right.max) - Math.min(left.min, right.min);
  return union === 0 ? 1 : overlap / union;
}

function matcherPrice(
  query: ProviderQueryCapture,
  signal: (typeof SOLD_COMPS_BENCHMARK_CORPUS)[number]["signal"],
  benchmarkNow: number | undefined,
): { suggested: number; range: { min: number; max: number } } | null {
  /**
   * This replay deliberately stays below `finalizeVerifiedSoldResult`: it is an
   * offline ranking baseline for historical capture comparison, not a retrieval
   * adapter and never produces seller-facing adapter output. Its fixed
   * filter/minimum/synthesis sequence preserves the pre-#363 replay metric;
   * routing it through adapter finalization would change that baseline.
   */
  const candidates = query.comps
    .filter(hasUsablePricingAmount)
    .map((comp) => ({
      normalized: {
        url: `https://www.ebay.com/itm/${comp.id}`,
        title: comp.title,
        price: comp.price,
        ...(comp.condition ? { condition: comp.condition } : {}),
        ...(comp.endedAt && Number.isFinite(Date.parse(comp.endedAt))
          ? { soldAt: Date.parse(comp.endedAt) }
          : {}),
        isBestOfferAccepted: comp.isBestOfferAccepted,
        priceDisclosure: comp.priceDisclosure,
      } satisfies EbaySoldComp & Pick<BenchmarkComp, "isBestOfferAccepted" | "priceDisclosure">,
    }));
  const evidence = selectSoldCompEvidence(
    candidates.map(({ normalized }) => normalized),
    signal,
  );
  const weights = new Map<EbaySoldComp, number>(
    evidence.anchors.map(({ comp, score }) => [comp, score]),
  );
  const anchors = evidence.anchors.map(({ comp }) => comp);
  const fresh = benchmarkNow == null
    ? anchors
    : selectFreshComps(anchors, benchmarkNow);
  if (fresh.length < 2) return null;
  const result = synthesizeSoldResult(fresh, {
    ...(benchmarkNow != null ? { now: benchmarkNow } : {}),
    evidenceWeight: (comp) => weights.get(comp) ?? 1,
  });
  return { suggested: result.suggested, range: result.range };
}

function compareProductResearch(
  capture: BenchmarkCapture,
  reference: ProductResearchStatus | undefined,
): SoldCompRankingReplaySummary["productResearchReference"] {
  const rows = reference?.status === "complete" ? reference.rows ?? [] : [];
  if (rows.length === 0) {
    return {
      status: "not-provided",
      referenceQueryCount: 0,
      comparableQueryCount: 0,
      medianAbsoluteSuggestedErrorRate: null,
      medianRangeOverlapRate: null,
      basis: "aggregate-average-and-range",
    };
  }
  const corpus = new Map(SOLD_COMPS_BENCHMARK_CORPUS.map((entry) => [entry.id, entry]));
  const references = new Map(rows.map((row) => [row.queryId, row]));
  const parsedNow = Date.parse(capture.createdAt);
  const benchmarkNow = Number.isFinite(parsedNow) ? parsedNow : undefined;
  const comparisons = capture.queries
    .filter((query) => query.provider === "caffein-apify")
    .flatMap((query) => {
      const entry = corpus.get(query.queryId);
      const row = references.get(query.queryId);
      if (!entry || !row) return [];
      const result = matcherPrice(query, entry.signal, benchmarkNow);
      if (!result) return [];
      return [{
        error: Math.abs(result.suggested - row.average) / row.average,
        overlap: rangeOverlapRate(result.range, row.range),
      }];
    });
  return {
    status: "complete",
    referenceQueryCount: rows.length,
    comparableQueryCount: comparisons.length,
    medianAbsoluteSuggestedErrorRate: median(comparisons.map(({ error }) => error)),
    medianRangeOverlapRate: median(comparisons.map(({ overlap }) => overlap)),
    basis: "aggregate-average-and-range",
  };
}

export function replaySoldCompRanking(
  capture: BenchmarkCapture,
  labels: readonly BenchmarkCompLabel[],
  productResearch?: ProductResearchStatus,
): SoldCompRankingReplaySummary {
  const normalizedCapture = migrateDuplicateCompIds(capture);
  const corpus = new Map(SOLD_COMPS_BENCHMARK_CORPUS.map((entry) => [entry.id, entry]));
  const labelById = new Map(labels.map((label) => [label.compId, label]));
  const queries = normalizedCapture.queries.filter(
    (query) => query.provider === "caffein-apify",
  );

  let anchorRows = 0;
  let corroborationRows = 0;
  let rejectedRows = 0;
  let labeledAnchorRows = 0;
  let validAnchorRows = 0;
  let validComparableRows = 0;
  let usablePricingQueries = 0;
  let missingCorpusQueries = 0;

  for (const query of queries) {
    const entry = corpus.get(query.queryId);
    if (!entry) {
      missingCorpusQueries += 1;
      continue;
    }

    const evidence = selectSoldCompEvidence<BenchmarkComp>(query.comps, entry.signal);
    anchorRows += evidence.anchors.length;
    corroborationRows += evidence.corroboration.length;
    rejectedRows += evidence.rejected.length;
    const usablePricingAnchors = evidence.anchors.filter(({ comp }) =>
      hasUsablePricingAmount(comp),
    );
    if (usablePricingAnchors.length >= 2) usablePricingQueries += 1;

    for (const comp of query.comps) {
      const label = labelById.get(comp.id);
      if (label && isValidComparable(comp, label)) validComparableRows += 1;
    }
    for (const match of evidence.anchors) {
      const label = labelById.get(match.comp.id);
      if (!label) continue;
      labeledAnchorRows += 1;
      if (isValidComparable(match.comp, label)) validAnchorRows += 1;
    }
  }

  const labeledRows = queries.reduce(
    (count, query) =>
      count + query.comps.filter((comp) => labelById.has(comp.id)).length,
    0,
  );
  const relevantRows = queries.reduce(
    (count, query) =>
      count +
      query.comps.filter((comp) => labelById.get(comp.id)?.relevant === true).length,
    0,
  );

  return {
    schemaVersion: 1,
    runId: capture.runId,
    retrieval: {
      queryCount: queries.length,
      labeledRows,
      relevantPrecision: ratio(relevantRows, labeledRows),
    },
    ranking: {
      anchorRows,
      corroborationRows,
      rejectedRows,
      labeledAnchorRows,
      validAnchorRows,
      validComparableRows,
      anchorPrecision: ratio(validAnchorRows, labeledAnchorRows),
      validAnchorRecall: ratio(validAnchorRows, validComparableRows),
      usablePricingQueries,
      pricingQueryCoverage: ratio(usablePricingQueries, queries.length),
      missingCorpusQueries,
    },
    productResearchReference: compareProductResearch(capture, productResearch),
  };
}

const percent = (value: number | null): string =>
  value == null ? "n/a" : `${(value * 100).toFixed(2)}%`;

/**
 * Aggregate-only report. It deliberately cannot include comp titles, ids, URLs,
 * seller data, or source payloads because the replay summary contains none.
 */
export function formatSoldCompRankingReplay(
  summary: SoldCompRankingReplaySummary,
): string {
  return `# Sold-comp ranking replay

- Run: \`${summary.runId}\`
- Provider requests: **0** (saved capture replay only)
- Queries: ${summary.retrieval.queryCount}
- Labeled rows: ${summary.retrieval.labeledRows}
- Retrieval relevant precision: ${percent(summary.retrieval.relevantPrecision)}

## SnapList matcher output

- Price anchors: ${summary.ranking.anchorRows}
- Corroboration-only rows: ${summary.ranking.corroborationRows}
- Rejected rows: ${summary.ranking.rejectedRows}
- Anchor precision: ${percent(summary.ranking.anchorPrecision)}
- Valid comparable recall into anchors: ${percent(summary.ranking.validAnchorRecall)}
- Queries with at least two price anchors: ${summary.ranking.usablePricingQueries} (${percent(summary.ranking.pricingQueryCoverage)})
- Missing corpus queries: ${summary.ranking.missingCorpusQueries}

## Product Research reference

- Status: ${summary.productResearchReference.status}
- Aggregate reference queries: ${summary.productResearchReference.referenceQueryCount}
- Matcher-price comparisons: ${summary.productResearchReference.comparableQueryCount}
- Median absolute suggested-price error vs aggregate average: ${percent(summary.productResearchReference.medianAbsoluteSuggestedErrorRate)}
- Median matcher/reference range overlap: ${percent(summary.productResearchReference.medianRangeOverlapRate)}

Product Research exposes an aggregate average and range, not a listing-level gold price or median. These comparison metrics are reference-limited and must not be presented as field accuracy.

## Interpretation

The provider retrieval metric and SnapList ranking metric are intentionally separate. Only price anchors may enter the median, cited source set, or minimum-two-comp pricing gate. Corroboration can support later review but cannot silently price an item.

The Issue #188 \`reject-apify\` conclusion combined provider retrieval with the prior binary matcher. This corrected replay supersedes that ranking conclusion: it supports keeping the captured Apify evidence as a promising retrieval source while production activation remains blocked. The corpus is condition-skewed and the labels are agent-assisted rather than a completed human gold set; provider routing requires a separate owner decision after balanced-condition and Product Research validation.
`;
}
