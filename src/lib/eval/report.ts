import {
  calibration,
  idAccuracy,
  matchPredictions,
  pricingAccuracy,
  type CalibrationReport,
  type EvalPair,
  type IdAccuracyReport,
  type PricingReport,
} from "./metrics";
import {
  JUDGE_DIMENSIONS,
  validateJudge,
  type HumanLabeledListing,
  type JudgeAgreement,
  type JudgeDimension,
  type JudgeFn,
  type JudgeScores,
} from "./judge";
import type { EvalPrediction, GoldItem } from "./types";

/**
 * Eval report assembly (issue #16): join predictions onto the gold set, compute
 * the four metric families, and render a human-readable report. `runEval` is
 * deterministic given (gold, predictions, judge) — the judge is the only async
 * seam, and the default offline judge is itself deterministic.
 */

export interface ListingQualityReport {
  /** Which judge produced the scores ("heuristic-offline" | model id). */
  judge: string;
  judged: number;
  skippedNoListing: number;
  /** Mean rubric score per dimension over all judged listings. */
  meanScores: Record<JudgeDimension, number> | null;
  /** Judge-vs-human agreement on the shipped human-labeled subset. */
  agreement: JudgeAgreement;
}

export interface EvalReport {
  goldSetSize: number;
  evaluated: number;
  missingGoldIds: string[];
  unmatchedGoldIds: string[];
  /** How many evaluated runs fired each pricing tier (logged value, as-is). */
  tierDistribution: Record<string, number>;
  id: IdAccuracyReport;
  pricing: PricingReport;
  calibration: CalibrationReport;
  listing: ListingQualityReport;
}

export interface RunEvalInput {
  gold: readonly GoldItem[];
  predictions: readonly EvalPrediction[];
  /** The injected judge (heuristic offline by default at the call site). */
  judge: JudgeFn;
  /** Label recorded in the report for which judge ran. */
  judgeName: string;
  /** Human-labeled subset to validate the judge against. */
  humanLabels: readonly HumanLabeledListing[];
}

function tierDistribution(pairs: readonly EvalPair[]): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const { prediction } of pairs) {
    const tier = prediction.tierFired ?? "(unknown)";
    dist[tier] = (dist[tier] ?? 0) + 1;
  }
  return dist;
}

async function listingQuality(
  pairs: readonly EvalPair[],
  judge: JudgeFn,
  judgeName: string,
  humanLabels: readonly HumanLabeledListing[],
): Promise<ListingQualityReport> {
  // Validate the judge FIRST: its verdicts below are only as trustworthy as its
  // measured agreement with the human-labeled subset.
  const agreement = await validateJudge(judge, humanLabels);

  const scores: JudgeScores[] = [];
  let skippedNoListing = 0;
  for (const { prediction } of pairs) {
    if (prediction.listing === undefined) {
      skippedNoListing += 1;
      continue;
    }
    scores.push(
      await judge({ listing: prediction.listing, attributes: prediction.attrs }),
    );
  }

  let meanScores: Record<JudgeDimension, number> | null = null;
  if (scores.length > 0) {
    meanScores = {} as Record<JudgeDimension, number>;
    for (const dim of JUDGE_DIMENSIONS) {
      meanScores[dim] =
        scores.reduce((sum, s) => sum + s[dim], 0) / scores.length;
    }
  }

  return {
    judge: judgeName,
    judged: scores.length,
    skippedNoListing,
    meanScores,
    agreement,
  };
}

/** Run the full eval: match, score all four metric families, assemble the report. */
export async function runEval(input: RunEvalInput): Promise<EvalReport> {
  const { pairs, missingGoldIds, unmatchedGoldIds } = matchPredictions(
    input.gold,
    input.predictions,
  );
  return {
    goldSetSize: input.gold.length,
    evaluated: pairs.length,
    missingGoldIds,
    unmatchedGoldIds,
    tierDistribution: tierDistribution(pairs),
    id: idAccuracy(pairs),
    pricing: pricingAccuracy(pairs),
    calibration: calibration(pairs),
    listing: await listingQuality(
      pairs,
      input.judge,
      input.judgeName,
      input.humanLabels,
    ),
  };
}

