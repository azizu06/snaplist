import type { EvalPrediction, GoldItem } from "./types";

/**
 * Eval metric functions (issue #16). EVERY function here is PURE — no I/O, no
 * clock, no randomness — so each metric is unit-testable offline with crafted
 * inputs and the whole report is reproducible from (gold set, predictions).
 */

/** A gold item paired with the prediction under evaluation. */
export interface EvalPair {
  gold: GoldItem;
  prediction: EvalPrediction;
}

// ---------------------------------------------------------------------------
// ID field accuracy
// ---------------------------------------------------------------------------

/** The ID fields scored against gold truth. */
export const ID_FIELDS = ["brand", "model", "category", "condition", "isbn"] as const;

export type IdField = (typeof ID_FIELDS)[number];

/**
 * Normalize for comparison: lowercase, fold hyphens/underscores to spaces,
 * collapse whitespace, trim. Folding punctuation means "very-good" matches
 * "Very Good" and "WH-1000XM4" matches "wh 1000xm4" — formatting variance is
 * not an identification miss.
 */
export function normalizeField(value: string): string {
  return value
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Does a predicted field value match the gold truth?
 *
 * - Truth UNDEFINED → returns null (field not evaluated for this item; a generic
 *   item honestly has no brand/model ground truth and must not pad accuracy).
 * - Truth defined, prediction missing → false (the pipeline failed to resolve it).
 * - Otherwise: normalized equality, OR containment either way — so
 *   "Sony WH-1000XM4 Wireless Headphones" matches truth "WH-1000XM4" (extraction
 *   resolving a superstring of the identity is a correct identification, not a miss).
 */
export function fieldMatches(
  truth: string | undefined,
  predicted: string | undefined,
): boolean | null {
  if (truth === undefined) return null;
  if (predicted === undefined || predicted.trim() === "") return false;
  const t = normalizeField(truth);
  const p = normalizeField(predicted);
  return t === p || t.includes(p) || p.includes(t);
}

export interface FieldAccuracy {
  /** How many items had gold truth for this field. */
  evaluated: number;
  correct: number;
  /** correct / evaluated; null when nothing was evaluable. */
  accuracy: number | null;
}

export interface IdAccuracyReport {
  perField: Record<IdField, FieldAccuracy>;
  /** Micro-average over every evaluated (item, field) cell. */
  overall: FieldAccuracy;
}

/** Score the predicted attributes of every pair against gold truth, per field. */
export function idAccuracy(pairs: readonly EvalPair[]): IdAccuracyReport {
  const perField = {} as Record<IdField, FieldAccuracy>;
  let evaluated = 0;
  let correct = 0;
  for (const field of ID_FIELDS) {
    let fieldEvaluated = 0;
    let fieldCorrect = 0;
    for (const { gold, prediction } of pairs) {
      const match = fieldMatches(gold.truth[field], prediction.attrs[field]);
      if (match === null) continue;
      fieldEvaluated += 1;
      if (match) fieldCorrect += 1;
    }
    perField[field] = {
      evaluated: fieldEvaluated,
      correct: fieldCorrect,
      accuracy: fieldEvaluated > 0 ? fieldCorrect / fieldEvaluated : null,
    };
    evaluated += fieldEvaluated;
    correct += fieldCorrect;
  }
  return {
    perField,
    overall: {
      evaluated,
      correct,
      accuracy: evaluated > 0 ? correct / evaluated : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Pricing-within-band
// ---------------------------------------------------------------------------

/** Median of a list. Returns null for an empty list (no fake zeros). */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface PricingReport {
  evaluated: number;
  withinBand: number;
  /** withinBand / evaluated; null when nothing was evaluable. */
  pctWithinBand: number | null;
  /** Median |price − band midpoint| in USD. */
  medianAbsError: number | null;
  /** Median |price − band midpoint| / midpoint (relative error). */
  medianRelError: number | null;
}

/** Is the suggested price inside the gold band (inclusive)? */
export function priceWithinBand(pair: EvalPair): boolean {
  const { low, high } = pair.gold.priceBand;
  return pair.prediction.price >= low && pair.prediction.price <= high;
}

/**
 * Pricing accuracy over all pairs: % within band plus median absolute / relative
 * error against the band MIDPOINT (the single defensible point estimate the band
 * implies; gold truth is a band, not a scalar, so error-to-midpoint is the
 * documented convention here).
 */
export function pricingAccuracy(pairs: readonly EvalPair[]): PricingReport {
  const absErrors: number[] = [];
  const relErrors: number[] = [];
  let withinBand = 0;
  for (const pair of pairs) {
    const { low, high } = pair.gold.priceBand;
    const midpoint = (low + high) / 2;
    const absError = Math.abs(pair.prediction.price - midpoint);
    absErrors.push(absError);
    relErrors.push(absError / midpoint);
    if (priceWithinBand(pair)) withinBand += 1;
  }
  return {
    evaluated: pairs.length,
    withinBand,
    pctWithinBand: pairs.length > 0 ? withinBand / pairs.length : null,
    medianAbsError: median(absErrors),
    medianRelError: median(relErrors),
  };
}

// ---------------------------------------------------------------------------
// Confidence calibration (reliability bucketing)
// ---------------------------------------------------------------------------

/**
 * The per-item correctness bit that calibration measures confidence AGAINST:
 * the suggested price landed in the gold band AND the identity fields the gold
 * set defines (brand/model) were recovered. That is exactly what the composite
 * confidence claims to predict — "this run is right enough to autopilot" — so a
 * well-calibrated 0.8 bucket should be observed-correct ~80% of the time.
 */
export function observedCorrect(pair: EvalPair): boolean {
  if (!priceWithinBand(pair)) return false;
  for (const field of ["brand", "model"] as const) {
    const match = fieldMatches(pair.gold.truth[field], pair.prediction.attrs[field]);
    if (match === false) return false;
  }
  return true;
}

export interface CalibrationBucket {
  /** Inclusive lower bound of the bucket's confidence range. */
  low: number;
  /** Exclusive upper bound (inclusive for the final bucket). */
  high: number;
  count: number;
  meanConfidence: number | null;
  observedAccuracy: number | null;
  /** meanConfidence − observedAccuracy (positive = overconfident). */
  gap: number | null;
}

export interface CalibrationReport {
  buckets: CalibrationBucket[];
  /** Expected calibration error: Σ (count/total)·|meanConfidence − observedAccuracy|. */
  ece: number | null;
}

/**
 * Default bucket edges. Aligned with the confidence BANDS (confidence.ts:
 * high ≥ 0.75, medium ≥ 0.5) plus a low/very-low split, so the reliability table
 * reads directly against the product's own banding.
 */
export const DEFAULT_BUCKET_EDGES = [0, 0.25, 0.5, 0.75, 1] as const;

/**
 * Reliability bucketing: group predictions by predicted confidence and compare
 * each bucket's mean confidence with its observed accuracy (`observedCorrect`).
 * Edges must be ascending and span [first, last]; values land in [edge[i], edge[i+1])
 * with the final bucket inclusive of its upper edge.
 */
export function calibration(
  pairs: readonly EvalPair[],
  edges: readonly number[] = DEFAULT_BUCKET_EDGES,
): CalibrationReport {
  if (edges.length < 2) {
    throw new Error("calibration requires at least two bucket edges");
  }
  for (let i = 1; i < edges.length; i++) {
    if (edges[i] <= edges[i - 1]) {
      throw new Error("calibration bucket edges must be strictly ascending");
    }
  }

  const buckets: CalibrationBucket[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const low = edges[i];
    const high = edges[i + 1];
    const isLast = i === edges.length - 2;
    let count = 0;
    let confidenceSum = 0;
    let correctCount = 0;
    for (const pair of pairs) {
      const c = pair.prediction.confidence;
      const inBucket = isLast ? c >= low && c <= high : c >= low && c < high;
      if (!inBucket) continue;
      count += 1;
      confidenceSum += c;
      if (observedCorrect(pair)) correctCount += 1;
    }
    const meanConfidence = count > 0 ? confidenceSum / count : null;
    const observedAccuracy = count > 0 ? correctCount / count : null;
    buckets.push({
      low,
      high,
      count,
      meanConfidence,
      observedAccuracy,
      gap:
        meanConfidence !== null && observedAccuracy !== null
          ? meanConfidence - observedAccuracy
          : null,
    });
  }

  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  let ece: number | null = null;
  if (total > 0) {
    ece = 0;
    for (const b of buckets) {
      if (b.count === 0 || b.gap === null) continue;
      ece += (b.count / total) * Math.abs(b.gap);
    }
  }
  return { buckets, ece };
}

// ---------------------------------------------------------------------------
// Pair matching
// ---------------------------------------------------------------------------

export interface MatchResult {
  pairs: EvalPair[];
  /** Gold items with no prediction (coverage gaps — reported, never silently dropped). */
  missingGoldIds: string[];
  /** Predictions whose goldId is not in the gold set (stale fixture / bad mapping). */
  unmatchedGoldIds: string[];
}

/**
 * Join predictions onto the gold set by goldId. One prediction per gold item;
 * when multiple predictions target the same gold item the LAST one wins (the
 * most recent run), which is documented behavior rather than an error so a
 * re-run log can be evaluated directly. Keep-last only means "newest" when the
 * input is chronologically ordered — load-bearing for file-based predictions
 * (scored in file order); the `--db` path already yields exactly ONE newest
 * row per gold item (per-item newest-first `limit: 1` reads), so keep-last is
 * a no-op safety net there.
 */
export function matchPredictions(
  gold: readonly GoldItem[],
  predictions: readonly EvalPrediction[],
): MatchResult {
  const goldById = new Map(gold.map((g) => [g.id, g]));
  const predictionByGoldId = new Map<string, EvalPrediction>();
  const unmatchedGoldIds: string[] = [];
  for (const p of predictions) {
    if (goldById.has(p.goldId)) {
      predictionByGoldId.set(p.goldId, p);
    } else {
      unmatchedGoldIds.push(p.goldId);
    }
  }
  const pairs: EvalPair[] = [];
  const missingGoldIds: string[] = [];
  for (const g of gold) {
    const prediction = predictionByGoldId.get(g.id);
    if (prediction === undefined) {
      missingGoldIds.push(g.id);
    } else {
      pairs.push({ gold: g, prediction });
    }
  }
  return { pairs, missingGoldIds, unmatchedGoldIds };
}
