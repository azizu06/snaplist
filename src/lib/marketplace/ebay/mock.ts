import type {
  EbayAdapter,
  EbayPublishCompletion,
  EbayPublishRequest,
  EbayPublishResult,
  EbayReviseRequest,
  EbayReviseCompletion,
  EbayReviseResult,
} from "./types";

/**
 * Offline publishing/repricing adapter. Marketplace-messaging tests use their
 * own mock; provider HTTP contracts use fake fetches, so no test calls live eBay.
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

  /** Every price-revision request received, in order (issue #102). */
  readonly reviseRequests: EbayReviseRequest[] = [];

  /** When set, revisePrice rejects with this error instead of succeeding. */
  reviseFailWith?: Error;

  async publishListing(
    request: EbayPublishRequest,
    complete?: EbayPublishCompletion,
  ): Promise<EbayPublishResult> {
    this.requests.push(request);
    if (this.failWith) throw this.failWith;
    const result = {
      listingId: `MOCK-EBAY-LISTING-${request.sku}`,
      offerId: `MOCK-EBAY-OFFER-${request.sku}`,
      status: "published" as const,
    };
    await complete?.(result, null);
    return result;
  }

  async revisePrice(
    request: EbayReviseRequest,
    complete?: EbayReviseCompletion,
  ): Promise<EbayReviseResult> {
    this.reviseRequests.push(request);
    if (this.reviseFailWith) throw this.reviseFailWith;
    const result = { offerId: request.offerId, status: "revised" as const };
    await complete?.(result, null);
    return result;
  }
}
