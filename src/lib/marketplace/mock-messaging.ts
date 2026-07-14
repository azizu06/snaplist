import type {
  FetchQuestionsInput,
  MarketplaceDeliveryInput,
  MarketplaceDeliveryReceipt,
  MarketplaceMessagingAdapter,
  MarketplaceQuestion,
  MarketplaceQuestionFetchResult,
  MarketplaceQuestionResolutionFailure,
  PendingMarketplaceQuestion,
} from "./messaging";

/** Offline, deterministic marketplace messaging adapter used by all tests. */
export class MockMarketplaceMessagingAdapter
  implements MarketplaceMessagingAdapter
{
  questions: MarketplaceQuestion[] = [];
  unresolved: MarketplaceQuestionResolutionFailure[] = [];
  answeredExternalMessageIds: string[] = [];
  resolutionFailures = new Map<string, Error>();
  readonly fetches: FetchQuestionsInput[] = [];
  readonly replies: MarketplaceDeliveryInput[] = [];
  readonly followUps: MarketplaceDeliveryInput[] = [];
  replyFailure?: Error;
  followUpFailure?: Error;

  async fetchUnansweredQuestions(
    input: FetchQuestionsInput,
  ): Promise<MarketplaceQuestionFetchResult> {
    this.fetches.push(input);
    return {
      questions: this.questions.filter((question) => {
        const created = Date.parse(question.createdAt);
        return created >= input.from.getTime() && created <= input.to.getTime();
      }),
      unresolved: this.unresolved.filter(({ question }) => {
        const created = question.createdAt
          ? Date.parse(question.createdAt)
          : input.to.getTime();
        return created >= input.from.getTime() && created <= input.to.getTime();
      }),
      answeredExternalMessageIds: this.answeredExternalMessageIds,
    };
  }

  async resolveQuestion(
    question: PendingMarketplaceQuestion,
  ): Promise<MarketplaceQuestion> {
    const failure = this.resolutionFailures.get(question.externalMessageId);
    if (failure) throw failure;
    const resolved = this.questions.find(
      (candidate) => candidate.externalMessageId === question.externalMessageId,
    );
    if (!resolved) throw new Error("Mock question resolution failed");
    return resolved;
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
