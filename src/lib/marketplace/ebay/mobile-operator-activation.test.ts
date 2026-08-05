import { describe, expect, it } from "vitest";
import { assertMobileEbayOperatorActivation } from "./mobile-operator-activation";

describe("assertMobileEbayOperatorActivation", () => {
  it("rejects a Sandbox URL when production mobile activation is enabled", () => {
    expect(() =>
      assertMobileEbayOperatorActivation({
        EBAY_BASE_URL: "https://api.sandbox.ebay.com",
        EBAY_PRODUCTION_MOBILE_ENABLED: "true",
      }),
    ).toThrow(/https:\/\/api\.ebay\.com/);
  });
});
