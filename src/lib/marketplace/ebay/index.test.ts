import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getEbayConnectionStatus, userTokenProvider } = vi.hoisted(() => ({
  getEbayConnectionStatus: vi.fn(),
  userTokenProvider: vi.fn(function UserTokenProvider(...args: unknown[]) {
    void args;
    return { getAccessToken: async () => "user-access-token" };
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
  createEbayAdapter,
  createEbayAdapterForUser,
  hasEbayMessagingSandboxFallback,
} from "./index";
import { assertMobileEbayOperatorActivation } from "./mobile-operator-activation";
import type { EbayPublishRequest } from "./types";

const operatorEnv = {
  EBAY_BASE_URL: "https://api.sandbox.ebay.com",
  EBAY_OAUTH_TOKEN: "sandbox-token",
  EBAY_MESSAGING_SANDBOX_OPERATOR_USER_ID: "user_operator",
  EBAY_MESSAGING_SANDBOX_OPERATOR_SELLER_ID: "sandbox-seller-id",
  EBAY_FULFILLMENT_POLICY_ID: "operator-fulfillment",
  EBAY_PAYMENT_POLICY_ID: "operator-payment",
  EBAY_RETURN_POLICY_ID: "operator-return",
  EBAY_MERCHANT_LOCATION_KEY: "operator-location",
};

describe("eBay adapter composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("requires an account-bound provider at the low-level composition root", () => {
    expect(() => createEbayAdapter(undefined as never)).toThrow(
      "An account-bound eBay token provider is required.",
    );
  });

  it("uses the tenant server client for connected seller credential writes", async () => {
    getEbayConnectionStatus.mockResolvedValue({
      connected: true,
      ebayUsername: "seller",
    });
    const readClient = { rpc: vi.fn() } as unknown as SupabaseClient;
    const credentialClient = { rpc: vi.fn() } as unknown as SupabaseClient;

    await createEbayAdapterForUser(readClient, "user_a", { credentialClient });

    expect(userTokenProvider.mock.calls[0]?.[0]).toBe(credentialClient);
    expect(userTokenProvider).toHaveBeenNthCalledWith(
      1,
      credentialClient,
      expect.objectContaining({
        env: expect.any(Function),
        userId: "user_a",
      }),
    );
  });

  it("dispatches with the normalized production base URL", async () => {
    getEbayConnectionStatus.mockResolvedValue({
      connected: true,
      ebayUsername: "seller",
    });
    const rawEnv = {
      EBAY_BASE_URL: "https://API.EBAY.COM:443/",
      EBAY_PRODUCTION_MOBILE_ENABLED: "true",
    };
    const normalizedEnv = {
      ...rawEnv,
      EBAY_BASE_URL: assertMobileEbayOperatorActivation(rawEnv),
    };
    vi.stubEnv("EBAY_BASE_URL", rawEnv.EBAY_BASE_URL);
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/inventory_item/")) {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/offer")) {
        return new Response(JSON.stringify({ offerId: "offer-674" }), {
          status: 201,
        });
      }
      return new Response(JSON.stringify({ listingId: "listing-674" }), {
        status: 200,
      });
    });
    const request: EbayPublishRequest = {
      sku: "listing-674",
      marketplaceId: "EBAY_US",
      connectionGeneration: "11111111-1111-4111-8111-111111111111",
      publishClaimId: "22222222-2222-4222-8222-222222222222",
      fulfillmentPolicyId: "fulfillment-674",
      paymentPolicyId: "payment-674",
      returnPolicyId: "return-674",
      merchantLocationKey: "location-674",
      title: "Normalized eBay dispatch",
      description: "Dispatch URL regression proof.",
      aspects: {},
      condition: "USED_GOOD",
      price: { value: "10.00", currency: "USD" },
      quantity: 1,
      categoryId: "1234",
      imageUrls: ["https://example.com/photo.jpg"],
    };

    const adapter = await createEbayAdapterForUser(
      {} as SupabaseClient,
      "user_a",
      {
        credentialClient: {} as SupabaseClient,
        env: () => normalizedEnv,
      },
    );
    const tokenOptions = userTokenProvider.mock.calls[0]?.[1] as {
      env?: () => Record<string, string | undefined>;
    };
    expect(tokenOptions.env?.().EBAY_BASE_URL).toBe("https://api.ebay.com");
    await adapter.publishListing(request);

    expect(urls).toEqual([
      "https://api.ebay.com/sell/inventory/v1/inventory_item/listing-674",
      "https://api.ebay.com/sell/inventory/v1/offer",
      "https://api.ebay.com/sell/inventory/v1/offer/offer-674/publish",
    ]);
    expect(urls.every((url) => !url.includes(".com//sell/"))).toBe(true);
  });

  it("rejects app-level credentials for an unconnected non-operator", async () => {
    getEbayConnectionStatus.mockResolvedValue({
      connected: false,
      ebayUsername: null,
    });
    const credentialClient = vi.fn();

    await expect(
      createEbayAdapterForUser({} as SupabaseClient, "user_a", {
        credentialClient,
      }),
    ).rejects.toThrow(
      "App-level eBay Sandbox credentials are restricted to the configured operator tenant.",
    );

    expect(credentialClient).not.toHaveBeenCalled();
    expect(userTokenProvider).not.toHaveBeenCalled();
  });

  it("keeps foreground Sandbox publishing on the operator's bound generation", async () => {
    getEbayConnectionStatus.mockResolvedValue({
      connected: false,
      ebayUsername: null,
    });
    for (const [key, value] of Object.entries(operatorEnv)) {
      vi.stubEnv(key, value);
    }
    const credentialClient = { rpc: vi.fn() } as unknown as SupabaseClient;

    const adapter = await createEbayAdapterForUser(
      {} as SupabaseClient,
      "user_operator",
      {
        credentialClient,
      },
    );

    expect(userTokenProvider).toHaveBeenCalledWith(credentialClient, {
      userId: "user_operator",
      scheduled: false,
    });
    expect(adapter.getPublishFallbackBinding?.()).toEqual({
      marketplaceId: "EBAY_US",
      connectionGeneration: null,
      fulfillmentPolicyId: "operator-fulfillment",
      paymentPolicyId: "operator-payment",
      returnPolicyId: "operator-return",
      merchantLocationKey: "operator-location",
    });
  });

  it("keeps scheduled Sandbox auto-repricing on the operator's bound generation", async () => {
    getEbayConnectionStatus.mockResolvedValue({
      connected: false,
      ebayUsername: null,
    });
    for (const [key, value] of Object.entries(operatorEnv)) {
      vi.stubEnv(key, value);
    }
    const credentialClient = { rpc: vi.fn() } as unknown as SupabaseClient;

    await expect(
      createEbayAdapterForUser({} as SupabaseClient, "user_operator", {
        credentialClient,
        scheduled: true,
      }),
    ).resolves.toBeDefined();

    expect(userTokenProvider).toHaveBeenCalledWith(credentialClient, {
      userId: "user_operator",
      scheduled: true,
    });
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
});
