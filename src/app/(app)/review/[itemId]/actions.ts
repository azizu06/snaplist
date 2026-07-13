"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import { parseReviewEdits } from "@/lib/pipeline";
import { repriceWithSpecs } from "@/lib/pipeline/reprice";
import {
  createSupabaseReviewRegenerationStore,
  parseIdentityCorrections,
  regenerateReviewListing,
} from "@/lib/pipeline/review-regeneration";
import { isReviewRegenerationBlocked } from "@/lib/pipeline/review-regeneration-policy";
import { buildPredictionLogRow } from "@/lib/pipeline/prediction-log";
import { extractedAttributesSchema, type PipelineResult } from "@/lib/pipeline/types";
import {
  garmentClassOf,
  parseMeasurementEdits,
  GARMENT_MEASUREMENT_SETS,
  type SubmittedMeasurement,
} from "@/lib/vision/measurements";
import { logEvent } from "@/lib/observability";
import { reportServerError } from "@/lib/sentry";
import {
  rateLimitAllows,
  recordPipelineRunAndMaybeAlert,
} from "@/lib/abuse";

/**
 * Review-page actions (issue #12 + UI pass): the seller's edits.
 *
 * Everything persists through the USER-SCOPED server client, so RLS proves
 * ownership — updating another user's item/listing matches zero rows and is
 * reported as a failure, never a silent no-op success. Downstream consumers
 * (the review display now, publish later) resolve the price via
 * `effectivePrice(suggested, override)` so the override flows everywhere.
 */

function backTo(itemId: string, error?: string): never {
  const suffix = error ? `?error=${encodeURIComponent(error)}` : "";
  redirect(`/review/${itemId}${suffix}`);
}

function reviewRevisionFrom(formData: FormData, itemId: string): string {
  const revision = formData.get("reviewRevision");
  if (typeof revision !== "string" || revision.length === 0) {
    backTo(itemId, "This review changed. Reload and try again.");
  }
  return revision;
}

function reviewWriteError(err: unknown, fallback: string): string {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err !== null && "message" in err
        ? String(err.message)
        : "";
  return /review changed/i.test(message)
    ? "This review changed. Reload and try again."
    : fallback;
}

/**
 * Save the seller's non-identity review edits. One submit persists every
 * editable field the seller may have touched:
 *
 * - listing title + description → `listings` (only when a listing row exists);
 * - price → `items.price_override` (blank clears it back to the suggestion).
 *
 * Validation happens in the PURE `parseReviewEdits` helper (unit-tested);
 * this action is only RLS-scoped persistence + redirect plumbing.
 */
export async function saveReview(formData: FormData) {
  const itemId = formData.get("itemId");
  if (typeof itemId !== "string" || itemId.length === 0) {
    redirect("/upload");
  }
  const id = itemId as string;
  const expectedReviewRevision = reviewRevisionFrom(formData, id);
  const listingId = formData.get("listingId");
  const hasListing = typeof listingId === "string" && listingId.length > 0;

  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) redirect(`/login?next=/review/${id}`);

  let edits: ReturnType<typeof parseReviewEdits>;
  try {
    edits = parseReviewEdits({
      hasListing,
      title: formData.get("title"),
      description: formData.get("description"),
      category: formData.get("category"),
      condition: formData.get("condition"),
      price: formData.get("price"),
      costBasis: formData.get("costBasis"),
    });
  } catch (err) {
    backTo(id, err instanceof Error ? err.message : "Invalid edits.");
  }

  // RLS scopes the read; a missing/foreign row → error.
  const { data: item, error: readError } = await supabase
    .from("items")
    .select("id, attributes, condition")
    .eq("id", id)
    .maybeSingle();
  if (readError) {
    reportServerError("review.save.read", readError);
    backTo(id, "Failed to save changes. Please try again.");
  }
  if (!item) {
    backTo(id, "Item not found.");
  }

  // Garment measurements (issue #104): parse the submitted measurement fields +
  // their confirm boxes into DRAFTS (blank clears, a typed value confirms only when
  // ticked), merged over the stored ones. Only for garments; the pure parser throws
  // on junk (e.g. a non-numeric measurement) so a typo never wipes a value silently.
  const existingParse = extractedAttributesSchema.safeParse(item.attributes ?? {});
  const existingAttrs = existingParse.success ? existingParse.data : {};
  const garmentClass = garmentClassOf(existingAttrs);

  const attributes: Record<string, unknown> = {
    ...((item.attributes ?? {}) as Record<string, unknown>),
  };

  if (garmentClass) {
    const confirmedNames = new Set(
      formData
        .getAll("measurement_confirmed")
        .filter((v): v is string => typeof v === "string"),
    );
    const submitted: SubmittedMeasurement[] = GARMENT_MEASUREMENT_SETS[garmentClass].map(
      (name) => {
        const raw = formData.get(`measurement_${name}`);
        return {
          name,
          value: typeof raw === "string" ? raw : "",
          confirmed: confirmedNames.has(name),
        };
      },
    );
    try {
      attributes.measurements = parseMeasurementEdits(
        existingAttrs.measurements ?? [],
        submitted,
        garmentClass,
      );
    } catch (err) {
      backTo(id, err instanceof Error ? err.message : "Invalid measurement.");
    }
  } else {
    // No longer a garment → drop any stored drafts (the spread above re-added them).
    delete attributes.measurements;
  }

  const { error: saveError } = await supabase.rpc("save_review_edits", {
    p_item_id: id,
    p_listing_id: hasListing ? (listingId as string) : null,
    p_expected_review_revision: expectedReviewRevision,
    p_new_review_revision: crypto.randomUUID(),
    p_attributes: attributes,
    p_condition: item.condition,
    p_price_override: edits.override,
    p_cost_basis: edits.costBasis,
    p_listing_title: edits.listing?.title ?? null,
    p_listing_description: edits.listing?.description ?? null,
  });
  if (saveError) {
    reportServerError("review.save", saveError);
    backTo(
      id,
      reviewWriteError(saveError, "Failed to save changes. Please try again."),
    );
  }

  revalidatePath(`/review/${id}`);
  backTo(id);
}

