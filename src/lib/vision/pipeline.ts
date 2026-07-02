import type { SupabaseClient } from "@supabase/supabase-js";
import { priceToConfidence } from "../confidence/from-price";
import type { ItemSignal, PriceResult } from "../pricing";
import { createDefaultPricer } from "../pricing/default-pricer";
import { generateEbayListing, createRealFewShotRetrieval } from "../listing";
import type {
  ExtractedAttributes,
  ListingCopy,
  Pipeline,
  PipelineInput,
  PipelineResult,
} from "../pipeline/types";
import { attributesToSignal } from "../pipeline/stub";
import {
  extractItemAttributes,
  type VisionGenerate,
  type VisionImageInput,
} from "./extract";
import { resolvePhotoImageData, type DownloadClient } from "./photos";

/**
 * The real vision pipeline (issue #6, integrated with #8 pricing + #9 listing).
 * Implements the SAME `Pipeline` seam as the walking-skeleton stub, so it drops into
 * `runPipelineAndPersist` as the injected 3rd arg with zero changes to the persistence
 * layer or callers.
 *
 *   photos[] → (inline bytes) → SINGLE multimodal extraction → attributes + flagged
 *   identification → REAL pricing (PriceRouter: all five PRD tiers) → REAL
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
   * Price an item signal. Defaults to the REAL `PriceRouter` over all five PRD
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
  }) => Promise<{ copy: ListingCopy; model: string }>;
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
}) => Promise<{ copy: ListingCopy; model: string }> {
  return async ({ attributes }) => {
    const { copy, model } = await generateEbayListing({
      attributes,
      retrieve: createRealFewShotRetrieval(),
    });
    return { copy, model };
  };
}

/**
 * Construct a `Pipeline` whose `run` performs real vision extraction, real pricing
 * (PriceRouter: all five PRD tiers via `createDefaultPricer`), and real grounded
 * eBay listing generation. `supabase` signs the private photo URLs; all
 * model/network deps are injectable for offline tests, defaulting to the real
 * implementations.
 */
export function createVisionPipeline(
  options: CreateVisionPipelineOptions,
): Pipeline {
  const { supabase, model } = options;
  const extract = options.extract ?? extractItemAttributes;
  const priceItem = options.priceItem ?? createDefaultPricer();
  const generateListing =
    options.generateListing ?? createDefaultListingGenerator();

  return {
    async run(input: PipelineInput): Promise<PipelineResult> {
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
      const { attributes, identification } = extraction;

      // 3. REAL pricing (PriceRouter) + REAL grounded eBay listing generation. The
      //    listing carries its own model id (may differ from the vision model), logged
      //    for provenance so listing experiments stay attributable (#32).
      const signal = attributesToSignal(attributes);
      const price = await priceItem(signal);
      const { copy: listing, model: listingModel } = await generateListing({
        attributes,
      });

      // 4. REAL confidence composite over deterministic signals (tier #31-calibrated;
      //    the model's self-reported ambiguity stays out of the score — it only flags
      //    the user-facing identification). The same `priceToConfidence` bridge a
      //    re-price (clarify-variant) reuses, so the two can never miscalibrate.
      const confidence = priceToConfidence(attributes, price, {
        autopilotEnabled: input.autopilotEnabled,
      });

      return {
        attributes,
        price,
        confidence,
        listing,
        model: extraction.model,
        // The listing model is logged separately so a prediction's listing copy stays
        // attributable even when LISTING_MODEL differs from the vision model (#32).
        listingModel,
        // Pricing-model provenance (same precedent): the web tiers resolve their own
        // PRICING_MODEL for comp extraction and stamp it on the price result; a
        // deterministic tier (ISBN lookup) leaves it unset → logged as null (#10 review).
        pricingModel: price.model,
        identification,
      };
    },
  };
}
