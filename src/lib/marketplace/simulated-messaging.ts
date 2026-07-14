import type {
  MarketplaceDeliveryInput,
  MarketplaceDeliveryReceipt,
  MarketplaceMessagingAdapter,
  MarketplacePhotoUploadInput,
  MarketplaceHostedPhoto,
  MarketplaceListingSnapshot,
  MarketplaceQuestion,
  MarketplaceQuestionFetchResult,
} from "./messaging";

/**
 * Honest local transport for the existing demo-only simulated questions.
 * It performs no network write and returns an explicitly simulated receipt;
 * real imported eBay questions are always composed with the eBay adapter.
 */
export class SimulatedMarketplaceMessagingAdapter
  implements MarketplaceMessagingAdapter
{
  async fetchUnansweredQuestions(): Promise<MarketplaceQuestionFetchResult> {
    return { questions: [], unresolved: [], answeredExternalMessageIds: [] };
  }

  async resolveQuestion(): Promise<MarketplaceQuestion> {
    throw new Error("Simulated messages have no external question resolution");
  }

  async uploadPhoto(
    input: MarketplacePhotoUploadInput,
  ): Promise<MarketplaceHostedPhoto> {
    return {
      providerMediaId: `simulated-photo:${input.idempotencyKey}`,
      mediaName: input.name,
      mediaType: "IMAGE",
      mediaUrl: `https://i.ebayimg.com/simulated/${input.idempotencyKey}`,
      expiresAt: null,
    };
  }

  async fetchListingSnapshot(): Promise<MarketplaceListingSnapshot> {
    throw new Error("Simulated listings have no marketplace snapshot");
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
