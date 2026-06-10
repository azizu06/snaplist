import { z } from "zod";
import { priceResultSchema, type PriceResult } from "../pricing";
import type { ConfidenceResult } from "../confidence/confidence";

/**
 * The listing-and-pricing pipeline seam (PRD Phase 1: "photo → vision identify +
 * attributes → pricing → generated listing → review/edit → persist").
 *
 * This module defines ONLY the contract — the boundary where the real
 * vision-extraction, pricing-router, and listing-generation slices swap in. The
 * walking-skeleton `StubPipeline` (stub.ts) is the first implementation; later
 * slices replace it WITHOUT changing this interface or its callers (the
 * persistence layer + the upload route).
 *
 * Composition the seam encodes (so later slices know exactly what to fill in):
 *   1. photos[]            → ExtractedAttributes      (real: AI SDK vision call)
 *   2. ExtractedAttributes → ItemSignal               (pure mapping, here)
 *   3. ItemSignal          → PriceResult              (real: PriceRouter + tiers)
 *   4. price + id signals  → ConfidenceResult         (computeConfidence — REAL already)
 *   5. attributes + price  → ListingCopy              (real: per-platform LLM generation)
 */

/**
 * The structured facts the vision step extracts from the photos (CONTEXT.md
 * "Attributes"). Deliberately a superset that maps cleanly onto the pricing
 * `ItemSignal` and the confidence identification signals. The stub fills canned
 * values; the real vision slice fills these from a Zod-validated `generateObject`
 * call over the images. Optional everywhere because a generic item resolves few.
 */
export const extractedAttributesSchema = z.object({
  brand: z.string().optional(),
  model: z.string().optional(),
  category: z.string().optional(),
  /** Assessed wear state — first-class because it drives pricing (CONTEXT.md "Condition"). */
  condition: z.string().optional(),
  /** Decoded ISBN (books/media) — routes to the structured ISBN lookup tier. */
  isbn: z.string().optional(),
  /** Decoded UPC — an identification/query aid, never a price source (barcode-tier split). */
  upc: z.string().optional(),
  /** Free-form key specs the vision step surfaced (e.g. ["wireless", "noise-cancelling"]). */
  specs: z.array(z.string()).optional(),
  /** A short human title for the item, used to seed listing copy. */
  title: z.string().optional(),
});

export type ExtractedAttributes = z.infer<typeof extractedAttributesSchema>;

/**
 * Generated, platform-specific sale copy (CONTEXT.md "Listing"). One attribute
 * core → many surface renderings; the skeleton emits a single eBay-shaped draft.
 * `fields` carries item-specifics / tags as free-form structured copy, matching
 * the `listings.copy` JSONB column.
 */
export const listingCopySchema = z.object({
  platform: z.string(),
  title: z.string(),
  description: z.string(),
  fields: z.record(z.string(), z.unknown()),
});

export type ListingCopy = z.infer<typeof listingCopySchema>;

/** What the pipeline is handed: the stored photo paths + the autopilot toggle. */
export interface PipelineInput {
  /** Storage object paths (under the private `photos` bucket), scoped by user_id. */
  photos: string[];
  /** Master autopilot switch (User Story 24). Forwarded to the confidence gate. */
  autopilotEnabled?: boolean;
}

/**
 * The full pipeline output. Validated, persistable, and renderable on the review
 * page. `attributes`/`price`/`confidence`/`listing` are exactly the four things a
 * pipeline run produces; `model` and `tier` are logged for the eval harness
 * (PRD non-negotiable: "Log every pipeline run's predictions").
 */
export const pipelineResultSchema = z.object({
  attributes: extractedAttributesSchema,
  price: priceResultSchema,
  /** Composite confidence + band + autopilot decision (from computeConfidence). */
  confidence: z.object({
    score: z.number().min(0).max(1),
    band: z.enum(["high", "medium", "low"]),
    autopilotEligible: z.boolean(),
  }),
  listing: listingCopySchema,
  /** The model id used for the run (stubbed here). Logged for evaluation. */
  model: z.string(),
});

export type PipelineResult = {
  attributes: ExtractedAttributes;
  price: PriceResult;
  confidence: ConfidenceResult;
  listing: ListingCopy;
  model: string;
};

/**
 * The pipeline seam. ONE method: photos in, a full priced+written listing out.
 * Every AI layer lives behind this — swapping `StubPipeline` for the real
 * composed pipeline is a one-line change at the call site.
 */
export interface Pipeline {
  run(input: PipelineInput): Promise<PipelineResult>;
}
