import type { SupabaseClient } from "@supabase/supabase-js";
import { priceToConfidence } from "../confidence/from-price";
import type { ItemSignal, PriceResult } from "../pricing";
import { createDefaultPricer } from "../pricing/default-pricer";
import { generateEbayListing, createRealFewShotRetrieval } from "../listing";
import type {
  ExtractedAttributes,
  Identification,
  ListingCopy,
  Pipeline,
  PipelineInput,
  PipelineResult,
  SellerContext,
} from "../pipeline/types";
import { attributesToSignal } from "../pipeline/stub";
import {
  extractItemAttributes,
  type VisionGenerate,
  type VisionImageInput,
} from "./extract";
import {
  extractGarmentMeasurements,
  garmentClassOf,
  listingFactAttributes,
  type MeasureGenerate,
  type MeasurementDraft,
} from "./measurements";
import { resolvePhotoImageData, type DownloadClient } from "./photos";
import { logEvent } from "../observability";

/**
 * The real vision pipeline (issue #6, integrated with #8 pricing + #9 listing).
 * Implements the SAME `Pipeline` seam as the walking-skeleton stub, so it drops into
 * `runPipelineAndPersist` as the injected 3rd arg with zero changes to the persistence
 * layer or callers.
 *
 *   photos[] → (inline bytes) → SINGLE multimodal extraction → attributes + flagged
 *   identification → REAL pricing (PriceRouter: all six PRD tiers) → REAL
 *   grounded eBay listing → REAL, #31-calibrated confidence composite → result.
 *
 * Every model/network dependency (extraction, pricing, listing, retrieval) is injectable
 * so the contract tests run fully offline; the defaults are the real implementations.
 */

export interface CreateVisionPipelineOptions {
  /** User-scoped server client used to download the private photo bytes (RLS-scoped). */
  supabase: SupabaseClient | DownloadClient;
  /** Injected extraction (defaults to the real `extractItemAttributes`). */
  extract?: typeof extractItemAttributes;
  /** Injected model call forwarded to the default extraction (tests pass a fake). */
  generate?: VisionGenerate;
  /** Model id override forwarded to extraction (else env / default). */
  model?: string;
  /**
   * Injected measurement extraction (issue #104). Defaults to the real
   * `extractGarmentMeasurements`; runs ONLY for garments and is best-effort — a
   * failure never breaks the run (measurements are an auxiliary draft, off the
   * critical path). Tests inject a fake to run offline.
   */
  measure?: typeof extractGarmentMeasurements;
  /** Injected measurement model call forwarded to the default measurement extraction. */
  measureGenerate?: MeasureGenerate;
  /**
   * Price an item signal. Defaults to the REAL `PriceRouter` over all six PRD
   * tiers (`createDefaultPricer`). Injected in tests so pricing runs offline.
   */
  priceItem?: (signal: ItemSignal) => Promise<PriceResult>;
  /**
   * Generate the listing copy from the attribute core. Defaults to the REAL grounded
   * eBay generator (`generateEbayListing` + rag few-shot). Returns the copy AND the
   * model that produced it — the listing model is logged for provenance (it may differ
   * from the vision model via `LISTING_MODEL`), so it must not be dropped (#32 review).
   * Injected in tests.
   */
  generateListing?: (args: {
    attributes: ExtractedAttributes;
    sellerContext?: SellerContext;
  }) => Promise<{ copy: ListingCopy; model: string }>;
}

export interface IdentifiedVisionPipelineStage {
  attributes: ExtractedAttributes;
  identification?: Identification;
  model: string;
}

export interface GeneratedVisionPipelineStage {
  copy: ListingCopy;
  model: string;
}

/**
 * The existing TypeScript pipeline split into resumable stage seams. The normal
 * request pipeline and the durable worker both compose these exact operations;
 * no vision, pricing, confidence, or listing logic is copied into the worker.
 */
