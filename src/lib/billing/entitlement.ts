import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import type { Tier } from "./config";
import type { EntitlementStore, NormalizedSubscription } from "./webhook";

/**
 * Entitlement reads + the Supabase-backed webhook store (issue #64).
 *
 * `getEntitlement` is the seam the app reads instead of the pure `resolveTier`
 * default: a fast, RLS-guarded lookup of the user's mirrored `subscriptions` row.
 * It is FAIL-SAFE — any error / missing row resolves to `free`, so a billing or DB
 * hiccup can never *grant* entitlement nor block a request.
 *
 * The store is written ONLY by the webhook on the service-role admin client (RLS
 * bypass), keeping entitlement un-forgeable from the client.
 */

/** Resolve a user's entitlement tier from the mirror. Never throws; defaults free. */
export async function getEntitlement(
  userId: string,
  client?: SupabaseClient,
): Promise<Tier> {
  try {
    const db = client ?? (await createClient());
    const { data } = await db
      .from("subscriptions")
      .select("tier")
      .eq("user_id", userId)
      .maybeSingle();
    return (data as { tier?: string } | null)?.tier === "paid" ? "paid" : "free";
  } catch {
    return "free"; // entitlement is best-effort: a read failure never over-entitles
  }
}

/** Postgres unique-violation — a concurrent webhook already recorded this event. */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "23505";
}

/**
 * The webhook's persistence store, backed by the SERVICE-ROLE admin client (it
 * bypasses RLS — entitlement is written only here, never by the user). Pass
 * `createAdminClient()` from the webhook route.
 */
export function createSupabaseEntitlementStore(
  admin: SupabaseClient,
  now: () => Date = () => new Date(),
): EntitlementStore {
  return {
    async alreadyProcessed(eventId) {
      const { data } = await admin
        .from("stripe_events")
        .select("event_id")
        .eq("event_id", eventId)
        .maybeSingle();
      return data != null;
    },

    async markProcessed(eventId, type) {
      const { error } = await admin
        .from("stripe_events")
        .insert({ event_id: eventId, type });
      // A concurrent delivery may have inserted the same id first — that's the
      // idempotency working, not a failure. Re-throw anything else.
      if (error && !isUniqueViolation(error)) throw error;
    },

    async upsertSubscription(sub: NormalizedSubscription) {
      const { error } = await admin.from("subscriptions").upsert(
        {
          user_id: sub.userId,
          stripe_customer_id: sub.stripeCustomerId ?? null,
          stripe_subscription_id: sub.stripeSubscriptionId ?? null,
          tier: sub.tier,
          status: sub.status,
          current_period_end: sub.currentPeriodEnd ?? null,
          updated_at: now().toISOString(),
        },
        { onConflict: "user_id" },
      );
      if (error) throw error;
    },
  };
}
