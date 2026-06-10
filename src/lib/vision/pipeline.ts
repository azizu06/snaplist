import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeConfidence,
  type ConfidenceSignals,
} from "../confidence/confidence";
import { priceResultSchema, type PriceResult } from "../pricing";
import type {
  ExtractedAttributes,
  ListingCopy,
  Pipeline,
  PipelineInput,
  PipelineResult,
} from "../pipeline/types";
import {
  extractItemAttributes,
  type ExtractItemAttributesResult,
  type VisionGenerate,
  type VisionImageInput,
} from "./extract";
import { resolvePhotoImages, type SignedUrlClient } from "./photos";

/**
 * The real vision pipeline (issue #6). Implements the SAME `Pipeline` seam as the
 * walking-skeleton stub, so it drops into `runPipelineAndPersist` as the injected
 * 3rd arg with zero changes to the persistence layer or callers.
 *
 *   photos[] → (signed URLs) → SINGLE multimodal extraction → attributes + flagged
 *   identification → [price + listing stubs] → REAL confidence composite → result.
 *
 * Price and listing are LATER slices (#? pricing router, #? listing generator). This
 * slice does NOT import the private stub functions (another agent owns stub.ts);
 * instead it re-implements minimal, schema-valid `PriceResult` / `ListingCopy` locally
 * so the end-to-end thread is provable now and the real tiers swap in later. Only the
 * VISION half and the REAL confidence composite are wired for real here.
 */

export interface CreateVisionPipelineOptions {
  /** User-scoped server client used to sign the private photo URLs. */
  supabase: SupabaseClient | SignedUrlClient;
  /** Injected extraction (defaults to the real `extractItemAttributes`). */
  extract?: typeof extractItemAttributes;
  /** Injected model call forwarded to the default extraction (tests pass a fake). */
  generate?: VisionGenerate;
  /** Model id override forwarded to extraction (else env / default). */
  model?: string;
}

/**
 * Minimal, schema-valid price placeholder until the pricing-router slice lands. It is
 * validated against the REAL `priceResultSchema` so it can never drift from the seam,
 * and is honestly the lowest-trust tier so confidence reflects "not yet priced for
 * real". The real `PriceRouter` replaces this without changing this file's shape.
 */
function placeholderPrice(): PriceResult {
  return priceResultSchema.parse({
    suggested: 0,
    range: { min: 0, max: 0 },
    confidence: 0.2,
    sources: [],
    tier: "llm-only",
  } satisfies PriceResult);
}

/** Minimal listing copy from the validated attributes (real generator lands later). */
function placeholderListing(
  attributes: ExtractedAttributes,
  identificationLabel: string,
): ListingCopy {
  const title = attributes.title ?? identificationLabel;
  const condition = attributes.condition ?? "used";
  const specs = attributes.specs ?? [];
  return {
    platform: "ebay",
    title,
    description:
      `${title} in ${condition} condition.` +
      (specs.length > 0 ? ` Features: ${specs.join(", ")}.` : ""),
    fields: {
      brand: attributes.brand,
      model: attributes.model,
      category: attributes.category,
      condition: attributes.condition,
      tags: specs,
    },
  };
}

/**
 * Map the firing pricing tier onto the confidence vocabulary. The placeholder price
 * is the LLM-only fallback, so confidence is driven mostly by identification here —
 * exactly the honest story for a not-yet-priced item.
 */
function pricingTierToConfidenceTier(): ConfidenceSignals["tier"] {
  return "llm_only";
}

/**
 * Build the confidence input from the REAL extraction signals. The identification
 * booleans read the SAME resolved fields the `Identification` did, so "what we think
 * it is" and the composite score stay consistent (no second source of truth).
 */
function confidenceSignalsFor(
  extraction: ExtractItemAttributesResult,
): ConfidenceSignals {
  const { attributes } = extraction;
  return {
    tier: pricingTierToConfidenceTier(),
    // No comp set yet (placeholder price) → a neutral, lightly-weighted value.
    compAgreement: 0.5,
    identification: {
      brandResolved: attributes.brand != null,
      modelResolved: attributes.model != null,
      barcodeDecoded: attributes.upc != null || attributes.isbn != null,
      categoryUnambiguous:
        attributes.category != null && extraction.identification.confident,
    },
  };
}

/**
 * Construct a `Pipeline` whose `run` performs real vision extraction. `supabase` signs
 * the private photo URLs; `extract`/`generate`/`model` are injectable for offline tests.
 */
export function createVisionPipeline(
  options: CreateVisionPipelineOptions,
): Pipeline {
  const { supabase, model } = options;
  const extract = options.extract ?? extractItemAttributes;

  return {
    async run(input: PipelineInput): Promise<PipelineResult> {
      if (input.photos.length === 0) {
        throw new Error("Vision pipeline requires at least one photo path");
      }

      // 1. Resolve the private Storage paths to signed URLs the model can fetch.
      const urls = await resolvePhotoImages(supabase, input.photos);
      const images: VisionImageInput[] = urls;

      // 2. SINGLE multimodal extraction → validated attributes + flagged identification.
      const extraction = await extract({
        images,
        generate: options.generate,
        model,
      });
      const { attributes, identification } = extraction;

      // 3. Price + listing placeholders (later slices replace these; shapes are real).
      const price = placeholderPrice();
      const listing = placeholderListing(attributes, identification.label);

      // 4. REAL confidence composite over the real identification signals.
      const confidence = computeConfidence(confidenceSignalsFor(extraction), {
        autopilotEnabled: input.autopilotEnabled ?? true,
      });

      return {
        attributes,
        price,
        confidence,
        listing,
        model: extraction.model,
        identification,
      };
    },
  };
}
