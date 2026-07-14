import { describe, expect, it } from "vitest";
import { MockStripeBillingAdapter } from "./adapter";

describe("MockStripeBillingAdapter", () => {
  it("reuses an existing customer, else mints a deterministic one", async () => {
    const a = new MockStripeBillingAdapter();
    expect(await a.ensureCustomer({ userId: "u1" })).toBe("cus_mock_u1");
    expect(await a.ensureCustomer({ userId: "u1", existingCustomerId: "cus_real" })).toBe(
      "cus_real",
    );
  });

  it("creates a checkout session URL and records the params", async () => {
    const a = new MockStripeBillingAdapter();
    const { url } = await a.createCheckoutSession({
      userId: "u1",
      customerId: "cus_1",
      priceId: "price_pro",
      successUrl: "https://app/settings?billing=success",
      cancelUrl: "https://app/settings?billing=cancelled",
      idempotencyKey: "checkout_key_1",
    });
    expect(url).toContain("u1");
    expect(a.checkoutCalls).toHaveLength(1);
    expect(a.checkoutCalls[0].priceId).toBe("price_pro");
  });

  it("creates a portal session URL and records the params", async () => {
    const a = new MockStripeBillingAdapter();
    const { url } = await a.createPortalSession({ customerId: "cus_1", returnUrl: "https://app/settings" });
    expect(url).toContain("cus_1");
    expect(a.portalCalls[0].returnUrl).toBe("https://app/settings");
  });

  it("constructEvent verifies the signature and parses the event", () => {
    const a = new MockStripeBillingAdapter();
    const body = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated", object: { status: "active" } });
    expect(a.constructEvent(body, "valid").id).toBe("evt_1");
    expect(() => a.constructEvent(body, "bad")).toThrow(/signature/i);
  });
});
