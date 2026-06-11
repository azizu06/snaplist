"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import { deleteEbayConnection } from "@/lib/marketplace/ebay";

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
    const message =
      err instanceof Error ? err.message : "Failed to disconnect eBay.";
    redirect(`/settings?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/settings");
  redirect("/settings?ebay=disconnected");
}
