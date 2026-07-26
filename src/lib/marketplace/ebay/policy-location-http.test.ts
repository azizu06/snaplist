import { describe, expect, it, vi } from "vitest";
import { HttpEbayPolicyLocationDiscoveryAdapter } from "./policy-location-http";
import type { EbayTokenProvider } from "./types";

const ACCOUNT_GENERATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("HttpEbayPolicyLocationDiscoveryAdapter", () => {
  it("reads usable marketplace policies and enabled locations without exposing private details", async () => {
    const tokenProvider: EbayTokenProvider = {
      getAccessToken: vi.fn(async (expectedGeneration) => {
        expect(expectedGeneration).toBe(ACCOUNT_GENERATION);
        return "seller-access-token";
      }),
    };
    const fetchMock = vi.fn(async (
      request: string | URL | Request,
      init?: RequestInit,
    ) => {
      void init;
      const url = new URL(request instanceof Request ? request.url : request);
      if (url.pathname.endsWith("/fulfillment_policy")) {
        return Response.json({
          fulfillmentPolicies: [
            {
              fulfillmentPolicyId: "fulfillment-usable",
              name: "  Standard\u0000 shipping  ",
              marketplaceId: "EBAY_US",
              description: "private seller note",
              categoryTypes: [
                { name: "ALL_EXCLUDING_MOTORS_VEHICLES", default: true },
              ],
            },
            {
              fulfillmentPolicyId: "fulfillment-motors",
              name: "Motors only",
              marketplaceId: "EBAY_US",
              categoryTypes: [{ name: "MOTORS_VEHICLES" }],
            },
            {
              fulfillmentPolicyId: "fulfillment-ca",
              name: "Canada",
              marketplaceId: "EBAY_CA",
              categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }],
            },
          ],
        });
      }
      if (url.pathname.endsWith("/payment_policy")) {
        return Response.json({
          paymentPolicies: [
            {
              paymentPolicyId: "payment-usable",
              name: "Managed payments",
              marketplaceId: "EBAY_US",
              categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }],
            },
          ],
        });
      }
      if (url.pathname.endsWith("/return_policy")) {
        return Response.json({
          returnPolicies: [
            {
              returnPolicyId: "return-usable",
              name: "30 day returns",
              marketplaceId: "EBAY_US",
              categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }],
            },
          ],
        });
      }
      if (url.pathname.endsWith("/location")) {
        return Response.json({
          total: 2,
          limit: 100,
          offset: 0,
          locations: [
            {
              merchantLocationKey: "location-enabled",
              merchantLocationStatus: "ENABLED",
              name: "Home warehouse",
              phone: "+1-private",
              location: {
                address: {
                  addressLine1: "private street",
                  postalCode: "private zip",
                },
              },
            },
            {
              merchantLocationKey: "location-disabled",
              merchantLocationStatus: "DISABLED",
              name: "Old warehouse",
            },
          ],
        });
      }
      return Response.json({ error: "unexpected request" }, { status: 404 });
    });
    const adapter = new HttpEbayPolicyLocationDiscoveryAdapter({
      tokenProvider,
      fetch: fetchMock as unknown as typeof fetch,
      env: () => ({ EBAY_BASE_URL: "https://api.sandbox.ebay.com" }),
    });

    const result = await adapter.readCandidates({
      marketplaceId: "EBAY_US",
      accountGeneration: ACCOUNT_GENERATION,
    });

    expect(result).toEqual({
      fulfillmentPolicies: [
        {
          id: "fulfillment-usable",
          label: "Standard shipping",
          providerDefault: false,
        },
      ],
      paymentPolicies: [
        {
          id: "payment-usable",
          label: "Managed payments",
          providerDefault: false,
        },
      ],
      returnPolicies: [
        {
          id: "return-usable",
          label: "30 day returns",
          providerDefault: false,
        },
      ],
      inventoryLocations: [
        {
          id: "location-enabled",
          label: "Home warehouse",
          providerDefault: false,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer seller-access-token",
        }),
      });
    }
  });

  it("reads every inventory-location page before selecting enabled candidates", async () => {
    const tokenProvider: EbayTokenProvider = {
      getAccessToken: vi.fn(async () => "seller-access-token"),
    };
    const fetchMock = vi.fn(async (
      request: string | URL | Request,
      init?: RequestInit,
    ) => {
      void init;
      const url = new URL(request instanceof Request ? request.url : request);
      if (url.pathname.endsWith("/fulfillment_policy")) {
        return Response.json({ fulfillmentPolicies: [] });
      }
      if (url.pathname.endsWith("/payment_policy")) {
        return Response.json({ paymentPolicies: [] });
      }
      if (url.pathname.endsWith("/return_policy")) {
        return Response.json({ returnPolicies: [] });
      }
      const offset = Number(url.searchParams.get("offset"));
      return Response.json({
        total: 2,
        limit: 1,
        offset,
        locations: [
          {
            merchantLocationKey: `location-${offset + 1}`,
            merchantLocationStatus: "ENABLED",
            name: `Warehouse ${offset + 1}`,
          },
        ],
      });
    });
    const adapter = new HttpEbayPolicyLocationDiscoveryAdapter({
      tokenProvider,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await adapter.readCandidates({
      marketplaceId: "EBAY_US",
      accountGeneration: ACCOUNT_GENERATION,
    });

    expect(result.inventoryLocations.map((location) => location.id)).toEqual([
      "location-1",
      "location-2",
    ]);
    expect(
      fetchMock.mock.calls
        .map(([request]) => new URL(String(request)))
        .filter((url) => url.pathname.endsWith("/location"))
        .map((url) => url.searchParams.get("offset")),
    ).toEqual(["0", "1"]);
  });
});
