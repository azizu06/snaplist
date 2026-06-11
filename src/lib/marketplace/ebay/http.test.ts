import { describe, expect, it, vi } from "vitest";
import { HttpEbayAdapter } from "./http";
import { EbayApiError } from "./types";
import type { EbayPublishRequest } from "./types";

/**
 * Real-adapter contract tests (issue #14) with a FAKE fetch — no live eBay call
 * anywhere in the suite. Pins the documented Sell Inventory flow:
 *
 *   PUT inventory_item/{sku} -> POST offer -> POST offer/{id}/publish
 *
 * plus the offer-already-exists (25002) recovery and error propagation. The
 * sandbox/production flip is exercised by asserting every URL derives from the
 * injected EBAY_BASE_URL.
 */

const BASE = "https://api.sandbox.ebay.com";

const sellerEnv = {
  EBAY_BASE_URL: BASE,
  EBAY_MARKETPLACE_ID: "EBAY_US",
  EBAY_FULFILLMENT_POLICY_ID: "fulfil-1",
  EBAY_PAYMENT_POLICY_ID: "pay-1",
  EBAY_RETURN_POLICY_ID: "ret-1",
  EBAY_MERCHANT_LOCATION_KEY: "loc-1",
};

const request: EbayPublishRequest = {
  sku: "listing-uuid-1",
  title: "Sony WH-1000XM4 Wireless Headphones",
  description: "Great condition.",
  aspects: { Brand: ["Sony"] },
  condition: "USED_GOOD",
  price: { value: "149.50", currency: "USD" },
  quantity: 1,
  categoryId: "112529",
  imageUrls: ["https://example.com/photo.png"],
};

const tokenProvider = { getAccessToken: async () => "test-access-token" };

type Call = { url: string; init: RequestInit };

