import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { effectivePrice } from "@/lib/pipeline/autopilot";
import { buildPredictionLogRow, type PredictionLogRow } from "@/lib/pipeline/prediction-log";
import {
  completeSupabaseMobileGuidedCorrection,
  createSupabaseGuidedCorrectionCompletionGateway,
  type GuidedCorrectionAttemptIdentity,
  type GuidedCorrectionCapability,
  type GuidedCorrectionCompletionRpcClient,
  type MobileGuidedCorrectionCompletionInput,
} from "@/lib/pipeline/guided-correction-completion";
import {
  MAX_SPECS,
  mergeIdentity,
  repriceWithSpecs,
  type ConfirmedIdentity,
} from "@/lib/pipeline/reprice";
import { isReviewRegenerationBlocked } from "@/lib/pipeline/review-regeneration-policy";
import {
  extractedAttributesSchema,
  identificationSchema,
  type ExtractedAttributes,
  type Identification,
  type PipelineResult,
} from "@/lib/pipeline/types";
import type { ItemSignal, PriceResult } from "@/lib/pricing";
import { deriveIdentification } from "@/lib/vision/extract";

/**
 * Guided identity correction on the native seam — the behavior the PRD calls
 * "Sharpen the estimate".
 *
 * This module is transport-adjacent wiring, not a second correction. The
 * recommendation itself is `repriceWithSpecs`: the shared pricing router, the
 * shared calibrated confidence bridge, the shared spec/identity merge. Nothing
 * here reimplements any of them. The shared guided-correction completion gateway
 * atomically advances `review_revision`, invalidates cached export packs, records
 * the included correction, and stores the replay receipt.
 *
 * The seller's saved price override is never written by completion, so an override
 * survives a correction by construction; the receipt reports the effective price
 * through `effectivePrice`, the same precedence eBay publish and the export packs
 * use, so a native client cannot render a stale recommendation as the price.
 */

/**
 * 120, not 200: the published contract has always bounded a confirmed brand,
 * model, or category at 120, and a runtime that accepted more would have let a
 * native client send a value the contract says is invalid — and the native model
 * generated from that contract reject a value the server had already stored.
 */
const trimmedIdentity = z.string().trim().min(1).max(120);

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
     *
     * An object carrying no usable field is ACCEPTED and means "no identity
     * change" — `usableIdentity` normalizes it before the correction reads it.
     * Rejecting it would be a contract change against the native model
     * generated from this schema, and normalizing it here is not available:
     * this schema is emitted through `z.toJSONSchema`, which cannot represent a
     * transform.
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
  /** The editable eBay draft the shared allowance capability binds. */
  listingId: string | null;
  listingRunId: string | null;
  attributes: Record<string, unknown>;
  reviewRevision: string;
  /** `numeric` arrives as number or string; `effectivePrice` normalizes it. */
  priceOverride: number | string | null;
  /**
   * `authoritative` means eBay owns the listing now — published, publishing, or
   * carrying a provider listing id. Such a run is refused, never corrected.
   */
  publishState: "editable" | "authoritative";
  /**
   * Whether the item carries a priced prediction at all. `model` is nullable on
   * legacy rows, so a missing model string is NOT evidence the item was never
   * priced — only the absence of a usable price is.
   */
  priced: boolean;
  model: string | null;
  listingModel: string | null;
  autopilotEnabled: boolean | null;
  /** The identity the item is currently showing, kept for a specs-only sharpen. */
  identification: Identification | null;
}

/** The coherent write, in domain terms. The adapter owns the RPC argument names. */
export interface GuidedCorrectionCommit {
  itemId: string;
  expectedReviewRevision: string;
  runId: string;
  attributes: Record<string, unknown>;
  /**
   * The re-derived identity, present only when the seller actually confirmed
   * one. `items.identification` is what `get_mobile_listing_review` projects
   * into the native client, so a correction that stops at `attributes` leaves
   * the seller looking at the identity they just replaced.
   */
  identification?: Identification;
  prediction: PredictionLogRow;
}

