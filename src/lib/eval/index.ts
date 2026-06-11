/**
 * Eval harness over the gold set (issue #16). Public surface:
 *  - fixtures: GOLD_SET, SAMPLE_PREDICTIONS, JUDGE_HUMAN_LABELS
 *  - metrics:  idAccuracy, pricingAccuracy, calibration, matchPredictions, …
 *  - judge:    JudgeFn seam, heuristic + OpenAI judges, validateJudge
 *  - report:   runEval, formatReport
 * Run it via `pnpm eval` (src/lib/eval/run.ts).
 */
export * from "./types";
export * from "./metrics";
export * from "./judge";
export * from "./report";
export {
  GOLD_SET,
  JUDGE_HUMAN_LABELS,
  SAMPLE_PREDICTIONS,
  parsePredictions,
} from "./fixtures";