export interface VisionPipelineStages {
  run(input: PipelineInput): Promise<PipelineResult>;
  identify(input: { photos: string[] }): Promise<IdentifiedVisionPipelineStage>;
  price(input: { attributes: ExtractedAttributes }): Promise<PriceResult>;
  generate(input: {
    attributes: ExtractedAttributes;
    sellerContext?: SellerContext;
  }): Promise<GeneratedVisionPipelineStage>;
  assemble(input: {
    identified: IdentifiedVisionPipelineStage;
    price: PriceResult;
    generated: GeneratedVisionPipelineStage;
    autopilotEnabled?: boolean;
  }): PipelineResult;
}

// ---------------------------------------------------------------------------
// Real pricing + listing wiring. The pricing composition root (`createDefaultPricer`)
// lives in `pricing/default-pricer.ts`; the #31/#32/#60 confidence calibration
// bridge (`priceToConfidence`) lives in `confidence/from-price.ts`. This module
// only composes them with vision extraction + grounded listing generation.
// ---------------------------------------------------------------------------

/**
 * The default real listing generator: grounded eBay generation (#9) → `ListingCopy`
 * PLUS the model id that produced it. The listing model is carried out (not dropped)
 * so the run can log it for provenance — it may differ from the vision model via
 * `LISTING_MODEL` (#32 review).
 */
function createDefaultListingGenerator(): (args: {
  attributes: ExtractedAttributes;
  sellerContext?: SellerContext;
}) => Promise<{ copy: ListingCopy; model: string }> {
  return async ({ attributes, sellerContext }) => {
    const { copy, model } = await generateEbayListing({
      attributes,
      ...(sellerContext ? { sellerContext } : {}),
      retrieve: createRealFewShotRetrieval(),
    });
    return { copy, model };
  };
}

/**
 * Construct a `Pipeline` whose `run` performs real vision extraction, real pricing
 * (PriceRouter: all six PRD tiers via `createDefaultPricer`), and real grounded
 * eBay listing generation. `supabase` signs the private photo URLs; all
 * model/network deps are injectable for offline tests, defaulting to the real
 * implementations.
 */
