import type {
  MarketplaceDeliveryInput,
  MarketplaceDeliveryReceipt,
  MarketplaceMessagingAdapter,
  MarketplaceQuestion,
} from "./messaging";

/**
 * Honest local transport for the existing demo-only simulated questions.
 * It performs no network write and returns an explicitly simulated receipt;
 * real imported eBay questions are always composed with the eBay adapter.
 */
export class SimulatedMarketplaceMessagingAdapter
  implements MarketplaceMessagingAdapter
{
  async fetchUnansweredQuestions(): Promise<MarketplaceQuestion[]> {
    return [];
  }

  async replyToQuestion(
    input: MarketplaceDeliveryInput,
  ): Promise<MarketplaceDeliveryReceipt> {
    return this.receipt(input);
  }

  async sendFollowUp(
    input: MarketplaceDeliveryInput,
  ): Promise<MarketplaceDeliveryReceipt> {
    return this.receipt(input);
  }

  private receipt(input: MarketplaceDeliveryInput): MarketplaceDeliveryReceipt {
    return {
      externalDeliveryId: `simulated:${input.idempotencyKey}`,
      deliveredAt: new Date().toISOString(),
    };
  }
}
