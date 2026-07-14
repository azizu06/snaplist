"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createTenantServerClient } from "@/lib/supabase/tenant-server";
import { getUserId } from "@/lib/auth";
import { deleteEbayConnection } from "@/lib/marketplace/ebay";
import { reportServerError } from "@/lib/sentry";
import { setAutoReplyEnabled } from "@/lib/settings/user-settings";

/** Persist the single default-off seller opt-in for grounded safe-fact replies. */
export async function setAutoReplySetting(formData: FormData) {
  const userId = await getUserId();
  if (!userId) redirect("/login?next=/settings");
  try {
    const supabase = await createTenantServerClient();
    await setAutoReplyEnabled(
      supabase,
      userId,
      formData.get("enabled") === "true",
    );
  } catch (err) {
    reportServerError("settings.auto-reply", err);
    redirect(
      `/settings?error=${encodeURIComponent("Couldn't update automatic buyer replies. Please try again.")}`,
    );
  }
  revalidatePath("/settings");
  redirect("/settings");
}

/**
 * Disconnect the seller's eBay account (issue #17): retires the current
 * account generation, removes encrypted OAuth tokens, clears its sync cursor,
 * and marks generation-bound unresolved delivery unavailable. Reconnecting
 * starts a fresh generation and consent flow; stale work cannot dispatch.
 */
export async function disconnectEbay() {
  const userId = await getUserId();
  if (!userId) redirect("/login?next=/settings");

  try {
    const supabase = await createTenantServerClient();
    await deleteEbayConnection(supabase);
  } catch (err) {
    reportServerError("ebay.disconnect", err);
    redirect(
      `/settings?error=${encodeURIComponent("Failed to disconnect eBay. Please try again.")}`,
    );
  }

  revalidatePath("/settings");
  redirect("/settings?ebay=disconnected");
}
