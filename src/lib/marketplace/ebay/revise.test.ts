import { describe, expect, it, vi } from "vitest";
import { HttpEbayAdapter } from "./http";
import { MockEbayAdapter } from "./mock";
import { EbayApiError, type EbayReviseRequest } from "./types";

/**
 * Price-revision seam tests (issue #102) with a FAKE fetch — no live eBay call
 * anywhere in the suite. Pins the documented endpoint
 * (`POST /sell/inventory/v1/bulk_update_price_quantity`), the per-offer
 * failure surfacing (HTTP 200 with an inner error status must NOT read as
 * success), and the mock adapter's recording contract the offline repricing
 * tests rely on.
 */

const BASE = "https://api.sandbox.ebay.com";
const env = { EBAY_BASE_URL: BASE, EBAY_MARKETPLACE_ID: "EBAY_US" };
const tokenProvider = { getAccessToken: async () => "test-access-token" };

const request: EbayReviseRequest = {
  sku: "listing-uuid-1",
  offerId: "offer-9",
  price: { value: "84.00", currency: "USD" },
};

type Call = { url: string; init: RequestInit };

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

describe("HttpEbayAdapter.revisePrice", () => {
  it("holds a generation-bound dispatch lease through repricing", async () => {
    const release = vi.fn(async () => undefined);
    const getAccessToken = vi.fn(async () => "generation-token");
    const leasedProvider = {
      getAccessToken,
      beginProviderDispatch: vi.fn(async () => ({
        accountGeneration: "22222222-2222-4222-8222-222222222222",
        signal: new AbortController().signal,
        release,
      })),
    };
    const { fetch } = fakeFetch(() =>
      json(200, {
        responses: [
          { statusCode: 200, offers: [{ offerId: "offer-9", statusCode: 200 }] },
        ],
      }),
    );

    await new HttpEbayAdapter({
      fetch,
      tokenProvider: leasedProvider,
      env: () => env,
    }).revisePrice(request);

    expect(leasedProvider.beginProviderDispatch).toHaveBeenCalledWith(
      request.sku,
      "reprice",
    );
    expect(getAccessToken).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.any(AbortSignal),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("POSTs the documented bulk price update and returns revised", async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.endsWith("/sell/inventory/v1/bulk_update_price_quantity")) {
        return json(200, {
          responses: [
            { statusCode: 200, offers: [{ offerId: "offer-9", statusCode: 200 }] },
          ],
        });
      }
      throw new Error(`unexpected call: ${url}`);
    });
    const adapter = new HttpEbayAdapter({ fetch, tokenProvider, env: () => env });

    const result = await adapter.revisePrice(request);

    expect(result).toEqual({ offerId: "offer-9", status: "revised" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/sell/inventory/v1/bulk_update_price_quantity`);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({
      requests: [
        {
          sku: "listing-uuid-1",
          offers: [{ offerId: "offer-9", price: { value: "84.00", currency: "USD" } }],
        },
      ],
    });
  });

  it("surfaces a per-offer failure hidden inside an HTTP 200", async () => {
    const { fetch } = fakeFetch(() =>
      json(200, {
        responses: [
          { statusCode: 500, offers: [{ offerId: "offer-9", statusCode: 500 }] },
        ],
      }),
    );
    const adapter = new HttpEbayAdapter({ fetch, tokenProvider, env: () => env });

    await expect(adapter.revisePrice(request)).rejects.toBeInstanceOf(EbayApiError);
  });

  it("rejects an HTTP 200 with an empty responses array (no confirmation)", async () => {
    const { fetch } = fakeFetch(() => json(200, { responses: [] }));
    const adapter = new HttpEbayAdapter({ fetch, tokenProvider, env: () => env });

    await expect(adapter.revisePrice(request)).rejects.toBeInstanceOf(EbayApiError);
  });

  it("rejects an HTTP 200 whose response entry carries no statusCode", async () => {
    const { fetch } = fakeFetch(() =>
      json(200, { responses: [{ offers: [{ offerId: "offer-9" }] }] }),
    );
    const adapter = new HttpEbayAdapter({ fetch, tokenProvider, env: () => env });

    await expect(adapter.revisePrice(request)).rejects.toBeInstanceOf(EbayApiError);
  });

  it("throws EbayApiError on a non-2xx response", async () => {
    const { fetch } = fakeFetch(() =>
      json(403, { errors: [{ errorId: 1001, message: "Insufficient permissions" }] }),
    );
    const adapter = new HttpEbayAdapter({ fetch, tokenProvider, env: () => env });

    await expect(adapter.revisePrice(request)).rejects.toBeInstanceOf(EbayApiError);
  });
});

describe("MockEbayAdapter.revisePrice", () => {
  it("records the request and returns revised (offline contract)", async () => {
    const mock = new MockEbayAdapter();
    const result = await mock.revisePrice(request);
    expect(result).toEqual({ offerId: "offer-9", status: "revised" });
    expect(mock.reviseRequests).toEqual([request]);
  });

  it("rejects with the configured failure", async () => {
    const mock = new MockEbayAdapter();
    mock.reviseFailWith = new Error("boom");
    await expect(mock.revisePrice(request)).rejects.toThrow("boom");
  });
});
