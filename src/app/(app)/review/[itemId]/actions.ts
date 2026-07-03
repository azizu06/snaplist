"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import { parseReviewEdits } from "@/lib/pipeline";
import { repriceWithSpecs } from "@/lib/pipeline/reprice";
import { logPrediction } from "@/lib/pipeline/prediction-log";
import { extractedAttributesSchema, type PipelineResult } from "@/lib/pipeline/types";
import {
  garmentClassOf,
  parseMeasurementEdits,
  GARMENT_MEASUREMENT_SETS,
  type SubmittedMeasurement,
} from "@/lib/vision/measurements";
import { logEvent } from "@/lib/observability";
import { reportServerError } from "@/lib/sentry";

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

/**
 * Save the seller's review edits (UI pass: "the title, category, condition
 * and price — can we not change that?"). One submit persists every AI-filled
 * field the seller may have touched:
 *
 * - listing title + description → `listings` (only when a listing row exists);
 * - category → merged into `items.attributes` (the same JSON the export packs
 *   and re-listing flows read);
 * - condition → `items.condition`;
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

  // Read the current attributes so the category merge never clobbers the rest
  // of the extracted JSON. RLS scopes the read; a missing/foreign row → error.
  const { data: item, error: readError } = await supabase
    .from("items")
    .select("id, attributes")
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
  let measurements = existingAttrs.measurements;
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
      measurements = parseMeasurementEdits(
        existingAttrs.measurements ?? [],
        submitted,
        garmentClass,
      );
    } catch (err) {
      backTo(id, err instanceof Error ? err.message : "Invalid measurement.");
    }
  }

  const attributes = {
    ...((item.attributes ?? {}) as Record<string, unknown>),
    category: edits.category,
    // Only touch measurements for garments; keep the key absent otherwise.
    ...(garmentClass ? { measurements } : {}),
  };

  const { data: updated, error: itemError } = await supabase
    .from("items")
    .update({
      attributes,
      condition: edits.condition,
      price_override: edits.override,
      // #101: what the seller paid — blank clears to NULL (unknown), never $0.
      cost_basis: edits.costBasis,
    })
    .eq("id", id)
    .select("id");
  if (itemError) {
    reportServerError("review.save.item", itemError);
    backTo(id, "Failed to save changes. Please try again.");
  }
  if (!updated || updated.length === 0) {
    backTo(id, "Item not found.");
  }

  if (hasListing && edits.listing) {
    const { data: updatedListing, error: listingError } = await supabase
      .from("listings")
      .update({
        title: edits.listing.title,
        description: edits.listing.description,
      })
      .eq("id", listingId as string)
      .eq("item_id", id)
      .select("id");
    if (listingError) {
      reportServerError("review.save.listing", listingError);
      backTo(id, "Failed to save the listing copy. Please try again.");
    }
    if (!updatedListing || updatedListing.length === 0) {
      backTo(id, "Listing not found.");
    }
  }

  revalidatePath(`/review/${id}`);
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
    .select("id, attributes")
    .eq("id", id)
    .maybeSingle();
  if (readError) {
    reportServerError("review.sharpen.read", readError);
    backTo(id, "Failed to re-price. Please try again.");
  }
  if (!item) {
    backTo(id, "Item not found.");
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
  const { data: updated, error: itemError } = await supabase
    .from("items")
    .update({ attributes: nextAttributes })
    .eq("id", id)
    .select("id");
  if (itemError) {
    reportServerError("review.sharpen.item", itemError);
    backTo(id, "Failed to save the re-priced result. Please try again.");
  }
  if (!updated || updated.length === 0) {
    backTo(id, "Item not found.");
  }

  // Log a fresh prediction (newest row wins on the review page). `buildPredictionLogRow`
  // does not read `listing`, so a minimal placeholder keeps the PipelineResult type
  // honest without an extra query for an unused value.
  const result: PipelineResult = {
    attributes: reprice.attributes,
    price: reprice.price,
    confidence: reprice.confidence,
    listing: { platform: "ebay", title: "", description: "", fields: {} },
    model: (log.model as string | null) ?? "unknown",
    listingModel: (log.listing_model as string | null) ?? undefined,
    pricingModel: reprice.price.model,
  };
  try {
    await logPrediction(supabase, userId, id, result, {
      autopilotEnabled,
      runId: crypto.randomUUID(),
    });
  } catch (err) {
    reportServerError("review.sharpen.log", err);
    backTo(id, "We re-priced but couldn't save it. Please try again.");
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