export function createVisionPipelineStages(
  options: CreateVisionPipelineOptions,
): VisionPipelineStages {
  const { supabase, model } = options;
  const extract = options.extract ?? extractItemAttributes;
  const measure = options.measure ?? extractGarmentMeasurements;
  const priceItem = options.priceItem ?? createDefaultPricer();
  const generateListing =
    options.generateListing ?? createDefaultListingGenerator();

  interface PendingIdentification {
    baseAttributes: ExtractedAttributes;
    identification?: Identification;
    model: string;
    measurements: Promise<MeasurementDraft[]>;
  }

  const beginIdentification = async (input: {
    photos: string[];
  }): Promise<PendingIdentification> => {
    if (input.photos.length === 0) {
      throw new Error("Vision pipeline requires at least one photo path");
    }

    // 1. Download the private Storage objects as inline BYTES for the model. We
    //    inline rather than hand the model a signed URL: the dev provider (Gemini)
    //    can't fetch remote URLs — the AI SDK downloads them and blocks private/
    //    loopback hosts like local Storage at 127.0.0.1 — and inlining also drops a
    //    prod dependency on the provider fetching a short-TTL URL. RLS still scopes it.
    const images: VisionImageInput[] = await resolvePhotoImageData(
      supabase,
      input.photos,
    );

    // 2. SINGLE multimodal extraction → validated attributes + flagged identification.
    const extraction = await extract({
      images,
      generate: options.generate,
      model,
    });
    // 2b. GARMENT MEASUREMENTS (issue #104) — only for clothing and best-effort.
    //     A second gated vision call (same `vision` registry role) estimates flat-lay
    //     measurements, auto-suggesting ONLY the four listing-grade ones and REFUSING
    //     inseam/sleeve unless a tape is visible. The unconfirmed drafts feed NEITHER
    //     pricing (`attributesToSignal` ignores them) NOR listing generation — the
    //     listing model is shown ONLY confirmed facts, so an AI-estimated measurement
    //     the seller hasn't vouched for can never surface in the publishable copy
    //     (#104's confirmed-on-review guarantee). They ride on the persisted
    //     `attributes` for the review screen alone. Any failure is logged and swallowed
    //     so a garment still gets its price + listing.
    const baseAttributes = extraction.attributes;
    const garmentClass = garmentClassOf(baseAttributes);
    const measurements: Promise<MeasurementDraft[]> = garmentClass
      ? measure({
          images,
          garmentClass,
          garmentType: baseAttributes.category ?? baseAttributes.title,
          generate: options.measureGenerate,
          model,
        })
          .then((measured) => measured.measurements)
          .catch((err) => {
            logEvent("pipeline.measure_failed", {
              garmentClass,
              error: err instanceof Error ? err.message : String(err),
            });
            return [];
          })
      : Promise.resolve([]);

    return {
      baseAttributes,
      identification: extraction.identification,
      model: extraction.model,
      measurements,
    };
  };

  const finishIdentification = async (
    pending: PendingIdentification,
  ): Promise<IdentifiedVisionPipelineStage> => {
    const completedMeasurements = await pending.measurements;

    // The unconfirmed measurement drafts ride on the PERSISTED attributes only — the
    // review screen is where the seller confirms them; they were never serialized into
    // the listing copy generated above.
    const attributes: ExtractedAttributes =
      completedMeasurements.length > 0
        ? {
            ...pending.baseAttributes,
            measurements: completedMeasurements,
          }
        : pending.baseAttributes;

    return {
      attributes,
      identification: pending.identification,
      model: pending.model,
    };
  };

  const price = async ({ attributes }: { attributes: ExtractedAttributes }) =>
    priceItem(attributesToSignal(attributes));

  const generate: VisionPipelineStages["generate"] = async ({
    attributes,
    sellerContext,
  }) =>
    generateListing({
      attributes: listingFactAttributes(attributes),
      ...(sellerContext ? { sellerContext } : {}),
    });

  const assemble: VisionPipelineStages["assemble"] = ({
    identified,
    price: priceResult,
    generated,
    autopilotEnabled,
  }) => {
    const { copy: listing, model: listingModel } = generated;

    // 4. REAL confidence composite over deterministic signals (tier #31-calibrated;
    //    the model's self-reported ambiguity stays out of the score — it only flags
    //    the user-facing identification). The same `priceToConfidence` bridge a
    //    re-price (clarify-variant) reuses, so the two can never miscalibrate.
    const confidence = priceToConfidence(identified.attributes, priceResult, {
      autopilotEnabled,
    });

    return {
      attributes: identified.attributes,
      price: priceResult,
      confidence,
      listing,
      model: identified.model,
      // The listing model is logged separately so a prediction's listing copy stays
      // attributable even when LISTING_MODEL differs from the vision model (#32).
      listingModel,
      // Pricing-model provenance (same precedent): the web tiers resolve their own
      // PRICING_MODEL for comp extraction and stamp it on the price result; a
      // deterministic tier (ISBN lookup) leaves it unset → logged as null (#10 review).
      pricingModel: priceResult.model,
      identification: identified.identification,
    };
  };

  return {
    async run(input) {
      const pending = await beginIdentification({ photos: input.photos });
      // Preserve the request pipeline's established latency contract: pricing,
      // listing generation, and auxiliary measurement extraction overlap. The
      // durable stage seam awaits measurements only so its identify checkpoint is
      // complete and reusable after a crash.
      const [priceResult, generated, identified] = await Promise.all([
        price({ attributes: pending.baseAttributes }),
        generate({ attributes: pending.baseAttributes }),
        finishIdentification(pending),
      ]);
      return assemble({
        identified,
        price: priceResult,
        generated,
        autopilotEnabled: input.autopilotEnabled,
      });
    },

    async identify(input) {
      return finishIdentification(await beginIdentification(input));
    },

    price,
    generate,
    assemble,
  };
}

export function createVisionPipeline(
  options: CreateVisionPipelineOptions,
): Pipeline {
  const stages = createVisionPipelineStages(options);
  return {
    run: (input: PipelineInput): Promise<PipelineResult> => stages.run(input),
  };
}
