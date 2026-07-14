import type { StripeBillingAdapter, StripeSubscription, StripeWebhookEvent } from "./adapter";
import { entitlementTierFromStatus, type Tier } from "./config";

/**
 * Stripe webhook → entitlement mirror (issue #152).
 *
 * Stripe does not guarantee event ordering. Rather than accepting an old event's
 * payload, every handled event retrieves the Subscription's current state from
 * Stripe and maps its Customer through the durable server-owned customer map.
 * That makes old delivery converge on the latest authoritative subscription state.
 */

/** The normalized entitlement state mirrored into `subscriptions`. */
export interface NormalizedSubscription {
  userId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  status: string;
  /** ISO timestamp, or undefined when Stripe carries no period end. */
  currentPeriodEnd?: string;
  /** Local observation timestamp used to reject a late stale write atomically. */
  stripeObservedAt: string;
  tier: Tier;
}

export interface SubscriptionReference {
  customerId: string;
  subscriptionId: string;
  checkoutSessionId?: string;
}

const HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
]);

export function isHandledEvent(type: string): boolean {
  return HANDLED_EVENT_TYPES.has(type);
}

function idFrom(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (
    value != null &&
    typeof value === "object" &&
    "id" in value &&
    typeof (value as { id?: unknown }).id === "string" &&
    (value as { id: string }).id.length > 0
  ) {
    return (value as { id: string }).id;
  }
  return undefined;
}

/**
 * Extract only Stripe object ids from a verified handled event. This deliberately
 * never reads webhook metadata or client_reference_id to determine tenancy: the
 * durable Customer mapping is the sole app-side tenant authority.
 */
export function subscriptionReferenceFromEvent(
  event: StripeWebhookEvent,
): SubscriptionReference | null {
  if (!isHandledEvent(event.type)) return null;
  const customerId = idFrom(event.object.customer);
  const subscriptionId = idFrom(
    event.type === "checkout.session.completed" || event.type === "invoice.payment_failed"
      ? event.object.subscription
      : event.object.id,
  );
  const checkoutSessionId =
    event.type === "checkout.session.completed" ? idFrom(event.object.id) : undefined;
  return customerId && subscriptionId
    ? { customerId, subscriptionId, ...(checkoutSessionId ? { checkoutSessionId } : {}) }
    : null;
}

function epochToIso(value: number | undefined): string | undefined {
  return value != null && Number.isFinite(value) ? new Date(value * 1000).toISOString() : undefined;
}

export function subscriptionFromStripe(
  userId: string,
  subscription: StripeSubscription,
  observedAt: Date = new Date(),
): NormalizedSubscription {
  return {
    userId,
    stripeCustomerId: subscription.customerId,
    stripeSubscriptionId: subscription.id,
    status: subscription.status,
    currentPeriodEnd: epochToIso(subscription.currentPeriodEnd),
    stripeObservedAt: observedAt.toISOString(),
    tier: entitlementTierFromStatus(subscription.status),
  };
}

export type StripeEventClaim =
  | { state: "claimed"; claimToken: string }
  | { state: "duplicate" | "in_progress" };

/** The persistence seam (Supabase-backed in production; faked in tests). */
export interface EntitlementStore {
  /** Atomically claim a delivery, preserving a bounded recovery lease after a crash. */
  claimEvent(eventId: string, type: string): Promise<StripeEventClaim>;
  /** Finalize only the caller's own claim after its mirror write succeeds. */
  completeEventClaim(eventId: string, claimToken: string): Promise<void>;
  /** Release a failed claim so Stripe's retry can immediately process it. */
  releaseEventClaim(eventId: string, claimToken: string): Promise<void>;
  /** Resolve a Stripe Customer only through the server-owned tenant mapping. */
  userIdForStripeCustomer(customerId: string): Promise<string | null>;
  /** State-upsert the entitlement row keyed by `user_id` (idempotent). */
  upsertSubscription(sub: NormalizedSubscription): Promise<void>;
  /** Clear exactly the completed hosted Checkout reservation, if any. */
  clearCheckoutReservation(input: {
    userId: string;
    customerId: string;
    checkoutSessionId: string;
  }): Promise<void>;
}

export interface HandleResult {
  processed: boolean;
  reason?: "duplicate" | "ignored";
}

/**
 * Idempotently apply a verified webhook event. Dedupe → retrieve current Stripe
 * Subscription → state upsert → mark, in that order. A retrieval or persistence
 * failure is intentionally not marked, so Stripe retries it instead of dropping a
 * lifecycle change.
 */
export async function handleStripeEvent(
  event: StripeWebhookEvent,
  store: EntitlementStore,
  adapter: Pick<StripeBillingAdapter, "retrieveSubscription">,
  now: () => Date = () => new Date(),
): Promise<HandleResult> {
  const claim = await store.claimEvent(event.id, event.type);
  if (claim.state !== "claimed") {
    if (claim.state === "duplicate") {
      return { processed: false, reason: "duplicate" };
    }
    throw new Error("Stripe event is already being processed; retry later.");
  }
  const claimToken = claim.claimToken;

  try {
    const reference = subscriptionReferenceFromEvent(event);
    if (!reference) {
      await store.completeEventClaim(event.id, claimToken);
      return { processed: false, reason: "ignored" };
    }

    const userId = await store.userIdForStripeCustomer(reference.customerId);
    if (!userId) {
      // A signed event without a server-owned mapping is never allowed to pick a
      // tenant from metadata. Ignore it safely rather than risking cross-tenant access.
      await store.completeEventClaim(event.id, claimToken);
      return { processed: false, reason: "ignored" };
    }

    // Record when this worker begins observing the authoritative object. A slow
    // retrieve must never receive a later timestamp than a newer worker that has
    // already observed and mirrored a changed Subscription.
    const observedAt = now();
    const subscription = await adapter.retrieveSubscription(reference.subscriptionId);
    if (subscription.id !== reference.subscriptionId || subscription.customerId !== reference.customerId) {
      throw new Error("Stripe Subscription does not match its verified webhook reference.");
    }

    await store.upsertSubscription(subscriptionFromStripe(userId, subscription, observedAt));
    if (reference.checkoutSessionId) {
      await store.clearCheckoutReservation({
        userId,
        customerId: reference.customerId,
        checkoutSessionId: reference.checkoutSessionId,
      });
    }
    await store.completeEventClaim(event.id, claimToken);
    return { processed: true };
  } catch (error) {
    await store.releaseEventClaim(event.id, claimToken).catch(() => undefined);
    throw error;
  }
}
