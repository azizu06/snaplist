import type { GoldFixture, MeasurementName, PredictionRecord } from "./types";

/**
 * Spike #104 scorer — pure functions from (gold, predictions) to the reported
 * numbers and the GO/NO-GO verdict. No I/O; unit-tested in score.test.ts.
 *
 * Verdict bar (the "size-class bar", agreed with Aziz 2026-07-02): the feature
 * ships if, on photos WITH a scale cue, median absolute error is ≤ 1.5in AND the
 * model reliably (≥ 90%) orders garments whose true measurements differ by ≥ 3in
 * (the "21in vs 24in pit-to-pit" question buyers actually ask). The strict ±1in
 * bar from issue #104 is still reported, but it sits at the noise floor of
 * seller-stated ground truth (±~0.5in), so it doesn't decide the verdict alone.
 */

export interface MatchedRow {
  fixtureId: string;
  name: MeasurementName;
  /** Seller-stated inches (ground truth). */
  gt: number;
  /** Model-predicted inches. */
  pred: number;
  absError: number;
  /** Model's self-reported ± band, for calibration commentary. */
  toleranceIn: number;
  scaleCue: boolean;
  method: "reference-scaled" | "prior-based";
  garmentType: string;
}

/** Pair every predicted measurement with its seller-stated ground truth. */
export function matchRows(
  gold: GoldFixture[],
  predictions: PredictionRecord[],
): MatchedRow[] {
  const byId = new Map(gold.map((g) => [g.id, g]));
  const rows: MatchedRow[] = [];
  for (const p of predictions) {
    if (!p.ok || !p.response?.measurements) continue;
    const g = byId.get(p.fixtureId);
    if (!g) continue;
    for (const m of p.response.measurements) {
      const gt = g.measurements[m.name];
      if (gt === undefined) continue; // model measured something the seller didn't state
      rows.push({
        fixtureId: g.id,
        name: m.name,
        gt,
        pred: m.value_in,
        absError: Math.abs(m.value_in - gt),
        toleranceIn: m.tolerance_in,
        scaleCue: g.scale_cue,
        method: m.method,
        garmentType: g.garment_type,
      });
    }
  }
  return rows;
}

/** Gold measurements the model never returned — reported, not silently dropped. */
export function countMissedGold(
  gold: GoldFixture[],
  predictions: PredictionRecord[],
): number {
  const predicted = new Set(
    predictions.flatMap((p) =>
      p.ok && p.response?.measurements
        ? p.response.measurements.map((m) => `${p.fixtureId}:${m.name}`)
        : [],
    ),
  );
  let missed = 0;
  for (const g of gold) {
    for (const name of Object.keys(g.measurements)) {
      if (!predicted.has(`${g.id}:${name}`)) missed += 1;
    }
  }
  return missed;
}

export function medianAbsError(errors: number[]): number | null {
  if (errors.length === 0) return null;
  const sorted = [...errors].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function pctWithin(errors: number[], thresholdIn: number): number | null {
  if (errors.length === 0) return null;
  return errors.filter((e) => e <= thresholdIn).length / errors.length;
}

export interface DiscriminationResult {
  /** Same-measurement pairs whose TRUE values differ by >= the gap. */
  pairs: number;
  /** Pairs the model ordered the same way as the truth. */
  correct: number;
  rate: number | null;
}

/**
 * The "size-class" question: given two garments whose true measurement differs by
 * >= `minGapIn` (default 3in — roughly one size class), does the model's ordering
 * agree? Buyers don't need ±0.5in; they need "is this the 21 or the 24".
 */
export function discrimination(rows: MatchedRow[], minGapIn = 3): DiscriminationResult {
  let pairs = 0;
  let correct = 0;
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      if (a.name !== b.name || a.fixtureId === b.fixtureId) continue;
      if (Math.abs(a.gt - b.gt) < minGapIn) continue;
      pairs += 1;
      if (Math.sign(a.pred - b.pred) === Math.sign(a.gt - b.gt)) correct += 1;
    }
  }
  return { pairs, correct, rate: pairs === 0 ? null : correct / pairs };
}

