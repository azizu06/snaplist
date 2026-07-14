import { describe, expect, it } from "vitest";
import { startCheckout } from "./lifecycle";

describe("startCheckout (#152)", () => {
  it("reuses the durable Stripe customer after an abandoned Checkout is retried", async () => {
    const customers = new Map<string, string>();
    const checkoutCustomerIds: string[] = [];
    let customerCreations = 0;
    let reservation:
      | { state: "claim"; idempotencyKey: string; claimToken: string }
      | { state: "ready"; url: string }
      | undefined;

    const adapter = {
      async ensureCustomer() {
        customerCreations += 1;
        return "cus_1";
      },
      async findBlockingSubscription() {
        return null;
      },
      async createCheckoutSession(params: { customerId: string }) {
        checkoutCustomerIds.push(params.customerId);
        return {
          id: "cs_1",
          url: "https://checkout.stripe.test/session",
          expiresAt: "2030-01-01T00:00:00.000Z",
        };
      },
      async createPortalSession() {
        throw new Error("an abandoned Checkout must not open the portal");
      },
    };
    const store = {
      async customerIdForUser(userId: string) {
        return customers.get(userId) ?? null;
      },
      async saveCustomerIdForUser(userId: string, customerId: string) {
        customers.set(userId, customerId);
      },
      async claimCheckout() {
        return reservation ?? { state: "claim" as const, idempotencyKey: "key_1", claimToken: "claim_1" };
      },
      async completeCheckoutClaim(input: { checkoutUrl: string }) {
        reservation = { state: "ready", url: input.checkoutUrl };
      },
      async releaseCheckoutClaim() {
        throw new Error("a successful Checkout claim must not be released");
      },
    };

    const first = await startCheckout({
      userId: "user_1",
      priceId: "price_pro",
      successUrl: "https://snaplist.test/settings?billing=success",
      cancelUrl: "https://snaplist.test/settings?billing=cancelled",
      adapter,
      store,
    });
    const retry = await startCheckout({
      userId: "user_1",
      priceId: "price_pro",
      successUrl: "https://snaplist.test/settings?billing=success",
      cancelUrl: "https://snaplist.test/settings?billing=cancelled",
      adapter,
      store,
    });

    expect(customerCreations).toBe(1);
    expect(checkoutCustomerIds).toEqual(["cus_1"]);
    expect(first).toEqual({ destination: "checkout", url: "https://checkout.stripe.test/session" });
    expect(retry).toEqual({ destination: "checkout", url: "https://checkout.stripe.test/session" });
  });

  it("routes an active subscriber to the Billing Portal instead of creating another Checkout", async () => {
    let checkoutCalls = 0;
    let portalCustomerId: string | undefined;

    const result = await startCheckout({
      userId: "user_paid",
      priceId: "price_pro",
      successUrl: "https://snaplist.test/settings?billing=success",
      cancelUrl: "https://snaplist.test/settings?billing=cancelled",
      store: {
        async customerIdForUser() {
          return "cus_paid";
        },
        async saveCustomerIdForUser() {
          throw new Error("an existing customer must not be remapped");
        },
        async claimCheckout() {
          throw new Error("a paid subscriber must not start a Checkout claim");
        },
        async completeCheckoutClaim() {
          throw new Error("a paid subscriber must not complete a Checkout claim");
        },
        async releaseCheckoutClaim() {
          throw new Error("a paid subscriber must not release a Checkout claim");
        },
      },
      adapter: {
        async ensureCustomer() {
          throw new Error("an existing customer must be reused");
        },
        async findBlockingSubscription() {
          return { id: "sub_paid", status: "active" };
        },
        async createCheckoutSession() {
          checkoutCalls += 1;
          return {
            id: "cs_should_not_open",
            url: "https://checkout.stripe.test/should-not-open",
            expiresAt: "2030-01-01T00:00:00.000Z",
          };
        },
        async createPortalSession(params: { customerId: string }) {
          portalCustomerId = params.customerId;
          return { url: "https://billing.stripe.test/portal" };
        },
      },
    });

    expect(result).toEqual({ destination: "portal", url: "https://billing.stripe.test/portal" });
    expect(checkoutCalls).toBe(0);
    expect(portalCustomerId).toBe("cus_paid");
  });

  it("does not create a second Checkout while another request owns the durable claim", async () => {
    let checkoutCalls = 0;
    const result = await startCheckout({
      userId: "user_racing",
      priceId: "price_pro",
      successUrl: "https://snaplist.test/settings?billing=success",
      cancelUrl: "https://snaplist.test/settings?billing=cancelled",
      store: {
        async customerIdForUser() {
          return "cus_racing";
        },
        async saveCustomerIdForUser() {},
        async claimCheckout() {
          return { state: "in_progress" as const };
        },
        async completeCheckoutClaim() {},
        async releaseCheckoutClaim() {},
      },
      adapter: {
        async ensureCustomer() {
          throw new Error("the stable customer must be reused");
        },
        async findBlockingSubscription() {
          return null;
        },
        async createCheckoutSession() {
          checkoutCalls += 1;
          return { id: "cs_should_not_open", url: "https://checkout.test", expiresAt: "2030-01-01T00:00:00.000Z" };
        },
        async createPortalSession() {
          throw new Error("no Subscription exists to manage");
        },
      },
    });

    expect(result).toEqual({ destination: "checkout_in_progress", url: "" });
    expect(checkoutCalls).toBe(0);
  });
});
