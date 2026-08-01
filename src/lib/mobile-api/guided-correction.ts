import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { effectivePrice } from "@/lib/pipeline/autopilot";
import { buildPredictionLogRow, type PredictionLogRow } from "@/lib/pipeline/prediction-log";
import { MAX_SPECS, repriceWithSpecs } from "@/lib/pipeline/reprice";
import { isReviewRegenerationBlocked } from "@/lib/pipeline/review-regeneration-policy";
import { extractedAttributesSchema, type PipelineResult } from "@/lib/pipeline/types";
import type { ItemSignal, PriceResult } from "@/lib/pricing";

/**
 * Guided identity correction on the native seam — the behavior the PRD calls
 * "Sharpen the estimate".
 *
 * This module is transport-adjacent wiring, not a second correction. The
 * recommendation itself is `repriceWithSpecs`: the shared pricing router, the
 * shared calibrated confidence bridge, the shared spec/identity merge. Nothing
 * here reimplements any of them, and the durable write is the same
 * `sharpen_review_estimate` RPC the web action already commits through, which is
 * what advances `review_revision`, invalidates cached export packs, and refuses
 * an item whose eBay listing has become provider-authoritative.
 *
 * The seller's saved price override is never written by that RPC, so an override
 * survives a correction by construction; the receipt reports the effective price
 * through `effectivePrice`, the same precedence eBay publish and the export packs
 * use, so a native client cannot render a stale recommendation as the price.
 */

const trimmedIdentity = z.string().trim().min(1).max(200);

