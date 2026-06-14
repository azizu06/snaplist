import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeConfidence,
  type ConfidenceSignals,
} from "../confidence/confidence";
import {
  PriceRouter,
  createIsbnPricingProvider,
  createEbaySoldPricingProvider,
  createUpcWebPricingProvider,
  createBrandedWebPricingProvider,
  createDepreciationPricingProvider,
  createLlmOnlyPricingProvider,
  type DepreciationPricingProviderOptions,
  type EbaySoldPricingProviderOptions,
  type IsbnPricingProviderOptions,
  type ItemSignal,
  type LlmOnlyPricingProviderOptions,
  type PriceResult,
  type WebSearchPricingProviderOptions,
} from "../pricing";
import { generateEbayListing, createRealFewShotRetrieval } from "../listing";
import type {
  ExtractedAttributes,
  ListingCopy,
  Pipeline,
  PipelineInput,
  PipelineResult,
} from "../pipeline/types";
import { attributesToSignal } from "../pipeline/stub";
import { TIGHT_AGREEMENT_MIN } from "../pricing/providers/web-search";
import {
  extractItemAttributes,
  type VisionGenerate,
  type VisionImageInput,
} from "./extract";
import { resolvePhotoImages, type SignedUrlClient } from "./photos";

/**
 * The real vision pipeline (issue #6, integrated with #8 pricing + #9 listing).
 * Implements the SAME `Pipeline` seam as the walking-skeleton stub, so it drops into
 * `runPipelineAndPersist` as the injected 3rd arg with zero changes to the persistence
 * layer or callers.
 *
 *   photos[] → (signed URLs) → SINGLE multimodal extraction → attributes + flagged
 *   identification → REAL pricing (PriceRouter: all five PRD tiers) → REAL
 *   grounded eBay listing → REAL, #31-calibrated confidence composite → result.
 *
 * Every model/network dependency (extraction, pricing, listing, retrieval) is injectable
 * so the contract tests run fully offline; the defaults are the real implementations.
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
// Real pricing + listing wiring (#8 ISBN tier + #9 grounded listing integrated;
// #31 confidence calibration for retail-derived ISBN prices; #11 fallback tiers).
// ---------------------------------------------------------------------------

/**
 * Per-tier dependency overrides for `createDefaultPricer`. Production passes
 * nothing (every tier defaults to its real network/model deps); tests inject
 * fakes per tier so the FULL PRD-order fallthrough runs offline.
 */
export interface CreateDefaultPricerOptions {
  /** Tier-1 ISBN lookup deps (offline tests inject `fetchJson`). */
  isbn?: IsbnPricingProviderOptions;
  /** eBay-sold scraper deps (offline tests inject `fetchPage`; #56). */
  ebaySold?: EbaySoldPricingProviderOptions;
  /** Web-search agent deps (shared by the UPC-aided and branded tiers). */
  webSearch?: WebSearchPricingProviderOptions;
  /** Tier-4 depreciation deps (retail search + extraction). */
  depreciation?: DepreciationPricingProviderOptions;
  /** Tier-5 LLM-only estimator deps. */
  llmOnly?: LlmOnlyPricingProviderOptions;
}

/**
 * The default real pricer in PRD priority order: ISBN structured lookup, then the
 * #56 eBay PUBLIC sold-comps scraper (real completed sales — the strongest used
 * signal, declining gracefully when disabled/blocked), then the #10 web-search
 * agent tiers (UPC-aided → branded; Tavily/Exa + comp extraction, env-key gated —
 * a keyless deployment makes those tiers decline gracefully), then the #11 fallback
 * tiers: depreciation (retail anchor × condition factor, low confidence) and last
 * the LLM-only floor, which never declines — so the router always returns a
 * schema-valid price. Exported so the fallthrough ORDER itself is testable
 * end-to-end with injected fakes.
 */
export function createDefaultPricer(
  options: CreateDefaultPricerOptions = {},
): (signal: ItemSignal) => Promise<PriceResult> {
  const router = new PriceRouter([
    createIsbnPricingProvider(options.isbn),
    createEbaySoldPricingProvider(options.ebaySold),
    createUpcWebPricingProvider(options.webSearch),
    createBrandedWebPricingProvider(options.webSearch),
    createDepreciationPricingProvider(options.depreciation),
    createLlmOnlyPricingProvider(options.llmOnly),
  ]);
  return (signal) => router.price(signal);
}

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

/** Does this price cite a real SOLD comp (vs only catalog/asking lookups)? */
function hasSoldComp(price: PriceResult): boolean {
  return price.sources.some((s) => s.kind === "sold-comp");
}