/**
 * Seller identity correction (issue #126): validate the bounded identity form,
 * recompute pricing/confidence/listing copy through the shared services, then commit
 * the entire coherent result through one RLS-scoped database transaction. The
 * transaction never writes `items.price_override`, so saved seller price intent wins
 * over the fresh suggestion exactly as it did before regeneration.
 */
export async function regenerateCorrectedIdentity(formData: FormData) {
  const itemId = formData.get("itemId");
  if (typeof itemId !== "string" || itemId.length === 0) {
    redirect("/upload");
  }
  const id = itemId as string;
  const expectedReviewRevision = reviewRevisionFrom(formData, id);

  let corrections: ReturnType<typeof parseIdentityCorrections>;
  try {
    corrections = parseIdentityCorrections({
      brand: formData.get("brand"),
      model: formData.get("model"),
      category: formData.get("category"),
      condition: formData.get("condition"),
      isbn: formData.get("isbn"),
      upc: formData.get("upc"),
      specifications: formData.get("specifications"),
    });
  } catch (err) {
    backTo(id, err instanceof Error ? err.message : "Invalid identity corrections.");
  }

  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) redirect(`/login?next=/review/${id}`);

  if (!(await rateLimitAllows(userId))) {
    backTo(id, "Too many requests. Please slow down and try again shortly.");
  }

  try {
    const result = await regenerateReviewListing(
      createSupabaseReviewRegenerationStore(supabase),
      { itemId: id, expectedReviewRevision, corrections },
      { beforeModelWork: recordPipelineRunAndMaybeAlert },
    );
    logEvent("review.identity_regenerated", {
      itemId: id,
      runId: result.runId,
      tier: result.price.tier,
      confidence: result.confidence.score,
      band: result.confidence.band,
      priceOverridePreserved: result.priceOverride != null,
    });
  } catch (err) {
    reportServerError("review.identity_regenerate", err);
    const message =
      err instanceof Error && /(published listing|review changed)/i.test(err.message)
        ? err.message
        : "We couldn’t re-price and regenerate this listing. Your previous result was kept.";
    backTo(id, message);
  }

  revalidatePath(`/review/${id}`);
  revalidatePath(`/export/${id}`);
  backTo(id);
}

/**
 * "Sharpen the estimate" (clarify-variant): the seller supplies a discriminating
 * detail the photo couldn't show (exact model, GPU, storage, generation…), and we
 * RE-RESEARCH the price with it. The vision step is NOT re-run — the photos didn't
 * change; only the pricing search is narrowed by the new specs, so comps cluster on
 * the same configuration and confidence can rise IF the evidence actually improves
 * (a tighter asking-only cluster is still capped sub-gate — earned, not inflated).
 *
 * Persists like a fresh run: the merged specs onto `items.attributes`, and a NEW
 * `prediction_logs` row (the review page reads the newest), so the suggested price,
 * range, confidence, tier, and sources all update. We deliberately DON'T touch the
 * listing's autopilot status — a manual re-price keeps the human in control rather
 * than silently auto-queueing. All writes go through the user-scoped client (RLS).
 */
