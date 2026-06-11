import { z } from "zod";
import {
  extractedAttributesSchema,
  type ExtractedAttributes,
} from "../pipeline/types";
import type { PredictionLogRow } from "../pipeline/prediction-log";

/**
 * Eval harness contracts (issue #16).
 *
 * The harness scores logged pipeline predictions against a fixed, checked-in
 * GOLD SET of hero-domain items (books/media, electronics, board games, branded
 * gear — overlapping the seeded reference corpus) on four axes:
 *
 *   1. ID field accuracy        — did extraction recover brand/model/category/…?
 *   2. Pricing-within-band      — is the suggested price inside the ground-truth band?
 *   3. Confidence calibration   — does predicted confidence track observed accuracy?
 *   4. Listing quality          — LLM-judge rubric, itself validated against a
 *                                 human-labeled subset shipped as a fixture.
 *
 * Everything here is a pure data contract; metric functions live in metrics.ts,
 * the judge seam in judge.ts, and the report assembly in report.ts. All fixtures
 * are Zod-validated at load so a malformed fixture fails fast (and in tests).
 */

/** The ID fields the gold set asserts ground truth for. */
export const goldTruthSchema = z.object({
  brand: z.string().optional(),
  model: z.string().optional(),
  category: z.string(),
  condition: z.string().optional(),
  /** Books/media ground truth; also exercises the ISBN tier end to end. */
  isbn: z.string().optional(),
});

export type GoldTruth = z.infer<typeof goldTruthSchema>;

/** Ground-truth defensible used-price band (USD). */
export const goldPriceBandSchema = z
  .object({
    low: z.number().positive(),
    high: z.number().positive(),
  })
  .refine((b) => b.low <= b.high, {
    message: "priceBand.low must be <= priceBand.high",
  });

export type GoldPriceBand = z.infer<typeof goldPriceBandSchema>;

/**
 * One gold-set item: a hero-domain item with verified ID fields and a
 * ground-truth price band. `sourceRef` ties it back to the seeded reference
 * corpus (`src/lib/rag/corpus-data.ts`) where the item overlaps it; `itemId`
 * is an OPTIONAL uuid mapping filled in when evaluating real DB rows (a logged
 * prediction is matched to its gold item by `prediction_logs.item_id`).
 */
export const goldItemSchema = z.object({
  /** Stable unique id, e.g. "gold-electronics-sony-wh1000xm4". */
  id: z.string().min(1),
  /** Reference-corpus overlap (`reference_corpus.source_ref`), when applicable. */
  sourceRef: z.string().optional(),
  /** Optional `items.id` uuid for matching real logged predictions (--db runs). */
  itemId: z.string().optional(),
  truth: goldTruthSchema,
  priceBand: goldPriceBandSchema,
  notes: z.string().optional(),
});

export type GoldItem = z.infer<typeof goldItemSchema>;

export const goldSetSchema = z.array(goldItemSchema);

/** The listing copy surface the judge scores. Mirrors `listings` columns. */
export const judgedListingSchema = z.object({
  title: z.string(),
  description: z.string(),
  itemSpecifics: z.record(z.string(), z.string()).optional(),
  tags: z.array(z.string()).optional(),
});

export type JudgedListing = z.infer<typeof judgedListingSchema>;

/**
 * One prediction to evaluate, NORMALIZED. This is the harness's single input
 * shape: the offline fixture file carries it directly (keyed by `goldId`), and
 * DB rows are converted onto it via `predictionFromLogRow`. `listing` is
 * optional — when absent the item is skipped for listing quality (the
 * `prediction_logs` table does not carry listing copy; DB runs join it from
 * `listings`).
 */
export const evalPredictionSchema = z.object({
  /** Which gold item this prediction is for. */
  goldId: z.string().min(1),
  /** The extracted attributes the run predicted. */
  attrs: extractedAttributesSchema,
  /** Suggested price (USD). */
  price: z.number().nonnegative(),
  /** Composite confidence in [0,1]. */
  confidence: z.number().min(0).max(1),
  /** Which pricing tier fired (free-form: logged value is reported, not mapped). */
  tierFired: z.string().optional(),
  /** Model id used for the run, for slicing reports by model. */
  model: z.string().optional(),
  /** The generated listing copy, when available, for the LLM judge. */
  listing: judgedListingSchema.optional(),
});

export type EvalPrediction = z.infer<typeof evalPredictionSchema>;

export const evalPredictionsSchema = z.array(evalPredictionSchema);

/**
 * Convert a logged `prediction_logs` row to the normalized eval shape, given the
 * item_id → goldId mapping derived from the gold set (`GoldItem.itemId`). Pure.
 * Returns null when the row's item is not in the gold set (not evaluable).
 */
export function predictionFromLogRow(
  row: PredictionLogRow,
  goldIdByItemId: ReadonlyMap<string, string>,
  listing?: JudgedListing,
): EvalPrediction | null {
  const goldId = goldIdByItemId.get(row.item_id);
  if (goldId === undefined) return null;
  return {
    goldId,
    attrs: row.extracted_attrs as ExtractedAttributes,
    price: row.price,
    confidence: row.confidence,
    tierFired: row.tier_fired,
    model: row.model,
    ...(listing !== undefined ? { listing } : {}),
  };
}
