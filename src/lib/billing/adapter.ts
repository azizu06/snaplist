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
  /** Stable for one pending hosted Checkout; prevents concurrent duplicate Sessions. */
  idempotencyKey: string;
}

export interface PortalParams {
  customerId: string;
  returnUrl: string;
}

/** The current Subscription state used for Checkout guards and entitlement mirroring. */
export interface StripeSubscription {
  id: string;
  customerId: string;
  status: string;
  /** Unix seconds, if Stripe reports a current period. */
  currentPeriodEnd?: number;
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
  createCheckoutSession(params: CheckoutParams): Promise<{
    id: string;
    url: string;
    expiresAt: string;
  }>;
  /** Create a Billing Portal session; returns its hosted URL. */
  createPortalSession(params: PortalParams): Promise<{ url: string }>;
  /**
   * Find any Subscription that must be managed before another Checkout can start.
   * Terminal `canceled` / `incomplete_expired` subscriptions intentionally return
   * null so a seller may subscribe again.
   */
  findBlockingSubscription(customerId: string): Promise<StripeSubscription | null>;
  /** Retrieve Stripe's current state, never the potentially stale webhook payload. */
  retrieveSubscription(subscriptionId: string): Promise<StripeSubscription>;
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
  public readonly ensuredCustomers: Array<{
    userId: string;
    email?: string;
    existingCustomerId?: string;
  }> = [];
  private readonly subscriptions = new Map<string, StripeSubscription>();
  private readonly customerSubscriptions = new Map<string, StripeSubscription>();

  async ensureCustomer(args: {
    userId: string;
    email?: string;
    existingCustomerId?: string;
  }): Promise<string> {
    this.ensuredCustomers.push(args);
    return args.existingCustomerId ?? `cus_mock_${args.userId}`;
  }

  async createCheckoutSession(params: CheckoutParams): Promise<{ id: string; url: string; expiresAt: string }> {
    this.checkoutCalls.push(params);
    return {
      id: `cs_mock_${params.userId}`,
      url: `https://checkout.stripe.test/session/${params.userId}`,
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
  }

  async createPortalSession(params: PortalParams): Promise<{ url: string }> {
    this.portalCalls.push(params);
    return { url: `https://billing.stripe.test/portal/${params.customerId}` };
  }

  /** Test fixture hook — mirrors the authoritative Subscription read. */
  setSubscription(subscription: StripeSubscription): void {
    this.subscriptions.set(subscription.id, subscription);
    this.customerSubscriptions.set(subscription.customerId, subscription);
  }

  async findBlockingSubscription(customerId: string): Promise<StripeSubscription | null> {
    const subscription = this.customerSubscriptions.get(customerId);
    return subscription && isBlockingSubscriptionStatus(subscription.status) ? subscription : null;
  }

  async retrieveSubscription(subscriptionId: string): Promise<StripeSubscription> {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) throw new Error(`No mock Subscription exists for ${subscriptionId}`);
    return subscription;
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

      // The database mapping is the durable source. This server-set metadata
      // search is its recovery backstop if a process created the Customer but
      // failed before persisting that mapping. Search is not the normal path.
      const customers = await stripe.customers.search({
        query: `metadata['snaplist_clerk_user_id']:'${escapeStripeSearchValue(userId)}'`,
        limit: 2,
      });
      if (customers.data.length > 1) {
        throw new Error("Multiple Stripe Customers exist for this SnapList user.");
      }
      if (customers.data[0]) return customers.data[0].id;

      const customer = await stripe.customers.create({
        ...(email ? { email } : {}),
        metadata: { snaplist_clerk_user_id: userId },
      }, {
        // Concurrent first Checkout requests reuse one Customer while the durable
        // mapping is being established. The mapping is saved before Checkout opens.
        idempotencyKey: `snaplist-customer:${userId}`,
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
        // Retain server-written provenance for Stripe support/debugging. Webhook
        // tenancy always comes from the durable billing_customers map, never this
        // metadata or client_reference_id.
        client_reference_id: params.userId,
        subscription_data: { metadata: { user_id: params.userId } },
      }, { idempotencyKey: params.idempotencyKey });
      if (!session.url || !session.expires_at) {
        throw new Error("Stripe did not return a complete Checkout Session");
      }
      return {
        id: session.id,
        url: session.url,
        expiresAt: new Date(session.expires_at * 1000).toISOString(),
      };
    },

    async findBlockingSubscription(customerId) {
      const subscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 100,
      });
      const subscription = subscriptions.data.find((candidate) =>
        isBlockingSubscriptionStatus(candidate.status),
      );
      return subscription ? normalizeStripeSubscription(subscription) : null;
    },

    async retrieveSubscription(subscriptionId) {
      return normalizeStripeSubscription(await stripe.subscriptions.retrieve(subscriptionId));
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

const BLOCKING_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "trialing",
  "incomplete",
  "past_due",
  "unpaid",
  "paused",
]);

function isBlockingSubscriptionStatus(status: string): boolean {
  return BLOCKING_SUBSCRIPTION_STATUSES.has(status);
}

function escapeStripeSearchValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function normalizeStripeSubscription(subscription: {
  id: string;
  customer: string | { id: string };
  status: string;
  items: { data: Array<{ current_period_end: number }> };
}): StripeSubscription {
  return {
    id: subscription.id,
    customerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
    status: subscription.status,
    currentPeriodEnd: subscription.items.data[0]?.current_period_end,
  };
}