/**
 * Map the firing PRICING tier onto the CONFIDENCE vocabulary — they are distinct sets
 * (`isbn-lookup`/`branded-web`/… vs `isbn`/`web_tight`/…); this bridges them.
 *
 * #31 calibration: an `isbn-lookup` price backed ONLY by catalog lookups (Open Library /
 * Google Books — no sold comp) is a retail-DERIVED estimate, not a comped price, so we
 * trust it at the `depreciation` level (0.4), NOT the top `isbn` tier (0.95). A book
 * priced off new-retail therefore can't reach the autopilot-eligible band on identity
 * alone; the ISBN identity still feeds the identification signals. A future sold-comp
 * source (web tier) restores the high `isbn` trust.
 *
 * #32 calibration (same principle, web tier): the pricing contract permits `branded-web`
 * to cite asking-only / scattered sources, so it does NOT automatically deserve the tight
 * (high-trust) `web_tight` tier. Earn `web_tight` ONLY with a real sold comp; otherwise
 * map to `web_wide`. Without this, a fully-identified branded item with a single asking
 * comp scores 0.6·0.8 + 0.25·1 + 0.15·0.4 = 0.79 and clears the 0.75 autopilot gate with
 * no sold comp or demonstrated clustering; `web_wide` lands it at 0.67, safely sub-gate.
 */
function pricingTierToConfidenceTier(
  price: PriceResult,
): ConfidenceSignals["tier"] {
  switch (price.tier) {
    case "isbn-lookup":
      return hasSoldComp(price) ? "isbn" : "depreciation";
    case "ebay-sold":
      // eBay sold comps are completed sales — sold-grounded by construction, so
      // the only question is tightness. A tight cluster earns the high-trust
      // web_tight bucket; a scattered sold set stays web_wide (real evidence of
      // *a* market, not a defensible tight price). #60 calibrates this against
      // the gold set and may give the sold tier its own bucket above web_tight.
      return tightAgreement(price) ? "web_tight" : "web_wide";
    case "upc-aided-web":
      return "web_wide";
    case "branded-web":
      // #10 round-4 calibration: web_tight needs BOTH sold grounding AND the
      // provider's judged tight agreement. A scattered sold set ($60/$185/$420)
      // is real evidence of *a* market but not of a defensible tight price —
      // it stays web_wide and cannot ride the sold-comp label past the
      // autopilot gate. Providers that don't report agreement (e.g. injected
      // test pricers) keep the sold-comp-only behavior.
      return hasSoldComp(price) && tightAgreement(price)
        ? "web_tight"
        : "web_wide";
    case "depreciation":
      return "depreciation";
    case "llm-only":
    default:
      return "llm_only";
  }
}

/** Did the provider judge its comp cluster tight? (Unreported = no objection.) */
function tightAgreement(price: PriceResult): boolean {
  return price.compAgreement == null || price.compAgreement >= TIGHT_AGREEMENT_MIN;
}

/**
 * Without sold grounding, judged agreement is capped here: a tight cluster of
 * ASKING prices proves sellers agree on what to ask, not what buyers pay, so
 * it must not push a no-sold-comp item over the autopilot gate (full-id
 * asking-only would otherwise score 0.6·0.6 + 0.25·1 + 0.15·1 = 0.76 ≥ 0.75).
 * 0.4 matches the conservative no-sold constant below: full-id asking-only
 * tops out at 0.67, safely sub-gate.
 */
const ASKING_AGREEMENT_CAP = 0.4;

/**
 * Comp-agreement signal for the confidence composite: the provider's own
 * judged agreement when reported (the web tiers measure relative spread) —
 * capped without sold grounding — else the conservative constants for
 * providers without a comp cluster.
 */
function compAgreementFor(price: PriceResult): number {
  if (price.compAgreement != null) {
    return hasSoldComp(price)
      ? price.compAgreement
      : Math.min(price.compAgreement, ASKING_AGREEMENT_CAP);
  }
  if (hasSoldComp(price)) return 0.7;
  return price.sources.length > 0 ? 0.4 : 0.3;
}

/**
 * Build the confidence input from DETERMINISTIC signals: the firing tier (mapped +
 * #31-calibrated), a conservative comp-agreement, and extracted-evidence identification
 * booleans. NEVER the model's self-reported `ambiguous` flag — that stays a user-facing
 * identification warning, not a score input (issue #3, signal-based composite).
 */
function confidenceSignalsFor(
  attributes: ExtractedAttributes,
  price: PriceResult,
): ConfidenceSignals {
  return {
    tier: pricingTierToConfidenceTier(price),
    compAgreement: compAgreementFor(price),
    identification: {
      brandResolved: attributes.brand != null,
      modelResolved: attributes.model != null,
      barcodeDecoded: attributes.upc != null || attributes.isbn != null,
      categoryUnambiguous: attributes.category != null,
    },
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
      //    the user-facing identification).
      const confidence = computeConfidence(
        confidenceSignalsFor(attributes, price),
        { autopilotEnabled: input.autopilotEnabled ?? true },
      );

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
