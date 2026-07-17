import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import type { Tier } from "./config";
import { getEntitlement } from "./entitlement";

export type NewAiItemRunPolicyReason =
  | "included-first-run"
  | "snaplist-pro"
  | "snaplist-pro-required"
  | "policy-unavailable";

export interface NewAiItemRunPolicy {
  allowed: boolean;
  reason: NewAiItemRunPolicyReason;
  /** Temporary legacy Stripe mirror result. Never supplied by the client. */
  entitlement: Tier;
  /** Null means the evidence read failed and the decision failed closed. */
  hasCompletedAiItemRun: boolean | null;
}

export interface ResolveNewAiItemRunPolicyOptions {
  /** Must be the authenticated caller's request-scoped, RLS-enforcing client. */
  client?: SupabaseClient;
}

/**
 * Legacy read-only policy snapshot retained for #166 compatibility tests.
 *
 * A generated listing
 * (`run_id` present) is the narrow legacy evidence that one prior run reached a
 * usable draft: the synchronous path writes its prediction before the listing,
 * while the durable worker commits both coherently. Failed/partial items have no
 * generated listing and therefore do not consume the included first run here.
 *
 * #168 removed this read from every live provider-backed entry point because it
 * cannot authorize concurrent starts. Only the database ledger may authorize a
 * new run; do not add new runtime callers.
 *
 * @deprecated Use durable staging and its atomic AI-item credit reservation.
 */
export async function resolveNewAiItemRunPolicy(
  userId: string,
  options: ResolveNewAiItemRunPolicyOptions = {},
): Promise<NewAiItemRunPolicy> {
  const db = options.client ?? (await createClient());

  try {
    // RLS is authoritative; the explicit user filter is defense in depth and
    // prevents a caller from accidentally treating another tenant's draft as
    // evidence for this tenant.
    const { data, error } = await db
      .from("listings")
      .select("id")
      .eq("user_id", userId)
      .not("run_id", "is", null)
      .limit(1);

    if (error) {
      return {
        allowed: false,
        reason: "policy-unavailable",
        entitlement: "free",
        hasCompletedAiItemRun: null,
      };
    }

    const hasCompletedAiItemRun = (data?.length ?? 0) > 0;
    const entitlement = await getEntitlement(userId, db);

    if (!hasCompletedAiItemRun) {
      return {
        allowed: true,
        reason: "included-first-run",
        entitlement,
        hasCompletedAiItemRun,
      };
    }

    if (entitlement === "paid") {
      return {
        allowed: true,
        reason: "snaplist-pro",
        entitlement,
        hasCompletedAiItemRun,
      };
    }

    return {
      allowed: false,
      reason: "snaplist-pro-required",
      entitlement,
      hasCompletedAiItemRun,
    };
  } catch {
    return {
      allowed: false,
      reason: "policy-unavailable",
      entitlement: "free",
      hasCompletedAiItemRun: null,
    };
  }
}
