import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getEbayConnectionStatus, userTokenProvider } = vi.hoisted(() => ({
  getEbayConnectionStatus: vi.fn(),
  userTokenProvider: vi.fn(function UserTokenProvider(...args: unknown[]) {
    void args;
  }),
}));

vi.mock("./connections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./connections")>()),
  getEbayConnectionStatus,
}));

vi.mock("./user-token-provider", () => ({
  UserTokenProvider: userTokenProvider,
}));

import {
  createEbayAdapterForUser,
  createEbayMessagingAdapterForUser,
  ebayMessagingSyncUserIds,
  hasEbayMessagingSandboxFallback,
} from "./index";

const operatorEnv = {
  EBAY_BASE_URL: "https://api.sandbox.ebay.com",
  EBAY_OAUTH_TOKEN: "sandbox-token",
  EBAY_MESSAGING_SANDBOX_OPERATOR_USER_ID: "user_operator",
  EBAY_MESSAGING_SANDBOX_OPERATOR_SELLER_ID: "sandbox-seller-id",
};

describe("eBay messaging composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the tenant server client for connected seller credential writes", async () => {
    getEbayConnectionStatus.mockResolvedValue({
      connected: true,
      ebayUsername: "seller",
    });
    const readClient = { rpc: vi.fn() } as unknown as SupabaseClient;
    const credentialClient = { rpc: vi.fn() } as unknown as SupabaseClient;

    await createEbayAdapterForUser(readClient, "user_a", { credentialClient });
    await createEbayMessagingAdapterForUser(readClient, "user_a", {
      credentialClient,
    });

    expect(userTokenProvider.mock.calls[0]?.[0]).toBe(credentialClient);
    expect(userTokenProvider).toHaveBeenNthCalledWith(1, credentialClient, {
      userId: "user_a",
    });
    expect(userTokenProvider.mock.calls[1]?.[0]).toBe(credentialClient);
    expect(userTokenProvider).toHaveBeenNthCalledWith(2, credentialClient, {
      userId: "user_a",
      scheduled: undefined,
    });
  });

  it("does not require the tenant server client for app-level fallback", async () => {
    getEbayConnectionStatus.mockResolvedValue({
      connected: false,
      ebayUsername: null,
    });
    const credentialClient = vi.fn();

    await createEbayAdapterForUser({} as SupabaseClient, "user_a", {
      credentialClient,
    });

    expect(credentialClient).not.toHaveBeenCalled();
    expect(userTokenProvider).not.toHaveBeenCalled();
  });

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
