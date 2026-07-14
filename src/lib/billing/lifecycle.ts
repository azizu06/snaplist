/**
 * Checkout lifecycle orchestration (issue #152).
 *
 * This small service keeps the externally visible billing path honest: it records
 * a Customer mapping before the hosted Checkout can be opened, so a retry after
 * an abandoned session has a stable Stripe Customer to reuse.
 */

export interface BillingCustomerStore {
  customerIdForUser(userId: string): Promise<string | null>;
  saveCustomerIdForUser(userId: string, customerId: string): Promise<void>;
  claimCheckout(userId: string, customerId: string): Promise<CheckoutClaim>;
  completeCheckoutClaim(input: {
    userId: string;
    claimToken: string;
    checkoutSessionId: string;
    checkoutUrl: string;
    expiresAt: string;
  }): Promise<void>;
  releaseCheckoutClaim(userId: string, claimToken: string): Promise<void>;
}

export type CheckoutClaim =
  | { state: "ready"; url: string }
  | { state: "claim"; idempotencyKey: string; claimToken: string }
  | { state: "in_progress" };

export interface CheckoutLifecycleAdapter {
  ensureCustomer(args: {
    userId: string;
    email?: string;
    existingCustomerId?: string;
  }): Promise<string>;
  /** A non-terminal subscription that must be managed instead of duplicated. */
  findBlockingSubscription(customerId: string): Promise<unknown | null>;
  createCheckoutSession(params: {
    userId: string;
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<{ id: string; url: string; expiresAt: string }>;
  createPortalSession(params: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
}

export interface StartCheckoutInput {
  userId: string;
  email?: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  adapter: CheckoutLifecycleAdapter;
  store: BillingCustomerStore;
}

export type StartCheckoutResult =
  | { destination: "checkout" | "checkout_in_progress"; url: string }
  | { destination: "portal"; url: string };

/**
 * Starts a subscription Checkout only after the authenticated user's Customer
 * mapping is durable, so retries share the same Customer immediately. A current
 * non-terminal Subscription goes to the Stripe-managed Billing Portal rather than
 * creating a second subscription Checkout.
 */
export async function startCheckout(input: StartCheckoutInput): Promise<StartCheckoutResult> {
  const existingCustomerId = await input.store.customerIdForUser(input.userId);
  const customerId =
    existingCustomerId ??
    (await input.adapter.ensureCustomer({ userId: input.userId, email: input.email }));

  if (!existingCustomerId) {
    await input.store.saveCustomerIdForUser(input.userId, customerId);
  }

  if (await input.adapter.findBlockingSubscription(customerId)) {
    const origin = new URL(input.successUrl).origin;
    const { url } = await input.adapter.createPortalSession({
      customerId,
      returnUrl: `${origin}/settings`,
    });
    return { destination: "portal", url };
  }

  const claim = await input.store.claimCheckout(input.userId, customerId);
  if (claim.state === "ready") {
    return { destination: "checkout", url: claim.url };
  }
  if (claim.state === "in_progress") {
    return { destination: "checkout_in_progress", url: "" };
  }

  try {
    const session = await input.adapter.createCheckoutSession({
      userId: input.userId,
      customerId,
      priceId: input.priceId,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      idempotencyKey: claim.idempotencyKey,
    });
    await input.store.completeCheckoutClaim({
      userId: input.userId,
      claimToken: claim.claimToken,
      checkoutSessionId: session.id,
      checkoutUrl: session.url,
      expiresAt: session.expiresAt,
    });
    return { destination: "checkout", url: session.url };
  } catch (error) {
    await input.store.releaseCheckoutClaim(input.userId, claim.claimToken).catch(() => undefined);
    throw error;
  }
}
