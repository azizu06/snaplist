"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createTenantServerClient } from "@/lib/supabase/tenant-server";
import { getUserId } from "@/lib/auth";
import { deleteEbayConnection } from "@/lib/marketplace/ebay";
import { reportServerError } from "@/lib/sentry";

/**
 * Disconnect the seller's eBay account (issue #17): retires the current
 * account generation and removes its encrypted OAuth tokens. Reconnecting
 * later runs the consent flow again.
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
