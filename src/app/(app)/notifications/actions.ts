"use server";

import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";

/**
 * Notification actions (top-bar bell). RLS already isolates rows to
 * clerk_user_id(); the getUserId guard is defense-in-depth, matching the
 * other server actions (e.g. listings/[listingId]/actions.ts). The bell
 * updates its own state optimistically, so these return void.
 */

export async function markNotificationRead(id: string): Promise<void> {
  if (!id) return;
  const userId = await getUserId();
  if (!userId) return;
  const supabase = await createClient();
  // RLS scopes the row to the caller; the .eq("id") just targets one.
  await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .is("read_at", null);
}

export async function markAllNotificationsRead(): Promise<void> {
  const userId = await getUserId();
  if (!userId) return;
  const supabase = await createClient();
  // RLS scopes to the caller's rows; flip every still-unread one.
  await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .is("read_at", null);
}