export async function sharpenEstimate(formData: FormData) {
  const itemId = formData.get("itemId");
  if (typeof itemId !== "string" || itemId.length === 0) {
    redirect("/upload");
  }
  const id = itemId as string;
  const expectedReviewRevision = reviewRevisionFrom(formData, id);

  // Chips (each a hidden `spec` input) plus any live, un-added `detail` text, so
  // "type then Re-price" works even if the seller never pressed Add. Split on
  // commas/newlines, trim, drop blanks — the merge step de-dupes downstream.
  const chips = formData.getAll("spec").filter((v): v is string => typeof v === "string");
  const detail = typeof formData.get("detail") === "string" ? (formData.get("detail") as string) : "";
  const addedSpecs = [...chips, ...detail.split(/[,\n]/)]
    .map((s) => s.trim())
    .filter(Boolean);
  if (addedSpecs.length === 0) {
    backTo(id, "Add a detail (e.g. exact model, GPU, or storage) to sharpen the estimate.");
  }

  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) redirect(`/login?next=/review/${id}`);

  const { data: item, error: readError } = await supabase
    .from("items")
    .select("id, attributes, review_revision")
    .eq("id", id)
    .maybeSingle();
  if (readError) {
    reportServerError("review.sharpen.read", readError);
    backTo(id, "Failed to re-price. Please try again.");
  }
  if (!item) {
    backTo(id, "Item not found.");
  }
  if (item.review_revision !== expectedReviewRevision) {
    backTo(id, "This review changed. Reload and try again.");
  }

  const { data: ebayListings, error: listingReadError } = await supabase
    .from("listings")
    .select("status, ebay_listing_id, ebay_status")
    .eq("item_id", id)
    .eq("platform", "ebay");
  if (listingReadError) {
    reportServerError("review.sharpen.listings", listingReadError);
    backTo(id, "Failed to re-price. Please try again.");
  }
  if (
    (ebayListings ?? []).some((listing) =>
      isReviewRegenerationBlocked({
        status: listing.status as string | null,
        ebayListingId: listing.ebay_listing_id as string | null,
        ebayStatus: listing.ebay_status as string | null,
      }),
    )
  ) {
    backTo(id, "A published listing cannot be changed from review.");
  }

  // The prior run's model + autopilot switch ride forward so the new log stays
  // attributable and the disposition explanation coherent.
  const { data: log } = await supabase
    .from("prediction_logs")
    .select("model, listing_model, autopilot_enabled")
    .eq("item_id", id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!log) {
    backTo(id, "This item hasn't been priced yet — nothing to sharpen.");
  }

  const rawAttrs = (item.attributes ?? {}) as Record<string, unknown>;
  const parsedAttrs = extractedAttributesSchema.safeParse(rawAttrs);
  const attributes = parsedAttrs.success ? parsedAttrs.data : {};
  const autopilotEnabled =
    typeof log.autopilot_enabled === "boolean" ? log.autopilot_enabled : undefined;

  let reprice: Awaited<ReturnType<typeof repriceWithSpecs>>;
  try {
    reprice = await repriceWithSpecs({ attributes, addedSpecs, autopilotEnabled });
  } catch (err) {
    reportServerError("review.sharpen.reprice", err);
    backTo(id, "We couldn't re-research the price just now. Please try again.");
  }

  // Preserve every existing attribute key (category merged by saveReview, etc.) and
  // only update specs — parsing strips unknown keys, so merge into the RAW JSON.
  const nextAttributes = { ...rawAttrs, specs: reprice.mergedSpecs };
  const result: PipelineResult = {
    attributes: reprice.attributes,
    price: reprice.price,
    confidence: reprice.confidence,
    listing: { platform: "ebay", title: "", description: "", fields: {} },
    model: (log.model as string | null) ?? "unknown",
    listingModel: (log.listing_model as string | null) ?? undefined,
    pricingModel: reprice.price.model,
  };
  const runId = crypto.randomUUID();
  const prediction = buildPredictionLogRow(userId, id, result, {
    autopilotEnabled,
    runId,
  });
  const { error: sharpenError } = await supabase.rpc("sharpen_review_estimate", {
    p_item_id: id,
    p_expected_review_revision: expectedReviewRevision,
    p_run_id: runId,
    p_attributes: nextAttributes,
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
  if (sharpenError) {
    reportServerError("review.sharpen.save", sharpenError);
    backTo(
      id,
      reviewWriteError(
        sharpenError,
        "We re-priced but couldn't save it. Please try again.",
      ),
    );
  }

  logEvent("review.sharpen", {
    itemId: id,
    addedCount: addedSpecs.length,
    tier: reprice.price.tier,
    confidence: reprice.confidence.score,
    band: reprice.confidence.band,
  });
  revalidatePath(`/review/${id}`);
  backTo(id);
}
