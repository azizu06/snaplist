import type { SupabaseClient } from "@supabase/supabase-js";
import {
  canonicalizeCondition,
  isItemCondition,
  type ItemCondition,
} from "../items/condition";
import { priceToConfidence } from "../confidence/from-price";
import type { ConfidenceResult } from "../confidence/confidence";
import {
  createRealFewShotRetrieval,
  generateEbayListing,
} from "../listing";
import { createDefaultPricer } from "../pricing/default-pricer";
import type { ItemSignal, PriceResult } from "../pricing";
import {
  deriveIdentification,
  garmentClassOf,
  listingFactAttributes,
} from "../vision";
import { buildPredictionLogRow, type PredictionLogRow } from "./prediction-log";
import { attributesToSignal } from "./stub";
import { isReviewRegenerationBlocked } from "./review-regeneration-policy";
import { loadReviewSnapshot } from "./review-snapshot";
import {
  extractedAttributesSchema,
  type ExtractedAttributes,
  type Identification,
  type ListingCopy,
  type PipelineResult,
} from "./types";

/**
 * Seller identity correction + coherent regeneration (issue #126).
 *
 * The expensive/non-deterministic work is compute-first: corrected attributes feed
 * the existing PricingProvider router, calibrated confidence bridge, and grounded
 * listing generator. Only after all three succeed does the store commit the item,
 * eBay listing, and prediction log in one transaction. A failure therefore leaves
 * the seller's last coherent review state untouched.
 */

export const MAX_IDENTITY_FIELD_LENGTH = 120;
export const MAX_RELEVANT_SPECS = 12;
export const MAX_RELEVANT_SPEC_LENGTH = 120;

export interface RawIdentityCorrections {
  brand: unknown;
  model: unknown;
  category: unknown;
  condition: unknown;
  isbn: unknown;
  upc: unknown;
  /** Comma/newline-delimited replacement list, not an additive patch. */
  specifications: unknown;
}

export interface IdentityCorrections {
  brand: string | null;
  model: string | null;
  category: string | null;
  condition: string | null;
  isbn: string | null;
  upc: string | null;
  specs: string[];
}

function boundedText(value: unknown, field: string): string | null {
  if (typeof value !== "string") {
    throw new Error(`Invalid ${field}: expected text.`);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_IDENTITY_FIELD_LENGTH) {
    throw new Error(`${field} must be ${MAX_IDENTITY_FIELD_LENGTH} characters or fewer.`);
  }
  return trimmed;
}

