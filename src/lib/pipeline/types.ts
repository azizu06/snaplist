import { z } from "zod";
import { priceResultSchema, type PriceResult } from "../pricing";
import type { ConfidenceResult } from "../confidence/confidence";
import { measurementDraftsSchema } from "../vision/measurements";

export const sellerContextSchema = z
  .object({
    text: z.string().min(1).max(4_096),
    language: z.string().min(1).max(255).nullable(),
    provenance: z.literal("seller_voice"),
    verification: z.literal("unverified"),
  })
  .strict();

export type SellerContext = z.infer<typeof sellerContextSchema>;

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
  /**
   * Garment flat-lay measurements (issue #104), present ONLY for clothing. Each is
   * a DRAFT the seller confirms on review — never silently auto-filled into item
   * specifics — and carries its own tolerance band + provenance (`method`). Stored
   * here (the established attribute surface) so it inherits the item's RLS and rides
   * into `prediction_logs.extracted_attrs`; DELIBERATELY excluded from the
   * confidence composite (a weak, vision-only signal — see `confidence/from-price`).
   */
  measurements: measurementDraftsSchema.optional(),
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

/**
 * "What we think it is" — the identification surfaced to the user BEFORE pricing
 * (issue #6 acceptance: identification surfaced for confirmation; ambiguous /
 * low-evidence ids are FLAGGED, not silently guessed).
 *
 * `confident` is derived from how many STRONG identifiers the vision step resolved
 * (brand, model, decoded barcode/ISBN/UPC, an unambiguous category) — never from
 * raw model self-report (mirrors the confidence composite's signal-based stance).
 * When evidence is thin or the model signals uncertainty, `confident` is false and
 * `reason` explains why; `candidates` may list plausible alternatives so the user
 * can disambiguate rather than the system guessing.
 */
export const identificationSchema = z.object({
  /** Best-guess human label for the item (e.g. "Sony WH-1000XM4 Headphones"). */
  label: z.string(),
  /** True only when enough strong identifiers resolved AND the model wasn't uncertain. */
  confident: z.boolean(),
  /** How many strong identifiers (brand/model/barcode/category) resolved, in [0,1]. */
  evidence: z.number().min(0).max(1),
  /** Human-readable "why we're unsure" when `confident` is false. */
  reason: z.string().optional(),
  /** Plausible alternatives surfaced for disambiguation instead of guessing. */
  candidates: z.array(z.string()).optional(),
});

export type Identification = z.infer<typeof identificationSchema>;

/** What the pipeline is handed: stored photo paths + the publish-eligibility toggle. */
export interface PipelineInput {
  /** Storage object paths (under the private `photos` bucket), scoped by user_id. */
  photos: string[];
  /** Publish-eligibility switch (legacy name). Forwarded to the confidence gate. */
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
  /** Composite confidence + band + publish-eligibility decision. */
  confidence: z.object({
    score: z.number().min(0).max(1),
    band: z.enum(["high", "medium", "low"]),
    autopilotEligible: z.boolean(),
  }),
  listing: listingCopySchema,
  /** The model id used for the run (the vision/identification model). Logged for evaluation. */
  model: z.string(),
  /**
   * The model that produced the LISTING copy, logged for provenance. OPTIONAL: the stub
   * and any vision-only path don't set it, and it may equal `model` when one model serves
   * the whole run. Kept distinct so listing experiments stay attributable (#32).
   */
  listingModel: z.string().optional(),
  /**
   * The model that produced the PRICE (the web tiers' comp extractor, via
   * `PRICING_MODEL`), logged for provenance. OPTIONAL: deterministic pricing
   * tiers (ISBN lookup) and the stub involve no pricing LLM (#10 review).
   */
  pricingModel: z.string().optional(),
  /**
   * "What we think it is", surfaced before pricing. OPTIONAL so the walking-skeleton
   * stub (which predates the real vision slice) still satisfies the contract.
   */
  identification: identificationSchema.optional(),
});

export type PipelineResult = {
  attributes: ExtractedAttributes;
  price: PriceResult;
  confidence: ConfidenceResult;
  listing: ListingCopy;
  model: string;
  /** The model that produced the listing copy, logged for provenance (#32). OPTIONAL. */
  listingModel?: string;
  /**
   * The model that produced the price, logged for provenance (#10 review). OPTIONAL:
   * unset when no LLM was involved in pricing (deterministic ISBN lookup, the stub).
   */
  pricingModel?: string;
  /**
   * "What we think it is" for user confirmation before pricing. OPTIONAL: the stub
   * does not produce it, so its existing return still type-checks (issue #6 rule).
   */
  identification?: Identification;
};

/**
 * The pipeline seam. ONE method: photos in, a full priced+written listing out.
 * Every AI layer lives behind this — swapping `StubPipeline` for the real
 * composed pipeline is a one-line change at the call site.
 */
export interface Pipeline {
  run(input: PipelineInput): Promise<PipelineResult>;
}
