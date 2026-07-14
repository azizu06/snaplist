import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Per-user settings access (issue #12). The first setting is publish eligibility,
 * persisted under the legacy `autopilot_enabled` name. It marks readiness and
 * never publishes a new listing. The `user_settings` table is an OVERRIDE store — a missing row means
 * "all defaults", so reads never require a prior write and existing users need
 * no backfill.
 *
 * All access goes through the caller's USER-SCOPED client: RLS pins every row
 * to auth.uid(), so these helpers can never read or write another user's
 * settings (AGENTS.md non-negotiable #1).
 */

/** Default when the user has no settings row: publish eligibility is ON. */
export const AUTOPILOT_DEFAULT = true;

/**
 * Read the user's publish-eligibility switch. Missing row → the default (enabled).
 * Throws on a real query error — silently defaulting on a failed read could
 * mark ready for a user who explicitly turned publish eligibility off.
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
 * Default when the user has no settings row: auto-reprice is OFF (issue #102).
 * Deliberately the opposite polarity of the publish-eligibility default —
 * auto-applying a price change to a LIVE listing requires an explicit opt-in.
 */
export const AUTO_REPRICE_DEFAULT = false;

/**
 * Read BOTH switches the repricing pipeline consumes in one round trip:
 * the publish-eligibility switch (feeds the composite confidence gate) and the
 * auto-reprice opt-in. Missing row → defaults (eligibility ON, auto-reprice
 * OFF). Throws on a real query error — silently defaulting could auto-apply
 * for a user whose read failed.
 */
export async function getRepriceSettings(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ autopilotEnabled: boolean; autoRepriceEnabled: boolean }> {
  const { data, error } = await supabase
    .from("user_settings")
    .select("autopilot_enabled, auto_reprice_enabled")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read user settings: ${error.message}`);
  }
  return {
    autopilotEnabled: data?.autopilot_enabled ?? AUTOPILOT_DEFAULT,
    autoRepriceEnabled: data?.auto_reprice_enabled ?? AUTO_REPRICE_DEFAULT,
  };
}

/**
 * Set the user's auto-reprice opt-in (issue #102). Upserts so the first toggle
 * creates the row; RLS WITH CHECK rejects a spoofed user_id.
 */
export async function setAutoRepriceEnabled(
  supabase: SupabaseClient,
  userId: string,
  enabled: boolean,
): Promise<void> {
  const { error } = await supabase
    .from("user_settings")
    .upsert(
      { user_id: userId, auto_reprice_enabled: enabled },
      { onConflict: "user_id" },
    );
  if (error) {
    throw new Error(`Failed to update user settings: ${error.message}`);
  }
}

/**
 * Set the user's publish-eligibility switch (legacy function/column name). Upserts so the first toggle creates
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