export const guidedCorrectionIntentSchema = z
  .object({
    /**
     * The revision the seller was looking at. Checked cheaply before any
     * provider work and again inside the RPC's atomic guard, so a stale
     * correction costs nothing and can never land out of order.
     */
    expectedReviewRevision: z.string().uuid(),
    /** The discriminating details the photo could not show. */
    addedSpecs: z
      .array(z.string().trim().min(1).max(200))
      .min(1)
      .max(MAX_SPECS),
    /**
     * Seller-confirmed identity. Provided values override the extracted
     * attributes, which raises identification completeness in the composite AND
     * narrows the pricing search. Omitted fields leave the extracted value alone.
     */
    confirmedIdentity: z
      .object({
        brand: trimmedIdentity.optional(),
        model: trimmedIdentity.optional(),
        category: trimmedIdentity.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type GuidedCorrectionIntent = z.infer<typeof guidedCorrectionIntentSchema>;

export const guidedCorrectionReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** The new prediction run, which is also the item's advanced review revision. */
    runId: z.string().uuid(),
    itemId: z.string().uuid(),
    reviewRevision: z.string().uuid(),
    /** `effectivePrice(suggested, override)` — what every outbound path must use. */
    effectivePrice: z.number().positive(),
    /** The fresh recommendation, kept distinguishable from the seller's intent. */
    suggestedPrice: z.number().positive(),
    sellerPriceOverride: z.number().positive().nullable(),
    priceRange: z.object({ low: z.number(), high: z.number() }).strict(),
    confidence: z
      .object({
        score: z.number().min(0).max(1),
        band: z.enum(["high", "medium", "low"]),
      })
      .strict(),
    tier: z.string().min(1),
    specs: z.array(z.string()),
  })
  .strict();

export type GuidedCorrectionReceipt = z.infer<typeof guidedCorrectionReceiptSchema>;

/**
 * The RLS-scoped view a correction needs before it runs. A caller who does not
 * own the run reads `null` — the row is not hidden by a predicate in this
 * module, it is invisible to the client the caller's own bearer built.
 */
export interface GuidedCorrectionSnapshot {
  itemId: string;
  attributes: Record<string, unknown>;
  reviewRevision: string;
  /** `numeric` arrives as number or string; `effectivePrice` normalizes it. */
  priceOverride: number | string | null;
  /**
   * `authoritative` means eBay owns the listing now — published, publishing, or
   * carrying a provider listing id. Such a run is refused, never corrected.
   */
  publishState: "editable" | "authoritative";
  model: string | null;
  listingModel: string | null;
  autopilotEnabled: boolean | null;
}

/** The coherent write, in domain terms. The adapter owns the RPC argument names. */
export interface GuidedCorrectionCommit {
  itemId: string;
  expectedReviewRevision: string;
  runId: string;
  attributes: Record<string, unknown>;
  prediction: PredictionLogRow;
}

export interface GuidedCorrectionDataClient {
  /** Tenant-scoped; `null` when the caller does not own the run. */
  readRunSnapshot(runId: string): Promise<GuidedCorrectionSnapshot | null>;
  commit(commit: GuidedCorrectionCommit): Promise<void>;
}

export interface GuidedCorrectionRequest {
  runId: string;
  userId: string;
  bearerToken: string;
  intent: GuidedCorrectionIntent;
}

export interface GuidedCorrector {
  correct(input: GuidedCorrectionRequest): Promise<GuidedCorrectionReceipt>;
}

export class GuidedCorrectionNotFoundError extends Error {
  constructor() {
    super("This run is unavailable.");
  }
}

export class GuidedCorrectionStaleError extends Error {
  constructor() {
    super("This review changed. Reload and try again.");
  }
}

export class GuidedCorrectionNotEditableError extends Error {
  constructor() {
    super("A published listing cannot be changed from review.");
  }
}

export class GuidedCorrectionNotPricedError extends Error {
  constructor() {
    super("This item hasn't been priced yet — nothing to sharpen.");
  }
}

export class GuidedCorrectionDataError extends Error {
  constructor(message = "Guided correction failed.") {
    super(message);
  }
}

export interface GuidedCorrectionDependencies {
  /**
   * Injected pricing provider, forwarded verbatim into `repriceWithSpecs`.
   * Tests substitute it so the REAL correction runs offline; production leaves
   * it unset so `repriceWithSpecs` resolves the default PriceRouter.
   */
  priceItem?: (signal: ItemSignal) => Promise<PriceResult>;
  newRunId?: () => string;
}

export function createGuidedCorrectionService(
  clientForBearer: (bearerToken: string) => GuidedCorrectionDataClient,
  dependencies: GuidedCorrectionDependencies = {},
): GuidedCorrector {
  const newRunId = dependencies.newRunId ?? (() => globalThis.crypto.randomUUID());

  return {
    async correct(input) {
      const intent = guidedCorrectionIntentSchema.parse(input.intent);
      const client = clientForBearer(input.bearerToken);

      const snapshot = await client.readRunSnapshot(input.runId);
      if (!snapshot) throw new GuidedCorrectionNotFoundError();

      // Refuse cheaply, BEFORE any provider spend. The RPC re-checks both under
      // the row lock, so these are a courtesy, never the enforcement.
      if (snapshot.reviewRevision !== intent.expectedReviewRevision) {
        throw new GuidedCorrectionStaleError();
      }
      if (snapshot.publishState === "authoritative") {
        throw new GuidedCorrectionNotEditableError();
      }
      if (!snapshot.model) throw new GuidedCorrectionNotPricedError();

      const parsed = extractedAttributesSchema.safeParse(snapshot.attributes);
      const autopilotEnabled = snapshot.autopilotEnabled ?? undefined;
      const reprice = await repriceWithSpecs({
        attributes: parsed.success ? parsed.data : {},
        addedSpecs: intent.addedSpecs,
        confirmedIdentity: intent.confirmedIdentity,
        autopilotEnabled,
        priceItem: dependencies.priceItem,
      });

      // Parsing strips unknown keys, so the persisted object is the RAW stored
      // attributes with only what the correction actually changed applied over
      // it: the merged specs, plus any identity the seller confirmed. Pricing
      // with a corrected brand while storing the old one is exactly the
      // incoherence this contract exists to prevent.
      const attributes: Record<string, unknown> = {
        ...snapshot.attributes,
        ...intent.confirmedIdentity,
        specs: reprice.mergedSpecs,
      };

      const runId = newRunId();
      const result: PipelineResult = {
        attributes: reprice.attributes,
        price: reprice.price,
        confidence: reprice.confidence,
        listing: { platform: "ebay", title: "", description: "", fields: {} },
        model: snapshot.model,
        listingModel: snapshot.listingModel ?? undefined,
        pricingModel: reprice.price.model,
      };
      const prediction = buildPredictionLogRow(input.userId, snapshot.itemId, result, {
        autopilotEnabled,
        runId,
      });

      await client.commit({
        itemId: snapshot.itemId,
        expectedReviewRevision: intent.expectedReviewRevision,
        runId,
        attributes,
        prediction,
      });

      // The override outlives the correction because the RPC never writes it;
      // the receipt resolves the same precedence publish and the export packs use.
      const price = effectivePrice(reprice.price.suggested, snapshot.priceOverride);
      if (price == null) throw new GuidedCorrectionDataError();

      return guidedCorrectionReceiptSchema.parse({
        schemaVersion: 1,
        runId,
        itemId: snapshot.itemId,
        reviewRevision: runId,
        effectivePrice: price,
        suggestedPrice: reprice.price.suggested,
        sellerPriceOverride: effectivePrice(null, snapshot.priceOverride),
        priceRange: prediction.price_range,
        confidence: {
          score: reprice.confidence.score,
          band: reprice.confidence.band,
        },
        tier: reprice.price.tier,
        specs: reprice.mergedSpecs,
      });
    },
  };
}

/** Named apart from the `GuidedCorrectionDataError` class it is mapped into. */
interface GuidedCorrectionRpcFailure {
  code?: string;
  message: string;
}

interface GuidedCorrectionReadResult {
  data: unknown;
  error: GuidedCorrectionRpcFailure | null;
}

/**
 * The narrow slice of the Supabase client this adapter needs, typed here rather
 * than taken as `SupabaseClient` wholesale so the seam stays honest about the
 * reads and the single RPC a correction is allowed to perform.
 */
interface GuidedCorrectionSupabaseClient {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<GuidedCorrectionReadResult>;
}

function mapCommitError(error: GuidedCorrectionRpcFailure): Error {
  if (/review changed/i.test(error.message)) {
    return new GuidedCorrectionStaleError();
  }
  if (/editable ebay listing not found|published listing/i.test(error.message)) {
    return new GuidedCorrectionNotEditableError();
  }
  return new GuidedCorrectionDataError();
}

const itemRowSchema = z
  .object({
    attributes: z.unknown(),
    price_override: z.union([z.number(), z.string()]).nullable(),
    review_revision: z.string().uuid(),
  })
  .passthrough();

const listingRowSchema = z
  .object({
    status: z.string().nullable(),
    ebay_listing_id: z.string().nullable(),
    ebay_status: z.string().nullable(),
  })
  .passthrough();

const predictionRowSchema = z
  .object({
    model: z.string().nullable(),
    listing_model: z.string().nullable(),
    autopilot_enabled: z.boolean().nullable(),
  })
  .passthrough();

/**
 * Every read and the commit run through the caller's own RLS-scoped client, so a
 * foreign run is not filtered out by a predicate here — it is never returned at
 * all. That is the same tenancy proof the rest of the mobile API relies on, and
 * it is why the ownership assertion lives at this seam rather than in the
 * pipeline.
 */
export function createSupabaseGuidedCorrectionDataClient(
  client: SupabaseClient,
): GuidedCorrectionDataClient {
  const rpcClient = client as unknown as GuidedCorrectionSupabaseClient;
  return {
    async readRunSnapshot(runId) {
      const run = await client
        .from("pipeline_runs")
        .select("id,item_id")
        .eq("id", runId)
        .maybeSingle();
      if (run.error) throw new GuidedCorrectionDataError();
      const itemId = (run.data as { item_id?: unknown } | null)?.item_id;
      if (typeof itemId !== "string") return null;

      const [item, listings, prediction] = await Promise.all([
        client
          .from("items")
          .select("attributes,price_override,review_revision")
          .eq("id", itemId)
          .maybeSingle(),
        client
          .from("listings")
          .select("status,ebay_listing_id,ebay_status")
          .eq("item_id", itemId)
          .eq("platform", "ebay"),
        client
          .from("prediction_logs")
          .select("model,listing_model,autopilot_enabled")
          .eq("item_id", itemId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (item.error || listings.error || prediction.error) {
        throw new GuidedCorrectionDataError();
      }
      if (item.data == null) return null;

      const parsedItem = itemRowSchema.safeParse(item.data);
      if (!parsedItem.success) throw new GuidedCorrectionDataError();
      const parsedPrediction = prediction.data
        ? predictionRowSchema.safeParse(prediction.data)
        : null;
      const parsedListings = z
        .array(listingRowSchema)
        .safeParse(listings.data ?? []);
      if (!parsedListings.success) throw new GuidedCorrectionDataError();

      const attributes = parsedItem.data.attributes;
      return {
        itemId,
        attributes:
          attributes && typeof attributes === "object" && !Array.isArray(attributes)
            ? (attributes as Record<string, unknown>)
            : {},
        reviewRevision: parsedItem.data.review_revision,
        priceOverride: parsedItem.data.price_override,
        // The same predicate the web review path uses. A provider-authoritative
        // listing is not re-derived here in different words.
        publishState: parsedListings.data.some((listing) =>
          isReviewRegenerationBlocked({
            status: listing.status,
            ebayListingId: listing.ebay_listing_id,
            ebayStatus: listing.ebay_status,
          }),
        )
          ? "authoritative"
          : "editable",
        model: parsedPrediction?.success ? parsedPrediction.data.model : null,
        listingModel: parsedPrediction?.success
          ? parsedPrediction.data.listing_model
          : null,
        autopilotEnabled: parsedPrediction?.success
          ? parsedPrediction.data.autopilot_enabled
          : null,
      };
    },
    async commit(commit) {
      const { prediction } = commit;
      const result = await rpcClient.rpc("sharpen_review_estimate", {
        p_item_id: commit.itemId,
        p_expected_review_revision: commit.expectedReviewRevision,
        p_run_id: commit.runId,
        p_attributes: commit.attributes,
        p_price: prediction.price,
        p_price_range: prediction.price_range,
        p_confidence: prediction.confidence,
        p_tier_fired: prediction.tier_fired,
        p_model: prediction.model,
        p_listing_model: prediction.listing_model,
        p_pricing_model: prediction.pricing_model,
        p_sources: prediction.sources,
        p_autopilot_enabled: prediction.autopilot_enabled,
        p_autopilot_eligible: prediction.autopilot_eligible,
      });
      if (result.error) throw mapCommitError(result.error);
    },
  };
}

/**
 * Composed per request from the caller's bearer, so the RLS identity is the
 * seller's own and never a service-role client.
 */
export function createConfiguredSupabaseGuidedCorrector(input: {
  publishableKey: string;
  supabaseURL: string;
}): GuidedCorrector {
  if (!input.publishableKey.startsWith("sb_publishable_")) {
    throw new Error(
      "Guided correction requires a current Supabase publishable key.",
    );
  }
  return createGuidedCorrectionService((bearerToken) =>
    createSupabaseGuidedCorrectionDataClient(
      createClient(input.supabaseURL, input.publishableKey, {
        accessToken: async () => bearerToken,
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    ),
  );
}