type GuidedCorrectionAtomicCompletion = Omit<
  MobileGuidedCorrectionCompletionInput,
  "commit"
> & { commit: GuidedCorrectionCommit };

/**
 * One seller intent, carried through the RLS reads, claim, authorization, and
 * release so each can mint its own short-lived token. A verified guest's
 * `guestcap_` bearer is not a project JWT and PostgREST cannot verify it; the
 * final write instead uses the separately minted guided-correction capability.
 */
export interface GuidedCorrectionOperation {
  runId: string;
  /** Scopes the durable claim that keeps a correction from paying twice. */
  idempotencyKey: string;
  userId: string;
  bearerToken: string;
  mintOperationToken?: () => Promise<string>;
  intent: GuidedCorrectionIntent;
}

/**
 * The claim's answer, which decides whether provider work may run at all.
 * `completed` carries the first attempt's receipt so a client retry is answered
 * rather than re-priced; `in_progress` means another correction already holds
 * this revision.
 */
export type GuidedCorrectionClaimResult =
  | { state: "proceed" }
  | { state: "in_progress" }
  | { state: "completed"; receipt: GuidedCorrectionReceipt };

export interface GuidedCorrectionDataClient {
  /** Tenant-scoped; `null` when the caller does not own the run. */
  readRunSnapshot(
    operation: GuidedCorrectionOperation,
  ): Promise<GuidedCorrectionSnapshot | null>;
  /** `prepare` — the throttle. Returns before any provider work is allowed. */
  claim(
    operation: GuidedCorrectionOperation,
  ): Promise<GuidedCorrectionClaimResult>;
  /** Shared one-included-correction authority, acquired before provider work. */
  authorize(
    operation: GuidedCorrectionOperation,
    attempt: GuidedCorrectionAttemptIdentity,
  ): Promise<GuidedCorrectionCapability>;
  /** One transaction: correction, included allowance, and replay receipt. */
  complete(
    operation: GuidedCorrectionOperation,
    completion: GuidedCorrectionAtomicCompletion,
  ): Promise<void>;
  /** `fail` — releases the lease so the seller can retry immediately. */
  release(operation: GuidedCorrectionOperation): Promise<void>;
}

export type GuidedCorrectionRequest = GuidedCorrectionOperation;

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

export class GuidedCorrectionInProgressError extends Error {
  constructor() {
    super("This correction is already in progress. Try again.");
  }
}

export class GuidedCorrectionUnavailableError extends Error {
  constructor() {
    super("The included guided correction is unavailable.");
  }
}

