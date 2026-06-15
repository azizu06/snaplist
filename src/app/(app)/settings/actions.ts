"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import { deleteEbayConnection } from "@/lib/marketplace/ebay";
import { reportServerError } from "@/lib/sentry";

/**
 * Disconnect the seller's eBay account (issue #17): deletes the stored
 * (encrypted) OAuth tokens. RLS scopes the delete to the caller's own row.
 * Reconnecting later just runs the consent flow again.
 */
export async function disconnectEbay() {
  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) redirect("/login?next=/settings");

  try {
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