function digitsAndX(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

function hasValidMod10CheckDigit(value: string): boolean {
  if (!/^\d{12,13}$/.test(value)) return false;
  const body = value.slice(0, -1).split("").map(Number);
  const check = Number(value.at(-1));
  const sum = body.reduce(
    (total, digit, index) => total + digit * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return (10 - (sum % 10)) % 10 === check;
}

function hasValidUpcCheckDigit(value: string): boolean {
  if (!/^\d{12}$/.test(value)) return false;
  const body = value.slice(0, -1).split("").map(Number);
  const check = Number(value.at(-1));
  const sum = body.reduce(
    (total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1),
    0,
  );
  return (10 - (sum % 10)) % 10 === check;
}

function hasValidIsbn10(value: string): boolean {
  if (!/^\d{9}[\dX]$/.test(value)) return false;
  const sum = value.split("").reduce((total, char, index) => {
    const digit = char === "X" ? 10 : Number(char);
    return total + digit * (10 - index);
  }, 0);
  return sum % 11 === 0;
}

function parseIsbn(value: unknown): string | null {
  const text = boundedText(value, "ISBN");
  if (!text) return null;
  const normalized = digitsAndX(text);
  const valid =
    (normalized.length === 10 && hasValidIsbn10(normalized)) ||
    (normalized.length === 13 &&
      /^(978|979)/.test(normalized) &&
      hasValidMod10CheckDigit(normalized));
  if (!valid) throw new Error("ISBN must be a valid ISBN-10 or ISBN-13.");
  return normalized;
}

function parseUpc(value: unknown): string | null {
  const text = boundedText(value, "UPC");
  if (!text) return null;
  const normalized = digitsAndX(text);
  if (!hasValidUpcCheckDigit(normalized)) {
    throw new Error("UPC must be a valid 12-digit UPC-A code.");
  }
  return normalized;
}

function parseSpecs(value: unknown): string[] {
  if (typeof value !== "string") {
    throw new Error("Invalid specifications: expected text.");
  }
  const specs: string[] = [];
  const seen = new Set<string>();
  for (const raw of value.split(/[,\n]/)) {
    const spec = raw.trim();
    if (!spec) continue;
    if (spec.length > MAX_RELEVANT_SPEC_LENGTH) {
      throw new Error(
        `Each specification must be ${MAX_RELEVANT_SPEC_LENGTH} characters or fewer.`,
      );
    }
    const key = spec.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    specs.push(spec);
    if (specs.length > MAX_RELEVANT_SPECS) {
      throw new Error(`Use at most ${MAX_RELEVANT_SPECS} specifications.`);
    }
  }
  return specs;
}

/** Validate and normalize the bounded correction form. Blank optional fields clear. */
export function parseIdentityCorrections(
  raw: RawIdentityCorrections,
): IdentityCorrections {
  const conditionText = boundedText(raw.condition, "condition");
  const normalizedCondition = conditionText
    ? canonicalizeCondition(conditionText)
    : null;
  if (normalizedCondition && !isItemCondition(normalizedCondition)) {
    throw new Error("Condition is not a supported used-goods grade.");
  }
  const condition = normalizedCondition as ItemCondition | null;

  return {
    brand: boundedText(raw.brand, "brand"),
    model: boundedText(raw.model, "model"),
    category: boundedText(raw.category, "category"),
    condition,
    isbn: parseIsbn(raw.isbn),
    upc: parseUpc(raw.upc),
    specs: parseSpecs(raw.specifications),
  };
}

function setOrDelete(
  target: Record<string, unknown>,
  key: string,
  value: string | null,
): void {
  if (value == null) delete target[key];
  else target[key] = value;
}

/**
 * Replace every load-bearing identity field. The old vision title is rebuilt so a
 * corrected brand/model cannot be poisoned by stale free-text from the old identity.
 */
export function applyIdentityCorrections(
  current: ExtractedAttributes,
  corrections: IdentityCorrections,
): ExtractedAttributes {
  const next: Record<string, unknown> = { ...current };
  const previousGarmentClass = garmentClassOf(current);

  setOrDelete(next, "brand", corrections.brand);
  setOrDelete(next, "model", corrections.model);
  setOrDelete(next, "category", corrections.category);
  setOrDelete(next, "condition", corrections.condition);
  setOrDelete(next, "isbn", corrections.isbn);
  setOrDelete(next, "upc", corrections.upc);
  next.specs = corrections.specs;

  const identityTitle =
    [corrections.brand, corrections.model].filter(Boolean).join(" ").trim() ||
    corrections.category;
  setOrDelete(next, "title", identityTitle || null);

  const parsed = extractedAttributesSchema.parse(next);
  const nextGarmentClass = garmentClassOf(parsed);
  if (previousGarmentClass !== nextGarmentClass) {
    delete next.measurements;
  }
  return extractedAttributesSchema.parse(next);
}

export interface ReviewRegenerationSnapshot {
  itemId: string;
  reviewRevision: string;
  reviewBlocked: boolean;
  attributes: unknown;
  /** Read for proof/return only. The commit contract intentionally cannot write it. */
  priceOverride: number | string | null;
  listing: {
    id: string;
    runId: string | null;
    status: string | null;
    ebayListingId: string | null;
    ebayStatus: string | null;
  };
  prediction: { model: string | null; autopilotEnabled: boolean | null };
}

export interface ReviewRegenerationCommit {
  itemId: string;
  listingId: string;
  runId: string;
  expectedRunId: string | null;
  expectedReviewRevision: string;
  attributes: ExtractedAttributes;
  condition: string | null;
  identification: Identification;
  listing: ListingCopy;
  prediction: PredictionLogRow;
}

/** Persistence abstraction: production is one RLS-scoped RPC; tests use a fake. */
export interface ReviewRegenerationStore {
  load(itemId: string): Promise<ReviewRegenerationSnapshot | null>;
  commit(input: ReviewRegenerationCommit): Promise<void>;
}

export interface RegenerateReviewListingInput {
  itemId: string;
  expectedReviewRevision: string;
  corrections: IdentityCorrections;
}

export interface RegenerateReviewListingDependencies {
  priceItem?: (signal: ItemSignal) => Promise<PriceResult>;
  generateListing?: (args: {
    attributes: ExtractedAttributes;
  }) => Promise<{ copy: ListingCopy; model: string }>;
  beforeModelWork?: () => Promise<void>;
  randomUUID?: () => string;
}

export interface RegenerateReviewListingResult {
  itemId: string;
  listingId: string;
  runId: string;
  priceOverride: number | null;
  price: PriceResult;
  confidence: ConfidenceResult;
  listing: ListingCopy;
}

async function defaultGenerateListing(args: {
  attributes: ExtractedAttributes;
}): Promise<{ copy: ListingCopy; model: string }> {
  const { copy, model } = await generateEbayListing({
    attributes: args.attributes,
    retrieve: createRealFewShotRetrieval(),
  });
  return { copy, model };
}

/** Public orchestration seam: load -> compute everything -> one atomic commit. */
export async function regenerateReviewListing(
  store: ReviewRegenerationStore,
  input: RegenerateReviewListingInput,
  deps: RegenerateReviewListingDependencies = {},
): Promise<RegenerateReviewListingResult> {
  const snapshot = await store.load(input.itemId);
  if (!snapshot) throw new Error("Item not found.");
  if (snapshot.reviewRevision !== input.expectedReviewRevision) {
    throw new Error("This review changed. Reload and try again.");
  }
  if (snapshot.reviewBlocked || isReviewRegenerationBlocked(snapshot.listing)) {
    throw new Error("A published listing cannot be regenerated from review.");
  }

  const current = extractedAttributesSchema.parse(snapshot.attributes ?? {});
  const attributes = applyIdentityCorrections(current, input.corrections);
  const identification = deriveIdentification(attributes, {});
  await deps.beforeModelWork?.();
  const priceItem = deps.priceItem ?? createDefaultPricer();
  const generateListing = deps.generateListing ?? defaultGenerateListing;
  const [price, generated] = await Promise.all([
    priceItem(attributesToSignal(attributes)),
    generateListing({ attributes: listingFactAttributes(attributes) }),
  ]);

  // Manual correction is always human-controlled. The score is unchanged by this
  // choice, but eligibility is false and the transaction resets the listing to draft.
  const confidence = priceToConfidence(attributes, price, { autopilotEnabled: false });
  const runId = deps.randomUUID?.() ?? crypto.randomUUID();

  const result: PipelineResult = {
    attributes,
    identification,
    price,
    confidence,
    listing: generated.copy,
    model: snapshot.prediction.model ?? "unknown",
    listingModel: generated.model,
    pricingModel: price.model,
  };
  const prediction = buildPredictionLogRow("", input.itemId, result, {
    // The RPC derives the Clerk user and overwrites this placeholder.
    autopilotEnabled: false,
    runId,
  });

  await store.commit({
    itemId: input.itemId,
    listingId: snapshot.listing.id,
    runId,
    expectedRunId: snapshot.listing.runId,
    expectedReviewRevision: input.expectedReviewRevision,
    attributes,
    condition: attributes.condition ?? null,
    identification,
    listing: generated.copy,
    prediction,
  });

  const override =
    snapshot.priceOverride == null ? null : Number(snapshot.priceOverride);
  return {
    itemId: input.itemId,
    listingId: snapshot.listing.id,
    runId,
    priceOverride: Number.isFinite(override) ? override : null,
    price,
    confidence,
    listing: generated.copy,
  };
}

/** Authenticated Supabase adapter. RLS applies to reads; the commit is one RPC txn. */
export function createSupabaseReviewRegenerationStore(
  supabase: SupabaseClient,
): ReviewRegenerationStore {
  return {
    async load(itemId) {
      const snapshot = await loadReviewSnapshot(supabase, itemId);
      if (!snapshot) return null;
      const { item, listing, prediction } = snapshot;
      if (!listing) throw new Error("This item has no eBay listing to regenerate.");
      if (!prediction) throw new Error("This item has not been priced yet.");

      return {
        itemId: item.id as string,
        reviewRevision: item.review_revision as string,
        reviewBlocked: snapshot.reviewBlocked,
        attributes: item.attributes,
        priceOverride: item.price_override as number | string | null,
        listing: {
          id: listing.id as string,
          runId: listing.run_id as string | null,
          status: listing.status as string | null,
          ebayListingId: listing.ebay_listing_id as string | null,
          ebayStatus: listing.ebay_status as string | null,
        },
        prediction: {
          model: prediction.model as string | null,
          autopilotEnabled: prediction.autopilot_enabled as boolean | null,
        },
      };
    },

    async commit(input) {
      const { error } = await supabase.rpc("regenerate_review_listing", {
        p_item_id: input.itemId,
        p_listing_id: input.listingId,
        p_run_id: input.runId,
        p_expected_run_id: input.expectedRunId,
        p_expected_review_revision: input.expectedReviewRevision,
        p_attributes: input.attributes,
        p_condition: input.condition,
        p_identification: input.identification,
        p_listing_title: input.listing.title,
        p_listing_description: input.listing.description,
        p_listing_copy: input.listing.fields,
        p_price: input.prediction.price,
        p_price_range: input.prediction.price_range,
        p_confidence: input.prediction.confidence,
        p_tier_fired: input.prediction.tier_fired,
        p_model: input.prediction.model,
        p_listing_model: input.prediction.listing_model,
        p_pricing_model: input.prediction.pricing_model,
        p_sources: input.prediction.sources,
        p_autopilot_enabled: input.prediction.autopilot_enabled,
        p_autopilot_eligible: input.prediction.autopilot_eligible,
      });
      if (error) {
        throw new Error(`Failed to save regenerated listing: ${error.message}`);
      }
    },
  };
}
