import type { StripeWebhookEvent } from "./adapter";
import { entitlementTierFromStatus, type Tier } from "./config";

/**
 * Webhook → entitlement state (issue #64). The mapping from a Stripe event to the
 * row we mirror is PURE (`subscriptionFromEvent`), and the orchestration is
 * idempotent (`handleStripeEvent`) — both unit-testable without the SDK or a DB.
 *
 * Idempotency (Stripe delivers AT LEAST once): we (a) dedupe on `event.id` via the
 * store, and (b) write the row as a STATE UPSERT keyed by `user_id` — so even a
 * replayed or out-of-order event converges to the same final row. Dedupe is
 * checked first; the row is upserted BEFORE the event is marked processed, so a
 * crash mid-flight re-processes (the upsert is idempotent) rather than dropping it.
 */

/** The normalized entitlement state mirrored into `subscriptions`. */
export interface NormalizedSubscription {
  userId: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  status: string;
  /** ISO timestamp, or undefined when the object carries no period end. */
  currentPeriodEnd?: string;
  tier: Tier;
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

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Stripe `current_period_end` is unix SECONDS; mirror it as an ISO string. */
function epochToIso(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value * 1000).toISOString()
    : undefined;
}

/** The user id Stripe carries for us: subscription metadata or the session ref. */
function userIdFrom(obj: Record<string, unknown>): string | undefined {
  const metadata = obj.metadata as Record<string, unknown> | undefined;
  return str(metadata?.user_id) ?? str(obj.client_reference_id);
}

/**
 * Extract the entitlement state from a handled event, or null to ignore it. The
 * derived `status` drives `tier` through the single mapping (`entitlementTierFromStatus`):
 *  - `checkout.session.completed` → the sub just activated → status "active";
 *  - `customer.subscription.created|updated` → the object's real status;
 *  - `customer.subscription.deleted` → "canceled" (→ free);
 *  - `invoice.payment_failed` → "past_due" (→ free; downgrade on non-payment).
 * Returns null (ignored) for an unhandled type or when no user id can be resolved.
 */
export function subscriptionFromEvent(
  event: StripeWebhookEvent,
): NormalizedSubscription | null {
  if (!isHandledEvent(event.type)) return null;
  const obj = event.object;
  const userId = userIdFrom(obj);
  if (!userId) return null; // can't map to a user → nothing to mirror

  let status: string;
  let stripeSubscriptionId: string | undefined;
  if (event.type === "checkout.session.completed") {
    status = "active";
    stripeSubscriptionId = str(obj.subscription);
  } else if (event.type === "customer.subscription.deleted") {
    status = "canceled";
    stripeSubscriptionId = str(obj.id);
  } else if (event.type === "invoice.payment_failed") {
    status = "past_due";
    stripeSubscriptionId = str(obj.subscription);
  } else {
    // customer.subscription.created | updated — object IS the Subscription.
    status = str(obj.status) ?? "incomplete";
    stripeSubscriptionId = str(obj.id);
  }

  return {
    userId,
    stripeCustomerId: str(obj.customer),
    stripeSubscriptionId,
    status,
    currentPeriodEnd: epochToIso(obj.current_period_end),
    tier: entitlementTierFromStatus(status),
  };
}

/** The persistence seam (Supabase-backed in prod; faked in tests). */
export interface EntitlementStore {
  /** Has this Stripe event id already been fully processed? */
  alreadyProcessed(eventId: string): Promise<boolean>;
  /** Record an event id as processed (idempotency ledger). */
  markProcessed(eventId: string, type: string): Promise<void>;
  /** State-upsert the entitlement row keyed by `user_id` (idempotent). */
  upsertSubscription(sub: NormalizedSubscription): Promise<void>;
}

export interface HandleResult {
  processed: boolean;
  reason?: "duplicate" | "ignored";
}

/**
 * Idempotently apply a verified webhook event. Dedupe → upsert → mark, in that
 * order, so a mid-flight failure re-processes (idempotent upsert) instead of being
 * dropped. `ignored` covers unhandled types / events with no resolvable user.
 */
export async function handleStripeEvent(
  event: StripeWebhookEvent,
  store: EntitlementStore,
): Promise<HandleResult> {
  if (await store.alreadyProcessed(event.id)) {
    return { processed: false, reason: "duplicate" };
  }
  const sub = subscriptionFromEvent(event);
  if (!sub) {
    // Mark handled-but-ignored too, so we don't re-evaluate it on every retry.
    await store.markProcessed(event.id, event.type);
    return { processed: false, reason: "ignored" };
  }
  await store.upsertSubscription(sub);
  await store.markProcessed(event.id, event.type);
  return { processed: true };
}
