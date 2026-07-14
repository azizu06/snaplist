import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { entitlementTierFromStatus, type Tier } from "./config";
import type { BillingCustomerStore, CheckoutClaim } from "./lifecycle";
import type {
  EntitlementStore,
  NormalizedSubscription,
  StripeEventClaim,
} from "./webhook";

/**
 * Entitlement reads + the Supabase-backed webhook store (issue #64).
 *
 * `getEntitlement` is the seam the app reads instead of the pure `resolveTier`
 * default: a fast, RLS-guarded lookup of the user's mirrored `subscriptions` row.
 * Active/trialing mirrors with a recorded period end stay paid only until that
 * timestamp passes.
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
      .select("status, current_period_end")
      .eq("user_id", userId)
      .maybeSingle();
    const row = data as { status?: string; current_period_end?: unknown } | null;
    const tier = entitlementTierFromStatus(row?.status);

    // An active or trialing status is paid only while a recorded period remains
    // current. The mirror is asynchronously updated by webhooks, so an expired
    // or malformed period must fail closed rather than extending Seller Pro.
    if (tier === "paid" && row?.current_period_end != null) {
      if (typeof row.current_period_end !== "string") return "free";
      const periodEnd = Date.parse(row.current_period_end);
      if (!Number.isFinite(periodEnd) || periodEnd <= Date.now()) return "free";
    }

    return tier;
  } catch {
    return "free"; // entitlement is best-effort: a read failure never over-entitles
  }
}

/** Postgres unique-violation — a concurrent webhook already recorded this event. */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "23505";
}

/**
 * The trusted billing lifecycle store. All Customer-map and webhook writes go
 * through a server-only service-role client; users only read their own mirrored
 * `subscriptions` row through `getEntitlement` above.
 */
export interface BillingLifecycleStore extends EntitlementStore, BillingCustomerStore {}

/**
 * The webhook's persistence store, backed by the SERVICE-ROLE admin client (it
 * bypasses RLS — entitlement is written only here, never by the user). Pass
 * `createAdminClient()` from the webhook route.
 */
export function createSupabaseEntitlementStore(
  admin: SupabaseClient,
): BillingLifecycleStore {
  return {
    async customerIdForUser(userId) {
      const { data, error } = await admin
        .from("billing_customers")
        .select("stripe_customer_id")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;
      return (data as { stripe_customer_id?: string } | null)?.stripe_customer_id ?? null;
    },

    async saveCustomerIdForUser(userId, customerId) {
      const { error } = await admin
        .from("billing_customers")
        .insert({ user_id: userId, stripe_customer_id: customerId });
      if (!error) return;
      if (!isUniqueViolation(error)) throw error;

      // A concurrent first Checkout may have saved the same Customer first. It is
      // safe to reuse only if the immutable mapping agrees exactly; a conflicting
      // map fails closed rather than ever associating a Customer with two tenants.
      const { data, error: readError } = await admin
        .from("billing_customers")
        .select("stripe_customer_id")
        .eq("user_id", userId)
        .maybeSingle();
      if (readError) throw readError;
      if ((data as { stripe_customer_id?: string } | null)?.stripe_customer_id === customerId) {
        return;
      }
      throw new Error("Stripe Customer mapping conflicts with an existing SnapList user.");
    },

    async claimCheckout(userId, customerId): Promise<CheckoutClaim> {
      const { data, error } = await admin.rpc("claim_billing_checkout", {
        p_user_id: userId,
        p_stripe_customer_id: customerId,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : null;
      if (!row || typeof row.state !== "string") throw new Error("Billing Checkout claim returned no state.");
      if (row.state === "ready" && typeof row.checkout_url === "string") {
        return { state: "ready", url: row.checkout_url };
      }
      if (
        row.state === "claim" &&
        typeof row.idempotency_key === "string" &&
        typeof row.claim_token === "string"
      ) {
        return {
          state: "claim",
          idempotencyKey: row.idempotency_key,
          claimToken: row.claim_token,
        };
      }
      if (row.state === "in_progress") return { state: "in_progress" };
      throw new Error("Billing Checkout claim returned an invalid state.");
    },

    async completeCheckoutClaim(input) {
      const { data, error } = await admin.rpc("complete_billing_checkout_claim", {
        p_user_id: input.userId,
        p_claim_token: input.claimToken,
        p_checkout_session_id: input.checkoutSessionId,
        p_checkout_url: input.checkoutUrl,
        p_expires_at: input.expiresAt,
      });
      if (error) throw error;
      if (data !== true) throw new Error("Billing Checkout claim was lost before completion.");
    },

    async releaseCheckoutClaim(userId, claimToken) {
      const { error } = await admin.rpc("release_billing_checkout_claim", {
        p_user_id: userId,
        p_claim_token: claimToken,
      });
      if (error) throw error;
    },

    async userIdForStripeCustomer(customerId) {
      const { data, error } = await admin
        .from("billing_customers")
        .select("user_id")
        .eq("stripe_customer_id", customerId)
        .maybeSingle();
      if (error) throw error;
      return (data as { user_id?: string } | null)?.user_id ?? null;
    },

    async claimEvent(eventId, type): Promise<StripeEventClaim> {
      const { data, error } = await admin.rpc("claim_stripe_event", {
        p_event_id: eventId,
        p_type: type,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : null;
      if (!row || typeof row.state !== "string") throw new Error("Stripe event claim returned no state.");
      if (row.state === "claimed" && typeof row.claim_token === "string") {
        return { state: "claimed", claimToken: row.claim_token };
      }
      if (row.state === "duplicate" || row.state === "in_progress") return { state: row.state };
      throw new Error("Stripe event claim returned an invalid state.");
    },

    async completeEventClaim(eventId, claimToken) {
      const { data, error } = await admin.rpc("complete_stripe_event_claim", {
        p_event_id: eventId,
        p_claim_token: claimToken,
      });
      if (error) throw error;
      if (data !== true) throw new Error("Stripe event claim was lost before completion.");
    },

    async releaseEventClaim(eventId, claimToken) {
      const { error } = await admin.rpc("release_stripe_event_claim", {
        p_event_id: eventId,
        p_claim_token: claimToken,
      });
      if (error) throw error;
    },

    async upsertSubscription(sub: NormalizedSubscription) {
      const { error } = await admin.rpc("upsert_billing_subscription", {
        p_user_id: sub.userId,
        p_stripe_customer_id: sub.stripeCustomerId,
        p_stripe_subscription_id: sub.stripeSubscriptionId,
        p_status: sub.status,
        p_current_period_end: sub.currentPeriodEnd ?? null,
        p_stripe_observed_at: sub.stripeObservedAt,
      });
      if (error) throw error;
    },

    async clearCheckoutReservation(input) {
      const { error } = await admin.rpc("clear_billing_checkout_reservation", {
        p_user_id: input.userId,
        p_stripe_customer_id: input.customerId,
        p_checkout_session_id: input.checkoutSessionId,
      });
      if (error) throw error;
    },
  };
}
