import goldSetJson from "./fixtures/gold-set.json";
import predictionsSampleJson from "./fixtures/predictions.sample.json";
import judgeHumanLabelsJson from "./fixtures/judge-human-labels.json";
import {
  evalPredictionsSchema,
  goldSetSchema,
  type EvalPrediction,
  type GoldItem,
} from "./types";
import {
  humanLabeledSubsetSchema,
  type HumanLabeledListing,
} from "./judge";

/**
 * Checked-in eval fixtures, Zod-validated at load so a malformed fixture fails
 * fast (and in tests) rather than producing a silently wrong report:
 *
 *  - GOLD_SET            — the fixed ~36-item hero-domain gold set; overlaps the
 *                          seeded reference corpus via `sourceRef`.
 *  - SAMPLE_PREDICTIONS  — a realistic predictions file for offline/demo runs
 *                          (designed spread: ID misses, out-of-band prices, and
 *                          confidences across all calibration buckets).
 *  - JUDGE_HUMAN_LABELS  — the small human-labeled subset the LLM judge is
 *                          validated against (agreement metric in every report).
 */

export const GOLD_SET: GoldItem[] = goldSetSchema.parse(goldSetJson);

export const SAMPLE_PREDICTIONS: EvalPrediction[] =
  evalPredictionsSchema.parse(predictionsSampleJson);

export const JUDGE_HUMAN_LABELS: HumanLabeledListing[] =
  humanLabeledSubsetSchema.parse(judgeHumanLabelsJson);

/** Parse an externally supplied predictions JSON payload (the --predictions file). */
export function parsePredictions(raw: unknown): EvalPrediction[] {
  const parsed = evalPredictionsSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid predictions file:\n${issues}`);
  }
  return parsed.data;
}
