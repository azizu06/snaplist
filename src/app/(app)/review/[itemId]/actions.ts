"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import { parsePriceOverride } from "@/lib/pipeline";

/**
 * Review-page actions (issue #12): the seller's price override.
 *
 * The override persists on `items.price_override` through the USER-SCOPED server
 * client, so RLS proves ownership — updating another user's item matches zero
 * rows and is reported as a failure, never a silent no-op success. Downstream
 * consumers (the review display now, publish later) resolve the price via
 * `effectivePrice(suggested, override)` so the override flows everywhere.
 */

function backTo(itemId: string, error?: string): never {
  const suffix = error ? `?error=${encodeURIComponent(error)}` : "";
  redirect(`/review/${itemId}${suffix}`);
}

/** Set (or clear, when the field is blank) the seller's price override. */
export async function overridePrice(formData: FormData) {
  const itemId = formData.get("itemId");
  if (typeof itemId !== "string" || itemId.length === 0) {
    redirect("/upload");
  }
  const id = itemId as string;

  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) redirect(`/login?next=/review/${id}`);

  // Validate at the boundary: blank clears, junk is rejected loudly (a typo must
  // not silently clear an existing override).
  let override: number | null;
  try {
    override = parsePriceOverride(formData.get("price"));
  } catch (err) {
    backTo(id, err instanceof Error ? err.message : "Invalid price.");
  }

  // RLS-scoped update: a non-owned/missing item updates zero rows → surfaced as
  // an error instead of pretending the override saved.
  const { data, error } = await supabase
    .from("items")
    .update({ price_override: override })
    .eq("id", id)
    .select("id");
  if (error) {
    backTo(id, `Failed to save price: ${error.message}`);
  }
  if (!data || data.length === 0) {
    backTo(id, "Item not found.");
  }

  revalidatePath(`/review/${id}`);
  backTo(id);
}
