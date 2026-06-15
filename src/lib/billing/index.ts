/**
 * Billing public surface (issue #64) — freemium subscriptions via direct Stripe.
 * Stripe is behind the `StripeBillingAdapter` seam (real SDK lazy-imported; tests
 * use `MockStripeBillingAdapter`); Supabase mirrors entitlement, which the app
 * reads via `getEntitlement`. All test-mode.
 */
export {
  entitlementTierFromStatus,
  stripeConfigured,
  resolveStripeConfig,
  PAID_STRIPE_STATUSES,
  type Tier,
  type StripeConfig,
} from "./config";
export { getEntitlement, createSupabaseEntitlementStore } from "./entitlement";
export {
  subscriptionFromEvent,
  handleStripeEvent,
  isHandledEvent,
  type EntitlementStore,
  type NormalizedSubscription,
  type HandleResult,
} from "./webhook";
export {
  MockStripeBillingAdapter,
  createStripeBillingAdapter,
  type StripeBillingAdapter,
  type CheckoutParams,
  type PortalParams,
  type StripeWebhookEvent,
} from "./adapter";
