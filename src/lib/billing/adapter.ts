import type { StripeConfig } from "./config";

/**
 * The Stripe billing adapter seam (issue #64), mirroring the eBay adapter: the only
 * Stripe surface the rest of SnapList depends on. The REAL adapter wraps the direct
 * Stripe SDK (lazy-imported so the offline test path never loads it); tests use
 * `MockStripeBillingAdapter`, so checkout/portal/webhook logic is exercised with no
 * live calls and no key. All Stripe access is TEST-mode (a key swap goes live).
 */

export interface CheckoutParams {
  userId: string;
  /** Existing Stripe customer for the user, if one was already created. */
  customerId?: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
}

export interface PortalParams {
  customerId: string;
  returnUrl: string;
}

/** A verified, normalized webhook event — only the fields the handler needs. */
export interface StripeWebhookEvent {
  id: string;
  type: string;
  /** The underlying Stripe object (Subscription / Checkout Session / Invoice). */
  object: Record<string, unknown>;
}

export interface StripeBillingAdapter {
  /** Get-or-create the Stripe customer for a user; returns the customer id. */
  ensureCustomer(args: {
    userId: string;
    email?: string;
    existingCustomerId?: string;
  }): Promise<string>;
  /** Create a subscription Checkout Session; returns its hosted URL. */
  createCheckoutSession(params: CheckoutParams): Promise<{ url: string }>;
  /** Create a Billing Portal session; returns its hosted URL. */
  createPortalSession(params: PortalParams): Promise<{ url: string }>;
  /**
   * Verify a raw webhook payload against the signing secret and return the parsed
   * event. THROWS on a bad/missing signature — the route answers 400 so Stripe
   * retries rather than us trusting an unsigned payload.
   */
  constructEvent(rawBody: string, signature: string): StripeWebhookEvent;
}

// ---------------------------------------------------------------------------
// Mock adapter — deterministic, no SDK, no network (the offline test default).
// ---------------------------------------------------------------------------
export class MockStripeBillingAdapter implements StripeBillingAdapter {
  public readonly checkoutCalls: CheckoutParams[] = [];
  public readonly portalCalls: PortalParams[] = [];

  async ensureCustomer(args: {
    userId: string;
    email?: string;
    existingCustomerId?: string;
  }): Promise<string> {
    return args.existingCustomerId ?? `cus_mock_${args.userId}`;
  }

  async createCheckoutSession(params: CheckoutParams): Promise<{ url: string }> {
    this.checkoutCalls.push(params);
    return { url: `https://checkout.stripe.test/session/${params.userId}` };
  }

  async createPortalSession(params: PortalParams): Promise<{ url: string }> {
    this.portalCalls.push(params);
    return { url: `https://billing.stripe.test/portal/${params.customerId}` };
  }

  /** Accepts signature `"valid"`; the body is JSON `{id,type,object}`. */
  constructEvent(rawBody: string, signature: string): StripeWebhookEvent {
    if (signature !== "valid") {
      throw new Error("Mock signature verification failed");
    }
    const parsed = JSON.parse(rawBody) as StripeWebhookEvent;
    return parsed;
  }
}

// ---------------------------------------------------------------------------
// Real adapter — direct Stripe SDK, lazy-imported. Built via an async factory so
// the SDK is loaded once (then `constructEvent` stays synchronous, as the SDK is).
// ---------------------------------------------------------------------------
export async function createStripeBillingAdapter(
  config: StripeConfig,
): Promise<StripeBillingAdapter> {
  const { default: Stripe } = await import("stripe");
  const stripe = new Stripe(config.secretKey);

  return {
    async ensureCustomer({ userId, email, existingCustomerId }) {
      if (existingCustomerId) return existingCustomerId;
      const customer = await stripe.customers.create({
        ...(email ? { email } : {}),
        metadata: { user_id: userId },
      });
      return customer.id;
    },

    async createCheckoutSession(params) {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: params.priceId, quantity: 1 }],
        customer: params.customerId,
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        // Tie the session AND the resulting subscription back to our user, so the
        // webhook can map any object to a user_id without a Stripe round-trip.
        client_reference_id: params.userId,
        subscription_data: { metadata: { user_id: params.userId } },
      });
      if (!session.url) throw new Error("Stripe did not return a checkout URL");
      return { url: session.url };
    },

    async createPortalSession(params) {
      const session = await stripe.billingPortal.sessions.create({
        customer: params.customerId,
        return_url: params.returnUrl,
      });
      return { url: session.url };
    },

    constructEvent(rawBody, signature) {
      if (!config.webhookSecret) {
        throw new Error("STRIPE_WEBHOOK_SECRET is required to verify webhooks");
      }
      const event = stripe.webhooks.constructEvent(rawBody, signature, config.webhookSecret);
      return {
        id: event.id,
        type: event.type,
        object: event.data.object as unknown as Record<string, unknown>,
      };
    },
  };
}
