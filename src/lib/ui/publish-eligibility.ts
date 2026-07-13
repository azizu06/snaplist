/**
 * Honest publish-eligibility language shared by authenticated product surfaces.
 *
 * `queued` is a persisted confidence-gate result, not an execution queue: no
 * background consumer publishes it. The only marketplace write remains the
 * seller-triggered eBay publish action.
 */

export const MANUAL_PUBLISH_SENTENCE =
  "Nothing posts to eBay automatically—you choose Publish to eBay when you're ready.";

export type ReviewDispositionVariant = "success" | "warning" | "error";

export interface ReviewDisposition {
  variant: ReviewDispositionVariant;
  title: string;
  detail: string;
}

/** Manual publish page for a locally-ready listing; null for every other state. */
export function manualPublishPath(input: {
  status: string | null | undefined;
  listingId: string | null | undefined;
}): string | null {
  return input.status === "queued" && input.listingId
    ? `/listings/${input.listingId}`
    : null;
}

export function reviewDisposition(input: {
  status: string | null | undefined;
  eligibilityEnabled: boolean | null;
  confidenceFellShort: boolean;
}): ReviewDisposition | null {
  switch (input.status) {
    case "queued":
      return {
        variant: "success",
        title: "Ready to publish to eBay",
        detail: `High confidence marked this listing ready. ${MANUAL_PUBLISH_SENTENCE}`,
      };
    case "draft":
      return {
        variant: "warning",
        title: "Waiting for your review",
        detail:
          input.eligibilityEnabled === false
            ? "Publish eligibility was off when this listing was generated, so it waits for your review and manual publish."
            : input.confidenceFellShort
              ? "Confidence was below the eligibility threshold when this listing was generated, so it waits for your review and manual publish."
              : "This listing waits for your review and manual publish.",
      };
    case "published":
      return {
        variant: "success",
        title: "Live",
        detail: "This listing is live on the marketplace.",
      };
    case "failed":
      return {
        variant: "error",
        title: "Publish failed",
        detail:
          "The marketplace rejected or errored on this listing. Review it and retry from the publish page.",
      };
    default:
      return null;
  }
}