/** Routes fake responses by URL suffix; records every call. */
function fakeFetch(
  respond: (url: string, init: RequestInit) => Response,
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  };
  return { fetch: impl as typeof fetch, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("HttpEbayAdapter.publishListing", () => {
  it("runs the documented three-step flow and returns the live listing id", async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.includes("/inventory_item/")) return new Response(null, { status: 204 });
      if (url.endsWith("/sell/inventory/v1/offer")) return json(201, { offerId: "offer-9" });
      if (url.endsWith("/offer/offer-9/publish")) return json(200, { listingId: "110123456789" });
      throw new Error(`unexpected call: ${url}`);
    });
    const adapter = new HttpEbayAdapter({ fetch, tokenProvider, env: () => sellerEnv });

    const result = await adapter.publishListing(request);
    expect(result).toEqual({
      listingId: "110123456789",
      offerId: "offer-9",
      status: "published",
    });

    // Exactly the three Sell API calls, in order, all on the configured base URL.
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/sell/inventory/v1/inventory_item/listing-uuid-1`,
      `${BASE}/sell/inventory/v1/offer`,
      `${BASE}/sell/inventory/v1/offer/offer-9/publish`,
    ]);
    expect(calls[0]!.init.method).toBe("PUT");
    expect(calls[1]!.init.method).toBe("POST");
    expect(calls[2]!.init.method).toBe("POST");
  });

  it("sends the bearer token and the required Content-Language header", async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.includes("/inventory_item/")) return new Response(null, { status: 204 });
      if (url.endsWith("/offer")) return json(201, { offerId: "o" });
      return json(200, { listingId: "l" });
    });
    const adapter = new HttpEbayAdapter({ fetch, tokenProvider, env: () => sellerEnv });
    await adapter.publishListing(request);

    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer test-access-token");
      expect(headers["content-language"]).toBe("en-US");
    }
  });

  it("maps the request onto the inventory-item and offer payloads (incl. env policies)", async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.includes("/inventory_item/")) return new Response(null, { status: 204 });
      if (url.endsWith("/offer")) return json(201, { offerId: "o" });
      return json(200, { listingId: "l" });
    });
    const adapter = new HttpEbayAdapter({ fetch, tokenProvider, env: () => sellerEnv });
    await adapter.publishListing(request);

    const inventoryBody = JSON.parse(String(calls[0]!.init.body));
    expect(inventoryBody).toEqual({
      condition: "USED_GOOD",
      product: {
        title: request.title,
        description: request.description,
        aspects: { Brand: ["Sony"] },
        imageUrls: ["https://example.com/photo.png"],
      },
      availability: { shipToLocationAvailability: { quantity: 1 } },
    });

    const offerBody = JSON.parse(String(calls[1]!.init.body));
    expect(offerBody).toEqual({
      sku: "listing-uuid-1",
      marketplaceId: "EBAY_US",
      format: "FIXED_PRICE",
      listingDuration: "GTC",
      availableQuantity: 1,
      categoryId: "112529",
      listingDescription: request.description,
      listingPolicies: {
        fulfillmentPolicyId: "fulfil-1",
        paymentPolicyId: "pay-1",
        returnPolicyId: "ret-1",
      },
      pricingSummary: { price: { value: "149.50", currency: "USD" } },
      merchantLocationKey: "loc-1",
    });
  });

  it("sends the required GTC listingDuration on every fixed-price offer body", async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.includes("/inventory_item/")) return new Response(null, { status: 204 });
      if (url.endsWith("/offer")) return json(201, { offerId: "o" });
      return json(200, { listingId: "l" });
    });
    const adapter = new HttpEbayAdapter({ fetch, tokenProvider, env: () => sellerEnv });
    await adapter.publishListing(request);

    // publishOffer rejects fixed-price offers without it (GTC is mandatory).
    const offerBody = JSON.parse(String(calls[1]!.init.body));
    expect(offerBody.format).toBe("FIXED_PRICE");
    expect(offerBody.listingDuration).toBe("GTC");
  });

  it("rejects a request with no image URLs BEFORE any eBay call (no partial remote writes)", async () => {
    const fetchSpy = vi.fn();
    const adapter = new HttpEbayAdapter({
      fetch: fetchSpy as unknown as typeof fetch,
      tokenProvider,
      env: () => sellerEnv,
    });

    const err = await adapter
      .publishListing({ ...request, imageUrls: [] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/no image URLs/i);
    expect((err as Error).message).toMatch(/at least one photo/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("recovers from 'offer already exists' (25002) by updating + publishing the existing offer", async () => {
    const { fetch, calls } = fakeFetch((url, init) => {
      if (url.includes("/inventory_item/")) return new Response(null, { status: 204 });
      if (url.endsWith("/sell/inventory/v1/offer") && init.method === "POST") {
        return json(400, {
          errors: [
            {
              errorId: 25002,
              message: "Offer entity already exists.",
              parameters: [{ name: "offerId", value: "offer-old" }],
            },
          ],
        });
      }
      if (url.endsWith("/offer/offer-old") && init.method === "PUT") {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/offer/offer-old/publish")) return json(200, { listingId: "L-2" });
      throw new Error(`unexpected call: ${url}`);
    });
    const adapter = new HttpEbayAdapter({ fetch, tokenProvider, env: () => sellerEnv });

    const result = await adapter.publishListing(request);
    expect(result).toEqual({ listingId: "L-2", offerId: "offer-old", status: "published" });
    // create attempt -> update-in-place -> publish (re-publish after a half-failed run).
    expect(calls.map((c) => `${c.init.method} ${c.url.slice(BASE.length)}`)).toEqual([
      "PUT /sell/inventory/v1/inventory_item/listing-uuid-1",
      "POST /sell/inventory/v1/offer",
      "PUT /sell/inventory/v1/offer/offer-old",
      "POST /sell/inventory/v1/offer/offer-old/publish",
    ]);
    // The recovered offer's update-in-place carries the required duration too.
    const updateBody = JSON.parse(String(calls[2]!.init.body));
    expect(updateBody.listingDuration).toBe("GTC");
  });

  it("propagates other eBay errors as EbayApiError with status + payload", async () => {
    const { fetch } = fakeFetch((url) => {
      if (url.includes("/inventory_item/")) {
        return json(400, { errors: [{ errorId: 25001, message: "Invalid aspects." }] });
      }
      throw new Error(`unexpected call: ${url}`);
    });
    const adapter = new HttpEbayAdapter({ fetch, tokenProvider, env: () => sellerEnv });

    const err = await adapter.publishListing(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EbayApiError);
    expect((err as EbayApiError).status).toBe(400);
    expect((err as EbayApiError).message).toContain("Invalid aspects.");
  });

  it("fails fast with a readable error when seller policy env vars are missing (no network)", async () => {
    const fetchSpy = vi.fn();
    const adapter = new HttpEbayAdapter({
      fetch: fetchSpy as unknown as typeof fetch,
      tokenProvider,
      env: () => ({ EBAY_BASE_URL: BASE }),
    });

    const err = await adapter.publishListing(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    for (const name of [
      "EBAY_FULFILLMENT_POLICY_ID",
      "EBAY_PAYMENT_POLICY_ID",
      "EBAY_RETURN_POLICY_ID",
      "EBAY_MERCHANT_LOCATION_KEY",
    ]) {
      expect((err as Error).message).toContain(name);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sandbox -> production is ONLY the EBAY_BASE_URL flip (URLs follow the env)", async () => {
    const prod = "https://api.ebay.com";
    const { fetch, calls } = fakeFetch((url) => {
      if (url.includes("/inventory_item/")) return new Response(null, { status: 204 });
      if (url.endsWith("/offer")) return json(201, { offerId: "o" });
      return json(200, { listingId: "l" });
    });
    const adapter = new HttpEbayAdapter({
      fetch,
      tokenProvider,
      env: () => ({ ...sellerEnv, EBAY_BASE_URL: prod }),
    });
    await adapter.publishListing(request);
    for (const call of calls) expect(call.url.startsWith(prod)).toBe(true);
  });
});
