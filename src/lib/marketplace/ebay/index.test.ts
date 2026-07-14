import { describe, expect, it } from "vitest";
import {
  ebayMessagingSyncUserIds,
  hasEbayMessagingSandboxFallback,
} from "./index";

const operatorEnv = {
  EBAY_BASE_URL: "https://api.sandbox.ebay.com",
  EBAY_OAUTH_TOKEN: "sandbox-token",
  EBAY_MESSAGING_SANDBOX_OPERATOR_USER_ID: "user_operator",
};

describe("eBay messaging composition", () => {
  it("allows app-level Sandbox credentials only for the configured operator tenant", () => {
    expect(
      hasEbayMessagingSandboxFallback("user_operator", operatorEnv),
    ).toBe(true);
    expect(
      hasEbayMessagingSandboxFallback("user_other", operatorEnv),
    ).toBe(false);
    expect(hasEbayMessagingSandboxFallback(undefined, operatorEnv)).toBe(false);
  });

  it("never enables the app-level fallback outside the exact Sandbox API origin", () => {
    expect(
      hasEbayMessagingSandboxFallback("user_operator", {
        ...operatorEnv,
        EBAY_BASE_URL: "https://api.ebay.com",
      }),
    ).toBe(false);
    expect(
      hasEbayMessagingSandboxFallback("user_operator", {
        ...operatorEnv,
        EBAY_BASE_URL: "https://api.sandbox.ebay.com.attacker.example",
      }),
    ).toBe(false);
  });

  it("adds the configured operator to background sync without duplicating a connection", () => {
    expect(
      ebayMessagingSyncUserIds(["user_a", "user_operator"], operatorEnv),
    ).toEqual(["user_a", "user_operator"]);
    expect(ebayMessagingSyncUserIds(["user_a"], operatorEnv)).toEqual([
      "user_a",
      "user_operator",
    ]);
    expect(
      ebayMessagingSyncUserIds(["user_a"], {
        ...operatorEnv,
        EBAY_BASE_URL: "https://api.ebay.com",
      }),
    ).toEqual(["user_a"]);
  });
});
