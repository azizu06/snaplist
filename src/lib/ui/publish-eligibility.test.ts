import { describe, expect, it } from "vitest";
import {
  MANUAL_PUBLISH_SENTENCE,
  manualPublishPath,
  reviewDisposition,
} from "./publish-eligibility";

describe("manual publish eligibility copy", () => {
  it("explains that queued means ready for an explicit seller publish", () => {
    expect(
      reviewDisposition({
        status: "queued",
        eligibilityEnabled: true,
        confidenceFellShort: false,
      }),
    ).toEqual({
      variant: "success",
      title: "Ready to publish to eBay",
      detail:
        "High confidence marked this listing ready. Nothing posts to eBay automatically—you choose Publish to eBay when you're ready.",
    });
  });

  it("keeps draft explanations honest about eligibility without implying execution", () => {
    expect(
      reviewDisposition({
        status: "draft",
        eligibilityEnabled: false,
        confidenceFellShort: false,
      }),
    ).toMatchObject({
      title: "Waiting for your review",
      detail:
        "Publish eligibility was off when this listing was generated, so it waits for your review and manual publish.",
    });

    expect(
      reviewDisposition({
        status: "draft",
        eligibilityEnabled: true,
        confidenceFellShort: true,
      }),
    ).toMatchObject({
      title: "Waiting for your review",
      detail:
        "Confidence was below the eligibility threshold when this listing was generated, so it waits for your review and manual publish.",
    });
  });

  it("provides one shared promise for settings and marketing surfaces", () => {
    expect(MANUAL_PUBLISH_SENTENCE).toBe(
      "Nothing posts to eBay automatically—you choose Publish to eBay when you're ready.",
    );
  });

  it("offers the dashboard publish action only for a ready persisted listing", () => {
    expect(manualPublishPath({ status: "queued", listingId: "listing-1" })).toBe(
      "/listings/listing-1",
    );
    expect(manualPublishPath({ status: "draft", listingId: "listing-1" })).toBeNull();
    expect(manualPublishPath({ status: "published", listingId: "listing-1" })).toBeNull();
    expect(manualPublishPath({ status: "queued", listingId: null })).toBeNull();
  });
});
