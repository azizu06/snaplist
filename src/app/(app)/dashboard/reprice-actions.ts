"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getUserId } from "@/lib/auth";
import { createEbayAdapterForUser, EbayApiError } from "@/lib/marketplace/ebay";
import {
  applyRepriceSuggestion,
  dismissRepriceSuggestion,
  RepriceApplyError,
} from "@/lib/reprice";
import { setAutoRepriceEnabled } from "@/lib/settings/user-settings";
import { reportServerError } from "@/lib/sentry";
import { createTenantServerClient } from "@/lib/supabase/tenant-server";

/**
 * Dashboard mutations for reprice suggestions (issue #102): one-tap apply,
 * dismiss, and the per-user auto-reprice opt-in. Thin server actions in the
 * dashboard/actions.ts mold — auth guard + RLS-scoped work, then revalidate.
 *
 * Tenancy: every read/write runs under the request-authed client, so RLS
 * (`public.clerk_user_id() = user_id`) constrains which rows can be touched —
 * a foreign suggestionId is simply not found. The apply path revises the live
 * eBay listing through the seller's own adapter (per-user OAuth when
 * connected, app-level env credentials otherwise — same as publish).
 */

export interface RepriceActionResult {
  ok: boolean;
  message: string;
}

export async function applyReprice(
  suggestionId: string,
): Promise<RepriceActionResult> {
  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) return { ok: false, message: "Not signed in." };

  try {
    const adapter = await createEbayAdapterForUser(supabase, userId, {
      credentialClient: createTenantServerClient,
    });
    const { appliedPrice } = await applyRepriceSuggestion(
      supabase,
      userId,
      suggestionId,
      adapter,
    );
    revalidatePath("/dashboard");
    return { ok: true, message: `New price is live: $${appliedPrice.toFixed(2)}` };
  } catch (err) {
    // User-actionable failures carry a SAFE message (not yours / already
    // resolved / no offer / currency); eBay's own summary is author-controlled
    // (EbayApiError.message, never the raw payload). Everything else is
    // redacted with the real error logged server-side (CWE-209 house rule).
    if (err instanceof RepriceApplyError || err instanceof EbayApiError) {
      return { ok: false, message: err.message };
    }
    reportServerError("reprice.apply", err, { suggestionId });
    return { ok: false, message: "Couldn't apply the new price. Please try again." };
  }
}

export async function dismissReprice(
  suggestionId: string,
): Promise<RepriceActionResult> {
  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) return { ok: false, message: "Not signed in." };

  try {
    await dismissRepriceSuggestion(supabase, suggestionId);
    revalidatePath("/dashboard");
    return { ok: true, message: "Suggestion dismissed." };
  } catch (err) {
    reportServerError("reprice.dismiss", err, { suggestionId });
    return { ok: false, message: "Couldn't dismiss the suggestion. Please try again." };
  }
}

export async function setAutoReprice(
  enabled: boolean,
): Promise<RepriceActionResult> {
  const supabase = await createClient();
  const userId = await getUserId();
  if (!userId) return { ok: false, message: "Not signed in." };

  try {
    await setAutoRepriceEnabled(supabase, userId, enabled);
    revalidatePath("/dashboard");
    return {
      ok: true,
      message: enabled
        ? "Auto-reprice is on for high-confidence checks."
        : "Auto-reprice is off — suggestions only.",
    };
  } catch (err) {
    reportServerError("reprice.toggle", err);
    return { ok: false, message: "Couldn't update the setting. Please try again." };
  }
}
