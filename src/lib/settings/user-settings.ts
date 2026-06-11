import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Per-user settings access (issue #12). First setting: the master autopilot
 * switch. The `user_settings` table is an OVERRIDE store — a missing row means
 * "all defaults", so reads never require a prior write and existing users need
 * no backfill.
 *
 * All access goes through the caller's USER-SCOPED client: RLS pins every row
 * to auth.uid(), so these helpers can never read or write another user's
 * settings (AGENTS.md non-negotiable #1).
 */

/** Default when the user has no settings row: autopilot is ON. */
export const AUTOPILOT_DEFAULT = true;

/**
 * Read the user's master autopilot switch. Missing row → the default (enabled).
 * Throws on a real query error — silently defaulting on a failed read could
 * auto-post for a user who explicitly turned autopilot off.
 */
export async function getAutopilotEnabled(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("user_settings")
    .select("autopilot_enabled")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read user settings: ${error.message}`);
  }
  return data?.autopilot_enabled ?? AUTOPILOT_DEFAULT;
}

/**
 * Set the user's master autopilot switch. Upserts so the first toggle creates
 * the row; RLS WITH CHECK rejects a spoofed user_id.
 */
export async function setAutopilotEnabled(
  supabase: SupabaseClient,
  userId: string,
  enabled: boolean,
): Promise<void> {
  const { error } = await supabase
    .from("user_settings")
    .upsert({ user_id: userId, autopilot_enabled: enabled }, { onConflict: "user_id" });
  if (error) {
    throw new Error(`Failed to update user settings: ${error.message}`);
  }
}
