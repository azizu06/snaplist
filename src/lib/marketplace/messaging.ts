/**
 * Provider-neutral marketplace messaging seam (issue #133).
 *
 * The inbox owns normalized questions and delivery receipts; only an adapter
 * knows how those values map to eBay's Trading API. Public sold-comps pricing
 * never imports this module and remains a separate, unauthenticated read path.
 */

export interface MarketplaceQuestion {
  marketplace: "ebay";
  /** The provider's exact question/message identity. */
  externalMessageId: string;
  /** The exact parent identifier required by the provider's reply operation. */
  externalParentId: string;
  /** Stable root for the provider's pre-sale question exchange. */
  externalConversationId: string;
  externalListingId: string;
  externalBuyerId: string;
  externalBuyerUsername?: string | null;
  body: string;
  subject: string | null;
  createdAt: string;
}

export interface PendingMarketplaceQuestion {
  marketplace: "ebay";
  externalMessageId: string;
  externalParentId: string;
  externalListingId: string;
  externalBuyerId: string | null;
  externalBuyerUsername?: string | null;
  body: string | null;
  subject: string | null;
  createdAt: string | null;
  resolutionWindowFrom: string;
  observedCursorAt: string;
}

export interface MarketplaceQuestionResolutionFailure {
  question: PendingMarketplaceQuestion;
  error: string;
}

export interface MarketplaceQuestionFetchResult {
  questions: MarketplaceQuestion[];
  unresolved: MarketplaceQuestionResolutionFailure[];
  answeredExternalMessageIds: string[];
}

export interface FetchQuestionsInput {
  /** Inclusive lower bound. Callers deliberately overlap windows. */
  from: Date;
  /** Inclusive upper bound and the cursor advanced after a successful fetch. */
  to: Date;
}

export interface MarketplaceDeliveryInput {
  accountGeneration?: string;
  signal?: AbortSignal;
  externalParentId: string;
  externalConversationId: string;
  externalListingId: string;
  externalBuyerId: string;
  body: string;
  /** Local request correlation. Providers are not assumed to dedupe on it. */
  idempotencyKey: string;
}

export interface MarketplaceDeliveryReceipt {
  /** Provider request/message correlation returned after acknowledged delivery. */
  externalDeliveryId: string;
  deliveredAt: string;
}

export interface MarketplaceMessagingAdapter {
  fetchUnansweredQuestions(
    input: FetchQuestionsInput,
  ): Promise<MarketplaceQuestionFetchResult>;
  resolveQuestion(
    question: PendingMarketplaceQuestion,
  ): Promise<MarketplaceQuestion>;
  replyToQuestion(
    input: MarketplaceDeliveryInput,
  ): Promise<MarketplaceDeliveryReceipt>;
  sendFollowUp(
    input: MarketplaceDeliveryInput,
  ): Promise<MarketplaceDeliveryReceipt>;
}

export type MarketplaceDeliveryFailureKind =
  | "rejected"
  | "failed"
  | "ambiguous";

/**
 * A write failure whose honesty semantics must survive persistence.
 *
 * - rejected: eBay definitively rejected the request;
 * - failed: eBay reported a retryable system failure;
 * - ambiguous: transport ended without proof whether eBay received the write.
 */
export class MarketplaceDeliveryError extends Error {
  constructor(
    public readonly kind: MarketplaceDeliveryFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MarketplaceDeliveryError";
  }
}
