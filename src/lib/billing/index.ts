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
export {
  getEntitlement,
  createSupabaseEntitlementStore,
  type BillingLifecycleStore,
} from "./entitlement";
export {
  resolveNewAiItemRunPolicy,
  type NewAiItemRunPolicy,
  type NewAiItemRunPolicyReason,
  type ResolveNewAiItemRunPolicyOptions,
} from "./item-run-policy";
export {
  subscriptionFromStripe,
  subscriptionReferenceFromEvent,
  handleStripeEvent,
  isHandledEvent,
  type EntitlementStore,
  type NormalizedSubscription,
  type HandleResult,
} from "./webhook";
export {
  startCheckout,
  type BillingCustomerStore,
  type CheckoutLifecycleAdapter,
  type StartCheckoutInput,
  type StartCheckoutResult,
} from "./lifecycle";
export {
  MockStripeBillingAdapter,
  createStripeBillingAdapter,
  type StripeBillingAdapter,
  type CheckoutParams,
  type PortalParams,
  type StripeSubscription,
  type StripeWebhookEvent,
} from "./adapter";
export {
  handleRevenueCatWebhook,
  parseAndVerifyRevenueCatWebhook,
  resolveRevenueCatServerConfig,
  type RevenueCatEntitlementStore,
  type RevenueCatEnvironment,
  type RevenueCatServerConfig,
  type RevenueCatWebhookConfig,
  type VerifiedStoreKitPeriod,
} from "./revenuecat";
export {
  createSupabaseNativeSubscriptionBridge,
  createSupabaseRevenueCatEntitlementStore,
  type NativeRevenueCatConfiguration,
  type NativeSubscriptionBridge,
  type VerifiedAiItemEntitlement,
} from "./revenuecat-store";