// ---------------------------------------------------------------------------
// Plain-text rendering
// ---------------------------------------------------------------------------

function pct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function num(value: number | null, digits = 2): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

/** Render the report as the plain-text block `pnpm eval` prints. */
export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push("SnapList eval report");
  lines.push("====================");
  lines.push(
    `Gold set: ${report.goldSetSize} items | evaluated: ${report.evaluated}` +
      ` | missing predictions: ${report.missingGoldIds.length}` +
      ` | unmatched predictions: ${report.unmatchedGoldIds.length}`,
  );
  if (report.missingGoldIds.length > 0) {
    lines.push(`  missing: ${report.missingGoldIds.join(", ")}`);
  }
  if (report.unmatchedGoldIds.length > 0) {
    lines.push(`  unmatched: ${report.unmatchedGoldIds.join(", ")}`);
  }

  const tiers = Object.entries(report.tierDistribution)
    .sort((a, b) => b[1] - a[1])
    .map(([tier, count]) => `${tier}=${count}`)
    .join(", ");
  lines.push(`Tier distribution: ${tiers || "(none)"}`);

  lines.push("");
  lines.push("ID field accuracy");
  lines.push("-----------------");
  for (const [field, acc] of Object.entries(report.id.perField)) {
    lines.push(
      `  ${field.padEnd(10)} ${pct(acc.accuracy).padStart(6)}  (${acc.correct}/${acc.evaluated})`,
    );
  }
  lines.push(
    `  ${"OVERALL".padEnd(10)} ${pct(report.id.overall.accuracy).padStart(6)}  (${report.id.overall.correct}/${report.id.overall.evaluated})`,
  );

  lines.push("");
  lines.push("Pricing");
  lines.push("-------");
  lines.push(
    `  within band: ${pct(report.pricing.pctWithinBand)} (${report.pricing.withinBand}/${report.pricing.evaluated})`,
  );
  lines.push(
    `  median abs error vs band midpoint: $${num(report.pricing.medianAbsError)}`,
  );
  lines.push(`  median rel error: ${pct(report.pricing.medianRelError)}`);

  lines.push("");
  lines.push("Confidence calibration (reliability buckets)");
  lines.push("--------------------------------------------");
  lines.push("  bucket        n   mean-conf   observed-acc   gap");
  for (const b of report.calibration.buckets) {
    const range = `[${b.low.toFixed(2)},${b.high.toFixed(2)})`;
    lines.push(
      `  ${range.padEnd(12)} ${String(b.count).padStart(3)}   ${num(b.meanConfidence).padStart(8)}   ${num(b.observedAccuracy).padStart(11)}   ${b.gap === null ? " n/a" : (b.gap >= 0 ? "+" : "") + b.gap.toFixed(2)}`,
    );
  }
  lines.push(`  ECE: ${num(report.calibration.ece, 3)}`);

  lines.push("");
  lines.push(`Listing quality (judge: ${report.listing.judge})`);
  lines.push("---------------------------------------------");
  lines.push(
    `  judged: ${report.listing.judged} | skipped (no listing copy): ${report.listing.skippedNoListing}`,
  );
  if (report.listing.meanScores !== null) {
    for (const dim of JUDGE_DIMENSIONS) {
      lines.push(
        `  mean ${dim.padEnd(12)} ${report.listing.meanScores[dim].toFixed(2)} / 5`,
      );
    }
  }
  const agg = report.listing.agreement;
  lines.push(
    `  judge validation vs ${agg.examples} human-labeled listings:` +
      ` overall within-±1 = ${pct(agg.overallWithin1Rate)}`,
  );
  for (const dim of JUDGE_DIMENSIONS) {
    const d = agg.perDimension[dim];
    lines.push(
      `    ${dim.padEnd(12)} meanAbsDiff=${d.meanAbsDiff.toFixed(2)}  within±1=${pct(d.within1Rate)}  exact=${pct(d.exactRate)}`,
    );
  }
  return lines.join("\n");
}
