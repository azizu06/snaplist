import type { Tier } from "../abuse/config";

/**
 * Billing config + the Stripe-status → entitlement-tier mapping (issue #64).
 *
 * Stripe is the billing system of record; the app reads a `Tier` ("free" | "paid")
 * mirrored into Postgres by the webhook. This module owns the ONE rule that turns a
 * raw Stripe subscription status into that tier — pure and table-driven so it's
 * unit-testable and there's a single place the policy lives.
 *
 * Test mode: all keys are Stripe TEST keys; going live is a key swap (no code).
 */

export type { Tier } from "../abuse/config";

/**
 * Stripe statuses that confer the paid tier. `active` and `trialing` are entitled;
 * everything else (`past_due`, `canceled`, `unpaid`, `incomplete`, `paused`, …)
 * is NOT — we down-grade to free the moment Stripe says the subscription isn't in
 * good standing, erring toward under- rather than over-entitling.
 */
export const PAID_STRIPE_STATUSES: ReadonlySet<string> = new Set(["active", "trialing"]);

/** Map a raw Stripe subscription status to the app entitlement tier. Pure + total. */
export function entitlementTierFromStatus(status: string | null | undefined): Tier {
  return status != null && PAID_STRIPE_STATUSES.has(status) ? "paid" : "free";
}

/** Is direct-Stripe billing wired? (Server secret present.) */
export function stripeConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(env.STRIPE_SECRET_KEY);
}

export interface StripeConfig {
  secretKey: string;
  /** The single paid plan's price id (subscription line item). */
  pricePro: string | undefined;
  /** Webhook signing secret (verifies inbound events). */
  webhookSecret: string | undefined;
}

/**
 * Resolve the Stripe config for the server paths. Throws a readable error when the
 * secret key is absent so a misconfigured deploy fails loudly at the call site
 * rather than making a keyless Stripe call; the price/webhook secret are validated
 * by the specific route that needs them (checkout needs the price; the webhook
 * needs the signing secret).
 */
export function resolveStripeConfig(
  env: Record<string, string | undefined> = process.env,
): StripeConfig {
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("Stripe is not configured: set STRIPE_SECRET_KEY (test mode).");
  }
  return {
    secretKey,
    pricePro: env.STRIPE_PRICE_PRO,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
  };
}
