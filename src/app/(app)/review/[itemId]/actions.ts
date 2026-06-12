"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import { parseReviewEdits } from "@/lib/pipeline";

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
    backTo(id, `Failed to save: ${readError.message}`);
  }
  if (!item) {
    backTo(id, "Item not found.");
  }

  const attributes = {
    ...((item.attributes ?? {}) as Record<string, unknown>),
    category: edits.category,
  };

  const { data: updated, error: itemError } = await supabase
    .from("items")
    .update({
      attributes,
      condition: edits.condition,
      price_override: edits.override,
    })
    .eq("id", id)
    .select("id");
  if (itemError) {
    backTo(id, `Failed to save: ${itemError.message}`);
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
      backTo(id, `Failed to save the listing copy: ${listingError.message}`);
    }
    if (!updatedListing || updatedListing.length === 0) {
      backTo(id, "Listing not found.");
    }
  }

  revalidatePath(`/review/${id}`);
  backTo(id);
}
