import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExtractedAttributes } from "./types";
import type { PipelineResult } from "./types";
import type { PriceSource } from "../pricing";

/**
 * Prediction logging — the single source of truth for the `prediction_logs` row
 * shape (PRD non-negotiable: "Log every pipeline run's predictions from day one").
 *
 * Every pipeline run records WHAT it predicted (extracted attrs, chosen price +
 * range + confidence) and HOW it got there (which tier fired, which model, the
 * cited comps). That row is the data prerequisite for the eval harness, so this
 * module is deliberately split into:
 *
 *   - `buildPredictionLogRow` — a PURE mapping `PipelineResult` → insert payload.
 *     Unit-testable without a database; it is the one place the row shape lives,
 *     so `logPrediction` (the write) and the eval harness (the read) can never
 *     drift from each other.
 *   - `logPrediction` — performs the insert through the caller's USER-SCOPED
 *     Supabase client so RLS pins tenancy (WITH CHECK (auth.uid() = user_id)).
 *     Throws on error: logging is a PRD non-negotiable and a failure must never be
 *     swallowed.
 *   - `readPredictionLogs` — the minimal read-back helper the eval harness uses;
 *     also user-scoped, so it only ever sees the caller's own rows.
 */

/** The price band persisted on a log row: `{ low, high }` (mirrors `price_range`). */
export interface PredictionLogPriceRange {
  low: number;
  high: number;
}

/**
 * The exact payload inserted into `public.prediction_logs`. Field-for-field with
 * the table columns (init_schema + the sources migration). This is the contract
 * the eval harness reads against, so it is the single source of truth for the row.
 */
export interface PredictionLogRow {
  /** Owning user — must equal the client's `auth.uid()`; RLS pins it. */
  user_id: string;
  /** The item this run priced. */
  item_id: string;
  /** Attributes the vision step extracted for this run. */
  extracted_attrs: ExtractedAttributes;
  /** The single chosen/suggested price. */
  price: number;
  /** The defensible used-price band, persisted as `{ low, high }`. */
  price_range: PredictionLogPriceRange;
  /** Composite confidence score in [0, 1]. */
  confidence: number;
  /** Which pricing tier produced the recommendation (a confidence-bearing fact). */
  tier_fired: string;
  /** The model id used for the run (the vision/identification model). */
  model: string;
  /**
   * The model that produced the listing copy. Distinct from `model` so listing
   * evaluations/experiments stay attributable even when LISTING_MODEL differs from the
   * vision model; falls back to `model` when a single model served the whole run (#32).
   */
  listing_model: string;
  /** Cited comps / lookup records behind the price (may be empty for llm-only). */
  sources: PriceSource[];
}

/**
 * Map a `PipelineResult` to the `prediction_logs` insert payload. PURE: no I/O, no
 * clock, no randomness — so it is unit-testable directly and reproducible in the
 * eval harness. The `id`/`created_at` columns are DB-defaulted and intentionally
 * NOT set here.
 *
 * Mapping (result → column):
 *   attributes        → extracted_attrs
 *   price.suggested   → price
 *   price.range       → price_range { low: min, high: max }
 *   confidence.score  → confidence
 *   price.tier        → tier_fired
 *   model             → model
 *   listingModel      → listing_model  (falls back to model when the run had one model)
 *   price.sources     → sources
 */
export function buildPredictionLogRow(
  userId: string,
  itemId: string,
  result: PipelineResult,
): PredictionLogRow {
  return {
    user_id: userId,
    item_id: itemId,
    extracted_attrs: result.attributes,
    price: result.price.suggested,
    price_range: { low: result.price.range.min, high: result.price.range.max },
    confidence: result.confidence.score,
    tier_fired: result.price.tier,
    model: result.model,
    // The listing's own model when the pipeline produced one; otherwise the run's
    // single model (the stub / vision-only path) so provenance is never null (#32).
    listing_model: result.listingModel ?? result.model,
    // Persist the cited comps so the {suggested, range, confidence, sources[]}
    // contract is complete — rendered for verification, consumed by the eval harness.
    sources: result.price.sources,
  };
}

/**
 * Write the prediction log for one pipeline run through the caller's user-scoped
 * client. THROWS on error — logging is a PRD non-negotiable, so a failed insert is
 * a real error, never a swallowed warning.
 */
export async function logPrediction(
  supabase: SupabaseClient,
  userId: string,
  itemId: string,
  result: PipelineResult,
): Promise<void> {
  const row = buildPredictionLogRow(userId, itemId, result);
  const { error } = await supabase.from("prediction_logs").insert(row);
  if (error) {
    throw new Error(`Failed to write prediction log: ${error.message}`);
  }
}

/** Filters for `readPredictionLogs` (the eval harness's read seam). */
export interface ReadPredictionLogsFilter {
  /** Narrow to a single item's run(s). */
  itemId?: string;
}

/**
 * A `prediction_logs` row as READ BACK from the database: the insert payload plus
 * the DB-defaulted `created_at` timestamp. `created_at` exists only on the read
 * side (it is never set by `buildPredictionLogRow`), and it is what makes the
 * read ordering — and therefore "newest run per item" dedup downstream —
 * deterministic.
 */
export interface PredictionLogReadRow extends PredictionLogRow {
  /** DB-defaulted insert timestamp (ISO 8601), the run-recency ordering key. */
  created_at: string;
}

/**
 * Read prediction-log rows back through the caller's user-scoped client (RLS means
 * the caller only ever sees its own rows). Minimal by design — the eval harness's
 * read seam. Throws on a query error so callers never silently get an empty set.
 *
 * ORDERING CONTRACT: rows are returned ordered by `created_at` ASCENDING
 * (oldest first). PostgREST guarantees no row order without an explicit
 * `order`, so this is what lets consumers that keep the LAST row per item
 * (e.g. the eval harness's `matchPredictions`) deterministically score the
 * NEWEST run instead of an arbitrary historical one.
 */
export async function readPredictionLogs(
  supabase: SupabaseClient,
  filter: ReadPredictionLogsFilter = {},
): Promise<PredictionLogReadRow[]> {
  let query = supabase
    .from("prediction_logs")
    .select(
      "user_id, item_id, extracted_attrs, price, price_range, confidence, tier_fired, model, listing_model, sources, created_at",
    );
  if (filter.itemId !== undefined) {
    query = query.eq("item_id", filter.itemId);
  }
  const { data, error } = await query.order("created_at", { ascending: true });
  if (error) {
    throw new Error(`Failed to read prediction logs: ${error.message}`);
  }
  return (data ?? []) as unknown as PredictionLogReadRow[];
}
