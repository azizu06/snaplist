import type {
  FetchQuestionsInput,
  MarketplaceDeliveryInput,
  MarketplaceDeliveryReceipt,
  MarketplaceMessagingAdapter,
  MarketplaceQuestion,
} from "./messaging";

/** Offline, deterministic marketplace messaging adapter used by all tests. */
export class MockMarketplaceMessagingAdapter
  implements MarketplaceMessagingAdapter
{
  questions: MarketplaceQuestion[] = [];
  readonly fetches: FetchQuestionsInput[] = [];
  readonly replies: MarketplaceDeliveryInput[] = [];
  readonly followUps: MarketplaceDeliveryInput[] = [];
  replyFailure?: Error;
  followUpFailure?: Error;

  async fetchUnansweredQuestions(
    input: FetchQuestionsInput,
  ): Promise<MarketplaceQuestion[]> {
    this.fetches.push(input);
    return this.questions.filter((question) => {
      const created = Date.parse(question.createdAt);
      return created >= input.from.getTime() && created <= input.to.getTime();
    });
  }

  async replyToQuestion(
    input: MarketplaceDeliveryInput,
  ): Promise<MarketplaceDeliveryReceipt> {
    this.replies.push(input);
    if (this.replyFailure) throw this.replyFailure;
    return {
      externalDeliveryId: `mock-reply-${input.idempotencyKey}`,
      deliveredAt: new Date().toISOString(),
    };
  }

  async sendFollowUp(
    input: MarketplaceDeliveryInput,
  ): Promise<MarketplaceDeliveryReceipt> {
    this.followUps.push(input);
    if (this.followUpFailure) throw this.followUpFailure;
    return {
      externalDeliveryId: `mock-followup-${input.idempotencyKey}`,
      deliveredAt: new Date().toISOString(),
    };
  }
}
