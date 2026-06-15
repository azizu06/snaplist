import { describe, expect, it } from "vitest";
import {
  entitlementTierFromStatus,
  resolveStripeConfig,
  stripeConfigured,
} from "./config";

describe("entitlementTierFromStatus (#64)", () => {
  it("treats active and trialing as paid", () => {
    expect(entitlementTierFromStatus("active")).toBe("paid");
    expect(entitlementTierFromStatus("trialing")).toBe("paid");
  });

  it("treats every not-in-good-standing status as free", () => {
    for (const s of ["past_due", "canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]) {
      expect(entitlementTierFromStatus(s), s).toBe("free");
    }
  });

  it("defaults to free for null/undefined/empty", () => {
    expect(entitlementTierFromStatus(null)).toBe("free");
    expect(entitlementTierFromStatus(undefined)).toBe("free");
    expect(entitlementTierFromStatus("")).toBe("free");
  });
});

describe("stripeConfigured / resolveStripeConfig", () => {
  it("is configured only when the secret key is present", () => {
    expect(stripeConfigured({})).toBe(false);
    expect(stripeConfigured({ STRIPE_SECRET_KEY: "sk_test_x" })).toBe(true);
  });

  it("resolves the config and throws a readable error without a key", () => {
    expect(() => resolveStripeConfig({})).toThrow(/STRIPE_SECRET_KEY/);
    const cfg = resolveStripeConfig({
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_PRICE_PRO: "price_123",
      STRIPE_WEBHOOK_SECRET: "whsec_1",
    });
    expect(cfg).toEqual({
      secretKey: "sk_test_x",
      pricePro: "price_123",
      webhookSecret: "whsec_1",
    });
  });
});