export class GuidedCorrectionIdempotencyConflictError extends Error {
  constructor() {
    super("This Idempotency-Key is already bound to a different correction.");
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

/**
 * The confirmation the seller ACTUALLY made, or `undefined` when they made none.
 *
 * A correction reads the confirmed identity in four places — the title rebuild,
 * the pricing merge, the persisted attributes, and the `items.identification`
 * write — and every one of them gates on presence. An identity object that is
 * present but carries no usable field clears all four gates while merging
 * nothing: the title is rebuilt from `brand + model`, SHORTENING a richer stored
 * title, and a re-derived identification replaces the column
 * `get_mobile_listing_review` projects into the native client's `identity.label`
 * — both off a confirmation that was never made.
 *
 * So the four reads resolve through one normalization rather than four presence
 * checks. The predicate is deliberately the same one `mergeIdentity` applies a
 * field under (a non-blank trimmed value), so "usable" here cannot drift from
 * "actually merged" there. It cannot live in the Zod schema: that schema is
 * emitted through `z.toJSONSchema` to generate the native contract, and a
 * transform is not representable in JSON Schema.
 */
function usableIdentity(
  confirmed: ConfirmedIdentity | undefined,
): ConfirmedIdentity | undefined {
  const usable =
    confirmed
    && Object.values(confirmed).some((value) => Boolean(value?.trim()));
  return usable ? confirmed : undefined;
}

/**
 * Retitle an item around the identity the seller just confirmed.
 *
 * `deriveIdentification` reads `title` FIRST when it builds the label, so
 * merging a corrected brand/model while leaving the old title in place would
 * store a fresh identification that still SAYS the replaced identity. The web
 * identity correction rebuilds the title for exactly this reason
 * (`applyIdentityCorrections`); this does the same, except it rebuilds from the
 * MERGED identity rather than from the correction alone, because a native
 * confirmation is partial — confirming only the model must not blank the brand
 * the seller left alone.
 *
 * Returns the attributes unchanged when nothing was confirmed: a specs-only
 * sharpen narrows the pricing search and makes no claim about what the item is.
 * Takes the value `usableIdentity` resolved, never the raw intent — a presence
 * check against the raw intent would rebuild the title off an empty merge.
 */
function applyConfirmedIdentity(
  attributes: ExtractedAttributes,
  confirmed: ConfirmedIdentity | undefined,
): ExtractedAttributes {
  if (!confirmed) return attributes;
  const merged = mergeIdentity(attributes, confirmed);
  const title = [merged.brand, merged.model].filter(Boolean).join(" ").trim()
    || merged.category?.trim();
  return title ? { ...merged, title } : merged;
}

/**
 * The correction itself, once the claim has granted the right to run it.
 *
 * Every value that can be validated locally is built before the durable write.
 * The final RPC owns item revision, prediction, credit completion, and receipt
 * in one transaction, so an error cannot leave the item past the revision an
 * exact retry still carries.
 */
async function runCorrection(
  operation: GuidedCorrectionOperation,
  snapshot: GuidedCorrectionSnapshot,
  dependencies: GuidedCorrectionDependencies,
  runId: string,
): Promise<{
  commit: GuidedCorrectionCommit;
  receipt: GuidedCorrectionReceipt;
}> {
  const { intent } = operation;

  // Refuse cheaply, BEFORE any provider spend. The RPC re-checks all of these
  // under the row lock, so they are a courtesy, never the enforcement.
  if (snapshot.reviewRevision !== intent.expectedReviewRevision) {
    throw new GuidedCorrectionStaleError();
  }
  if (snapshot.publishState === "authoritative") {
    throw new GuidedCorrectionNotEditableError();
  }
  // A legacy prediction row can carry a null `model` and still be a real price.
  // Refusing on the missing model string would make a genuinely priced item
  // permanently uncorrectable on native, so the gate is whether a price exists
  // — the same thing the web action gated on.
  if (!snapshot.priced) throw new GuidedCorrectionNotPricedError();

  const parsed = extractedAttributesSchema.safeParse(snapshot.attributes);
  const autopilotEnabled = snapshot.autopilotEnabled ?? undefined;
  // Resolved ONCE. Every step below reads this rather than the raw intent, so a
  // fieldless identity object cannot mean "nothing confirmed" at one step and
  // "something confirmed" at the next.
  const confirmedIdentity = usableIdentity(intent.confirmedIdentity);
  // Retitle BEFORE pricing so the attributes that were priced are exactly the
  // attributes that get persisted, rather than differing by a title.
  const corrected = applyConfirmedIdentity(
    parsed.success ? parsed.data : {},
    confirmedIdentity,
  );
  const reprice = await repriceWithSpecs({
    attributes: corrected,
    addedSpecs: intent.addedSpecs,
    confirmedIdentity,
    autopilotEnabled,
    priceItem: dependencies.priceItem,
  });

  // Parsing strips unknown keys, so the persisted object is the RAW stored
  // attributes with only what the correction actually changed applied over it:
  // the merged specs, plus any identity the seller confirmed. Pricing with a
  // corrected brand while storing the old one is exactly the incoherence this
  // contract exists to prevent.
  const attributes: Record<string, unknown> = {
    ...snapshot.attributes,
    ...confirmedIdentity,
    ...(corrected.title ? { title: corrected.title } : {}),
    specs: reprice.mergedSpecs,
  };
  // The identity is re-derived from the corrected attributes through the SAME
  // `deriveIdentification` the vision step and the web identity correction use —
  // the photos did not change, so nothing here re-runs vision, it only restates
  // what the seller confirmed.
  const identification = confirmedIdentity
    ? deriveIdentification(reprice.attributes, {})
    : undefined;

  const result: PipelineResult = {
    attributes: reprice.attributes,
    price: reprice.price,
    confidence: reprice.confidence,
    listing: { platform: "ebay", title: "", description: "", fields: {} },
    // The RPC requires model provenance, and a legacy row can be priced with
    // none. "unknown" is the same honest placeholder the web action rode
    // forward rather than refusing a real price.
    model: snapshot.model ?? "unknown",
    listingModel: snapshot.listingModel ?? undefined,
    pricingModel: reprice.price.model,
  };
  const prediction = buildPredictionLogRow(
    operation.userId,
    snapshot.itemId,
    result,
    { autopilotEnabled, runId },
  );

  const price = effectivePrice(reprice.price.suggested, snapshot.priceOverride);
  if (price == null) throw new GuidedCorrectionDataError();

  const receipt = guidedCorrectionReceiptSchema.parse({
    schemaVersion: 1,
    runId,
    itemId: snapshot.itemId,
    reviewRevision: runId,
    // The override outlives the correction because the RPC never writes it; the
    // receipt resolves the same precedence publish and the export packs use.
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

  return {
    commit: {
      itemId: snapshot.itemId,
      expectedReviewRevision: intent.expectedReviewRevision,
      runId,
      attributes,
      ...(identification ? { identification } : {}),
      prediction,
    },
    receipt,
  };
}

export function createGuidedCorrectionService(
  client: GuidedCorrectionDataClient,
  dependencies: GuidedCorrectionDependencies = {},
): GuidedCorrector {
  const newRunId = dependencies.newRunId ?? (() => globalThis.crypto.randomUUID());

  return {
    async correct(input) {
      const intent = guidedCorrectionIntentSchema.parse(input.intent);
      const operation: GuidedCorrectionOperation = { ...input, intent };

      const snapshot = await client.readRunSnapshot(operation);
      if (!snapshot) throw new GuidedCorrectionNotFoundError();

      // Claim BEFORE the revision guard and before any provider spend.
      //
      // Two corrections holding the same `expectedReviewRevision` both clear the
      // cheap pre-check, but only one can win the RPC's atomic guard — so
      // without this the loser still pays the PriceRouter and then throws the
      // answer away. The claim is also what makes a client retry safe: a
      // completed correction has already advanced the item past the revision its
      // intent carries, so re-running it would 409 the seller off their own
      // finished work instead of handing back its receipt.
      const claim = await client.claim(operation);
      if (claim.state === "completed") return claim.receipt;
      if (claim.state === "in_progress") {
        throw new GuidedCorrectionInProgressError();
      }

      const runId = newRunId();
      try {
        if (!snapshot.listingId) throw new GuidedCorrectionNotEditableError();
        const attempt: GuidedCorrectionAttemptIdentity = {
          itemId: snapshot.itemId,
          listingId: snapshot.listingId,
          runId,
          expectedRunId: snapshot.listingRunId,
          expectedReviewRevision: intent.expectedReviewRevision,
        };
        const capability = await client.authorize(operation, attempt);
        const prepared = await runCorrection(
          operation,
          snapshot,
          dependencies,
          runId,
        );
        const completion: GuidedCorrectionAtomicCompletion = {
          ...attempt,
          listingId: snapshot.listingId,
          capabilityToken: capability.token,
          idempotencyKey: operation.idempotencyKey,
          commit: prepared.commit,
          receipt: prepared.receipt,
        };
        await client.complete(operation, completion);
        return prepared.receipt;
      } catch (error) {
        // Nothing durable happened, so the lease must not outlive the failure —
        // the seller's next attempt has to be legal immediately.
        await client.release(operation).catch(() => undefined);
        throw error;
      }
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
  if (/review changed|guided correction authority changed/i.test(error.message)) {
    return new GuidedCorrectionStaleError();
  }
  if (/editable ebay listing not found|published listing/i.test(error.message)) {
    return new GuidedCorrectionNotEditableError();
  }
  return new GuidedCorrectionDataError();
}

function mapClaimError(error: GuidedCorrectionRpcFailure): Error {
  // The claim RPC verifies run ownership itself, under definer rights bounded to
  // the caller's own tenancy, so a run this seller does not own is refused there
  // rather than proved absent by a second read.
  if (/this run is unavailable/i.test(error.message)) {
    return new GuidedCorrectionNotFoundError();
  }
  if (/already bound to a different correction/i.test(error.message)) {
    return new GuidedCorrectionIdempotencyConflictError();
  }
  if (/review changed/i.test(error.message)) {
    return new GuidedCorrectionStaleError();
  }
  return new GuidedCorrectionDataError();
}

function mapAuthorizationError(error: unknown): Error {
  if (
    error instanceof Error
    && /review changed|guided correction authority changed/i.test(error.message)
  ) {
    return new GuidedCorrectionStaleError();
  }
  if (
    error instanceof Error
    && /editable ebay listing not found|published listing/i.test(error.message)
  ) {
    return new GuidedCorrectionNotEditableError();
  }
  if (
    error instanceof Error
    && /included guided correction is unavailable/i.test(error.message)
  ) {
    return new GuidedCorrectionUnavailableError();
  }
  return error instanceof Error ? error : new GuidedCorrectionDataError();
}

const claimResultSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("proceed") }),
  z.object({ state: z.literal("in_progress") }),
  z.object({
    state: z.literal("completed"),
    receipt: guidedCorrectionReceiptSchema,
  }),
]);

/**
 * A guest presents a capability bearer PostgREST cannot verify, so every durable
 * operation mints its own short-lived project JWT — the same per-operation mint
 * `PUT /review` performs. A Clerk caller's bearer already is one.
 */
async function operationToken(
  operation: GuidedCorrectionOperation,
): Promise<string> {
  return operation.mintOperationToken
    ? operation.mintOperationToken()
    : operation.bearerToken;
}

function claimArguments(
  operation: GuidedCorrectionOperation,
  action: "prepare" | "fail",
): Record<string, unknown> {
  return {
    p_action: action,
    p_run_id: operation.runId,
    p_idempotency_key: operation.idempotencyKey,
    p_expected_review_revision: operation.intent.expectedReviewRevision,
    p_intent: operation.intent,
  };
}

const itemRowSchema = z
  .object({
    attributes: z.unknown(),
    identification: z.unknown(),
    price_override: z.union([z.number(), z.string()]).nullable(),
    review_revision: z.string().uuid(),
  })
  .passthrough();

const listingRowSchema = z
  .object({
    id: z.string().uuid().optional(),
    run_id: z.string().uuid().nullable().optional(),
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
    /** `numeric` arrives as number or string; only its usability is read here. */
    price: z.union([z.number(), z.string()]).nullable(),
  })
  .passthrough();

/** A prediction counts as priced when it carries a usable, strictly positive price. */
function isPriced(price: number | string | null | undefined): boolean {
  if (price == null) return false;
  const value = typeof price === "string" ? Number(price) : price;
  return Number.isFinite(value) && value > 0;
}

/**
 * Every read and the commit run through the caller's own RLS-scoped client, so a
 * foreign run is not filtered out by a predicate here — it is never returned at
 * all. That is the same tenancy proof the rest of the mobile API relies on, and
 * it is why the ownership assertion lives at this seam rather than in the
 * pipeline.
 */
export function createSupabaseGuidedCorrectionDataClient(
  clientForBearer: (bearerToken: string) => SupabaseClient,
  completionClient?: GuidedCorrectionCompletionRpcClient,
): GuidedCorrectionDataClient {
  const rpcFor = async (operation: GuidedCorrectionOperation) =>
    clientForBearer(
      await operationToken(operation),
    ) as unknown as GuidedCorrectionSupabaseClient;
  return {
    async readRunSnapshot(operation) {
      const client = clientForBearer(await operationToken(operation));
      const runId = operation.runId;
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
          .select("attributes,identification,price_override,review_revision")
          .eq("id", itemId)
          .maybeSingle(),
        client
          .from("listings")
          .select("id,run_id,status,ebay_listing_id,ebay_status")
          .eq("item_id", itemId)
          .eq("platform", "ebay"),
        client
          .from("prediction_logs")
          .select("model,listing_model,autopilot_enabled,price")
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
      const editableListing = parsedListings.data.find((listing) =>
        !isReviewRegenerationBlocked({
          status: listing.status,
          ebayListingId: listing.ebay_listing_id,
          ebayStatus: listing.ebay_status,
        }),
      );
      return {
        itemId,
        listingId: editableListing?.id ?? null,
        listingRunId: editableListing?.run_id ?? null,
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
        priced: parsedPrediction?.success
          ? isPriced(parsedPrediction.data.price)
          : false,
        model: parsedPrediction?.success ? parsedPrediction.data.model : null,
        listingModel: parsedPrediction?.success
          ? parsedPrediction.data.listing_model
          : null,
        autopilotEnabled: parsedPrediction?.success
          ? parsedPrediction.data.autopilot_enabled
          : null,
        identification: identificationSchema.safeParse(
          parsedItem.data.identification,
        ).data ?? null,
      };
    },
    async claim(operation) {
      const result = await (await rpcFor(operation)).rpc(
        "claim_mobile_guided_correction",
        claimArguments(operation, "prepare"),
      );
      if (result.error) throw mapClaimError(result.error);
      const parsed = claimResultSchema.safeParse(result.data);
      if (!parsed.success) throw new GuidedCorrectionDataError();
      return parsed.data;
    },
    async authorize(operation, attempt) {
      if (!completionClient) throw new GuidedCorrectionDataError();
      const client = clientForBearer(await operationToken(operation));
      try {
        return await createSupabaseGuidedCorrectionCompletionGateway(
          client,
          completionClient,
        ).authorize(attempt);
      } catch (error) {
        throw mapAuthorizationError(error);
      }
    },
    async complete(_operation, completion) {
      if (!completionClient) throw new GuidedCorrectionDataError();
      try {
        await completeSupabaseMobileGuidedCorrection(
          completionClient,
          completion,
        );
      } catch (error) {
        if (error instanceof Error) {
          throw mapCommitError({ message: error.message });
        }
        throw new GuidedCorrectionDataError();
      }
    },
    async release(operation) {
      const result = await (await rpcFor(operation)).rpc(
        "claim_mobile_guided_correction",
        claimArguments(operation, "fail"),
      );
      if (result.error) throw mapClaimError(result.error);
    },
  };
}

/**
 * Reads, claim, allowance authorization, and release use the caller's RLS
 * bearer. The atomic write uses only the shared short-lived capability through
 * the fixed internal completion client; callers never receive a generic admin
 * client.
 */
export function createConfiguredSupabaseGuidedCorrector(input: {
  completionClient: GuidedCorrectionCompletionRpcClient;
  publishableKey: string;
  supabaseURL: string;
}): GuidedCorrector {
  if (!input.publishableKey.startsWith("sb_publishable_")) {
    throw new Error(
      "Guided correction requires a current Supabase publishable key.",
    );
  }
  return createGuidedCorrectionService(
    createSupabaseGuidedCorrectionDataClient((bearerToken) =>
      createClient(input.supabaseURL, input.publishableKey, {
        accessToken: async () => bearerToken,
        auth: { persistSession: false, autoRefreshToken: false },
      }),
      input.completionClient,
    ),
  );
}
