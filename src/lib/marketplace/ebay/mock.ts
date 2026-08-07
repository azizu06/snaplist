import type { EbayPolicyLocationCandidates } from "./policy-location-contract";
import type {
  EbayAdapter,
  EbayListingSnapshot,
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

  /**
   * What this "seller's" eBay account holds (issue #47). Left undefined, the
   * adapter has NO discovery capability at all — the honest offline default,
   * since a mock cannot invent another account's policy ids. Set it to model a
   * connected seller; an empty family models one who never created that policy.
   */
  policyLocationCandidates?: EbayPolicyLocationCandidates;

  /** When set, discovery rejects with this error instead of answering. */
  discoveryFailWith?: Error;

  /** Every discovery request received, in order. */
  readonly discoveryRequests: Array<{
    marketplaceId: string;
    accountGeneration: string;
  }> = [];

  /**
   * Present only when candidates (or a failure) are configured: an adapter that
   * silently answered "nothing" would look like a seller with an empty eBay
   * account instead of a capability the caller does not have.
   */
  discoverPolicyLocationCandidates?: (input: {
    marketplaceId: string;
    accountGeneration: string;
  }) => Promise<EbayPolicyLocationCandidates>;

  /**
   * What eBay would report for a published offer (issue #169). Undefined leaves
   * the adapter with NO read capability, which is the honest offline default:
   * a mock that answered "nothing changed" would be indistinguishable from
   * provider confirmation that nothing changed.
   */
  listingSnapshot?: EbayListingSnapshot;

  /** When set, the snapshot read rejects with this error instead of answering. */
  snapshotFailWith?: Error;

  /** Every snapshot read received, in order. */
  readonly snapshotRequests: Array<{ sku: string; offerId: string }> = [];

  /** Present only when a snapshot (or a failure) is configured. */
  getListingSnapshot?: (request: {
    sku: string;
    offerId: string;
  }) => Promise<EbayListingSnapshot>;

  constructor(options: {
    policyLocationCandidates?: EbayPolicyLocationCandidates;
    discoveryFailWith?: Error;
    listingSnapshot?: EbayListingSnapshot;
    snapshotFailWith?: Error;
  } = {}) {
    this.policyLocationCandidates = options.policyLocationCandidates;
    this.discoveryFailWith = options.discoveryFailWith;
    this.listingSnapshot = options.listingSnapshot;
    this.snapshotFailWith = options.snapshotFailWith;
    if (this.listingSnapshot || this.snapshotFailWith) {
      this.getListingSnapshot = async (request) => {
        this.snapshotRequests.push(request);
        if (this.snapshotFailWith) throw this.snapshotFailWith;
        return this.listingSnapshot!;
      };
    }
    if (!this.policyLocationCandidates && !this.discoveryFailWith) return;
    this.discoverPolicyLocationCandidates = async (input) => {
      this.discoveryRequests.push(input);
      if (this.discoveryFailWith) throw this.discoveryFailWith;
      return this.policyLocationCandidates!;
    };
  }

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