export interface MeasurementSummary {
  n: number;
  medianAbsError: number | null;
  pctWithin1: number | null;
  pctWithin1_5: number | null;
}

export function summarizeByMeasurement(
  rows: MatchedRow[],
): Record<string, MeasurementSummary> {
  const out: Record<string, MeasurementSummary> = {};
  const names = [...new Set(rows.map((r) => r.name))];
  for (const name of names) {
    const errs = rows.filter((r) => r.name === name).map((r) => r.absError);
    out[name] = {
      n: errs.length,
      medianAbsError: medianAbsError(errs),
      pctWithin1: pctWithin(errs, 1.0),
      pctWithin1_5: pctWithin(errs, 1.5),
    };
  }
  return out;
}

export interface CohortSummary extends MeasurementSummary {
  discrimination: DiscriminationResult;
}

function cohortSummary(rows: MatchedRow[]): CohortSummary {
  const errs = rows.map((r) => r.absError);
  return {
    n: errs.length,
    medianAbsError: medianAbsError(errs),
    pctWithin1: pctWithin(errs, 1.0),
    pctWithin1_5: pctWithin(errs, 1.5),
    discrimination: discrimination(rows),
  };
}

export type Verdict = "GO" | "NO-GO" | "INSUFFICIENT-DATA";

/** Minimum with-cue matched measurements before the verdict means anything. */
const MIN_WITH_CUE_ROWS = 5;
/** Minimum >=3in-gap pairs before the discrimination rate means anything. */
const MIN_DISCRIMINATION_PAIRS = 5;

export interface SpikeScore {
  rows: MatchedRow[];
  missedGold: number;
  failedFixtures: string[];
  withCue: CohortSummary;
  withoutCue: CohortSummary;
  overall: CohortSummary;
  byMeasurement: Record<string, MeasurementSummary>;
  verdict: Verdict;
  verdictReason: string;
}

export function scoreSpike(
  gold: GoldFixture[],
  predictions: PredictionRecord[],
): SpikeScore {
  const rows = matchRows(gold, predictions);
  const withCueRows = rows.filter((r) => r.scaleCue);
  const withCue = cohortSummary(withCueRows);
  const withoutCue = cohortSummary(rows.filter((r) => !r.scaleCue));
  const overall = cohortSummary(rows);

  let verdict: Verdict;
  let verdictReason: string;
  const disc = withCue.discrimination;
  if (withCue.n < MIN_WITH_CUE_ROWS || disc.pairs < MIN_DISCRIMINATION_PAIRS) {
    verdict = "INSUFFICIENT-DATA";
    verdictReason =
      `Need >=${MIN_WITH_CUE_ROWS} with-cue measurements (have ${withCue.n}) and ` +
      `>=${MIN_DISCRIMINATION_PAIRS} with-cue >=3in-gap pairs (have ${disc.pairs}) to call it.`;
  } else if (
    withCue.medianAbsError !== null &&
    withCue.medianAbsError <= 1.5 &&
    disc.rate !== null &&
    disc.rate >= 0.9
  ) {
    verdict = "GO";
    verdictReason =
      `With-cue median abs error ${withCue.medianAbsError.toFixed(2)}in <= 1.5in and ` +
      `with-cue size-class discrimination ${(disc.rate * 100).toFixed(0)}% >= 90%.`;
  } else {
    verdict = "NO-GO";
    verdictReason =
      `Size-class bar missed: with-cue median abs error ` +
      `${withCue.medianAbsError?.toFixed(2) ?? "n/a"}in (bar 1.5in), ` +
      `with-cue discrimination ${disc.rate === null ? "n/a" : `${(disc.rate * 100).toFixed(0)}%`} (bar 90%).`;
  }

  return {
    rows,
    missedGold: countMissedGold(gold, predictions),
    failedFixtures: predictions.filter((p) => !p.ok).map((p) => p.fixtureId),
    withCue,
    withoutCue,
    overall,
    byMeasurement: summarizeByMeasurement(rows),
    verdict,
    verdictReason,
  };
}
