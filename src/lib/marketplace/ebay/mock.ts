import type { EbayAdapter, EbayPublishRequest, EbayPublishResult } from "./types";

/**
 * Offline eBay adapter — the ONLY adapter the test suite ever touches (issue #14
 * acceptance: "all tests run offline against a mock adapter; no live eBay calls").
 *
 * Deterministic: ids derive from the request SKU, so assertions are stable.
 * Records every request so tests can assert exactly what WOULD have been sent
 * to the Sell API. Configurable failure exercises the failed-publish persistence
 * path without any network.
 */
export class MockEbayAdapter implements EbayAdapter {
  /** Every publish request received, in order. */
  readonly requests: EbayPublishRequest[] = [];

  /** When set, publishListing rejects with this error instead of succeeding. */
  failWith?: Error;

  async publishListing(request: EbayPublishRequest): Promise<EbayPublishResult> {
    this.requests.push(request);
    if (this.failWith) throw this.failWith;
    return {
      listingId: `MOCK-EBAY-LISTING-${request.sku}`,
      offerId: `MOCK-EBAY-OFFER-${request.sku}`,
      status: "published",
    };
  }
}
