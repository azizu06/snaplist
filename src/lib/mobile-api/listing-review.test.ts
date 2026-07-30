import { describe, expect, it, vi } from "vitest";
import {
  createListingReviewReader,
  type ListingReviewDataClient,
} from "@/lib/listing-review";
import { createMobileApiHandler, type MobileApiPrincipal } from "./app";
import type { MobileRun } from "./contract";

const RUN_ID = "37600000-0000-4000-8000-000000000001";
const ITEM_ID = "37600000-0000-4000-8000-000000000002";
const LISTING_ID = "37600000-0000-4000-8000-000000000003";
const REVIEW_REVISION = "37600000-0000-4000-8000-000000000004";
const USER_ID = "user_listing_review";

const run: MobileRun = {
  id: RUN_ID,
  itemId: ITEM_ID,
  listingId: LISTING_ID,
  status: "succeeded",
  stage: "completed",
  attemptCount: 1,
  maxAttempts: 3,
  schemaVersion: 1,
  timestamps: {
    createdAt: "2026-07-29T12:00:00.000Z",
    updatedAt: "2026-07-29T12:04:00.000Z",
    enqueuedAt: "2026-07-29T12:00:01.000Z",
    startedAt: "2026-07-29T12:00:02.000Z",
    lastAttemptedAt: "2026-07-29T12:00:02.000Z",
    nextAttemptAt: null,
    completedAt: "2026-07-29T12:04:00.000Z",
    retentionCleanedAt: null,
  },
  item: { title: "Sony WH-1000XM4", photoCount: 1 },
  requiredInput: null,
  terminalOutcome: "succeeded",
  safeFailure: null,
  allowance: "settled",
  legalActions: {
    canRetry: false,
    canCancel: false,
    canOpenReview: false,
    canStartNewCapture: false,
  },
  lastMeaningfulUpdateAt: "2026-07-29T12:04:00.000Z",
  retentionCleanedAt: null,
};

function rawReview(userId = USER_ID) {
  return {
    run: {
      id: RUN_ID,
      userId,
      itemId: ITEM_ID,
      listingId: LISTING_ID,
      status: "succeeded",
      stage: "completed",
    },
    item: {
      id: ITEM_ID,
      userId,
      photos: [`${userId}/items/376-cover.jpg`],
      identification: {
        label: "Sony WH-1000XM4",
        confident: true,
        evidence: 0.9,
      },
      condition: "very-good",
      priceOverride: 149.99,
      reviewRevision: REVIEW_REVISION,
    },
    listing: {
      id: LISTING_ID,
      userId,
      itemId: ITEM_ID,
      runId: RUN_ID,
      title: "Sony WH-1000XM4 Noise-Canceling Headphones",
      description: "Clean, fully working headphones with case and charging cable.",
      copy: {
        fields: {
          itemSpecifics: {
            Brand: "Sony",
            Model: "WH-1000XM4",
          },
        },
      },
    },
    pricingSnapshot: {
      runId: RUN_ID,
      userId,
      itemId: ITEM_ID,
      listingId: LISTING_ID,
      schemaVersion: 1,
      priceResult: {
        suggested: 145,
        range: { min: 130, max: 160 },
        confidence: 0.72,
        sources: [] as Array<{
          url: string;
          title?: string;
          kind?: string;
        }>,
        tier: "llm-only",
      },
      evidence: [] as Array<{
        id: string;
        sourceUrl: string;
        title?: string;
        price: number;
        currency: string;
        condition?: string;
        soldAt?: number;
        kind: string;
        priceDisclosure: string;
        evidenceAsOf: string;
      }>,
      evidenceAsOf: "2026-07-29T12:03:00.000Z",
    },
  };
}

function uncitedEvidenceReview() {
  const review = rawReview();
  review.pricingSnapshot.priceResult = {
    suggested: 145,
    range: { min: 130, max: 160 },
    confidence: 0.72,
    sources: [{ url: "https://www.ebay.com/itm/cited" }],
    tier: "ebay-sold",
  };
  review.pricingSnapshot.evidence = [
    {
      id: "uncited-match",
      sourceUrl: "https://www.ebay.com/itm/uncited",
      title: "Unrelated sold listing",
      price: 140,
      currency: "USD",
      condition: "Used",
      soldAt: 1_785_283_200,
      kind: "sold-comparable",
      priceDisclosure: "displayed-sold-price",
      evidenceAsOf: "2026-07-29T12:03:00.000Z",
    },
  ];
  return review;
}

function citedEvidenceReview() {
  const review = rawReview();
  review.pricingSnapshot.priceResult = {
    suggested: 145,
    range: { min: 130, max: 160 },
    confidence: 0.72,
    sources: [{ url: "https://www.ebay.com/itm/cited" }],
    tier: "ebay-sold",
  };
  review.pricingSnapshot.evidence = [
    {
      id: "cited-match",
      sourceUrl: "https://www.ebay.com/itm/cited",
      title: "Sony WH-1000XM4 Headphones",
      price: 142.5,
      currency: "USD",
      condition: "Used",
      soldAt: 1_785_283_200,
      kind: "sold-comparable",
      priceDisclosure: "displayed-sold-price",
      evidenceAsOf: "2026-07-29T12:03:00.000Z",
    },
  ];
  return review;
}

function dataClient(review = rawReview()): ListingReviewDataClient {
  return {
    readReview: vi.fn().mockResolvedValue({ data: review, error: null }),
    signPhotoUrls: vi.fn().mockImplementation(async (paths: string[]) =>
      paths.map((path, ordinal) => ({
        ordinal,
        path,
        signedUrl: `https://media.snaplist.dev/${path}`,
      }))
    ),
  };
}

function handler(input: {
  principal: MobileApiPrincipal;
  reviewClient?: ListingReviewDataClient;
  runResult?: MobileRun | null;
}) {
  return createMobileApiHandler({
    authenticate: vi.fn().mockResolvedValue(input.principal),
    listingReview: createListingReviewReader(input.reviewClient ?? dataClient()),
    requestId: () => "request-listing-review",
    runOperations: {
      get: vi.fn().mockResolvedValue(input.runResult === undefined ? run : input.runResult),
      retry: vi.fn(),
      cancel: vi.fn(),
    },
    worker: {
      consume: vi.fn(),
    },
  });
}

describe("GET /v1/runs/:id coherent Listing Review", () => {
  it.each([
    {
      name: "Clerk",
      principal: { kind: "clerk", userId: USER_ID } satisfies MobileApiPrincipal,
      expectedReadToken: "clerk-bearer",
      expectedPhotoToken: "clerk-bearer",
    },
    {
      name: "GuestBearer",
      principal: {
        kind: "verifiedGuest",
        userId: USER_ID,
        mintOperationToken: vi.fn()
          .mockResolvedValueOnce("guest-run-jwt")
          .mockResolvedValueOnce("guest-review-jwt")
          .mockResolvedValueOnce("guest-photo-jwt"),
      } satisfies MobileApiPrincipal,
      expectedReadToken: "guest-review-jwt",
      expectedPhotoToken: "guest-photo-jwt",
    },
  ])("returns the same run-bound zero-match review for $name", async ({
    principal,
    expectedReadToken,
    expectedPhotoToken,
  }) => {
    const reviewClient = dataClient();
    const response = await handler({ principal, reviewClient })(
      new Request(`https://api.snaplist.dev/v1/runs/${RUN_ID}`, {
        headers: { authorization: "Bearer clerk-bearer" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        id: RUN_ID,
        itemId: ITEM_ID,
        listingId: LISTING_ID,
        legalActions: { canOpenReview: true },
        review: {
          schemaVersion: 1,
          binding: {
            runId: RUN_ID,
            itemId: ITEM_ID,
            listingId: LISTING_ID,
            reviewRevision: REVIEW_REVISION,
          },
          photos: [
            {
              ordinal: 0,
              url: `https://media.snaplist.dev/${USER_ID}/items/376-cover.jpg`,
            },
          ],
          identity: {
            label: "Sony WH-1000XM4",
            confident: true,
          },
          listing: {
            title: "Sony WH-1000XM4 Noise-Canceling Headphones",
            description: "Clean, fully working headphones with case and charging cable.",
            condition: "very-good",
            specifics: [
              { name: "Brand", value: "Sony" },
              { name: "Model", value: "WH-1000XM4" },
            ],
          },
          pricing: {
            suggestedPrice: 145,
            range: { minimum: 130, maximum: 160 },
            confidence: 0.72,
            sellerPriceOverride: 149.99,
            effectivePrice: 149.99,
          },
          evidenceAsOf: "2026-07-29T12:03:00.000Z",
          verifiedSoldMatches: [],
          startingPriceCopy: "Starting price estimate",
          soldEvidenceCopy: "No verified sold matches found.",
        },
      },
    });
    expect(reviewClient.readReview).toHaveBeenCalledWith(
      RUN_ID,
      expectedReadToken,
    );
    expect(reviewClient.signPhotoUrls).toHaveBeenCalledWith(
      [`${USER_ID}/items/376-cover.jpg`],
      expectedPhotoToken,
    );
  });

  it("returns one cited verified sold match through the public HTTP contract", async () => {
    const response = await handler({
      principal: { kind: "clerk", userId: USER_ID },
      reviewClient: dataClient(citedEvidenceReview()),
    })(
      new Request(`https://api.snaplist.dev/v1/runs/${RUN_ID}`, {
        headers: { authorization: "Bearer clerk-bearer" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        review: {
          verifiedSoldMatches: [
            {
              id: "cited-match",
              sourceURL: "https://www.ebay.com/itm/cited",
              soldPrice: 142.5,
              currency: "USD",
              soldAt: 1_785_283_200,
            },
          ],
          soldEvidenceCopy: null,
        },
      },
    });
  });

  it.each([
    ["sub-cent zero", 0.004],
    ["unsafe whole-digit magnitude", 99_999_999_999_999.99],
  ])("ignores an invalid legacy %s override and uses the recommendation", async (
    _name,
    legacyOverride,
  ) => {
    const review = rawReview();
    review.item.priceOverride = legacyOverride;
    const response = await handler({
      principal: { kind: "clerk", userId: USER_ID },
      reviewClient: dataClient(review),
    })(
      new Request(`https://api.snaplist.dev/v1/runs/${RUN_ID}`, {
        headers: { authorization: "Bearer clerk-bearer" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        review: {
          pricing: {
            sellerPriceOverride: null,
            effectivePrice: 145,
          },
        },
      },
    });
  });

  it.each([
    {
      name: "missing tenant run",
      runResult: null,
      reviewClient: dataClient(),
      expectedStatus: 404,
    },
    {
      name: "cross-tenant review row",
      runResult: run,
      reviewClient: dataClient(rawReview("user_foreign")),
      expectedStatus: 503,
    },
    {
      name: "uncited verified sold evidence",
      runResult: run,
      reviewClient: dataClient(uncitedEvidenceReview()),
      expectedStatus: 503,
    },
    {
      name: "review binding does not match the outer durable run",
      runResult: {
        ...run,
        itemId: "37600000-0000-4000-8000-000000000099",
      },
      reviewClient: dataClient(),
      expectedStatus: 503,
    },
  ])("fails closed for $name without exposing review data", async ({
    runResult,
    reviewClient,
    expectedStatus,
  }) => {
    const response = await handler({
      principal: { kind: "clerk", userId: USER_ID },
      reviewClient,
      runResult,
    })(
      new Request(`https://api.snaplist.dev/v1/runs/${RUN_ID}`, {
        headers: { authorization: "Bearer clerk-bearer" },
      }),
    );

    expect(response.status).toBe(expectedStatus);
    expect(JSON.stringify(await response.json())).not.toContain("Sony WH-1000XM4");
  });

  it.each([
    {
      name: "history",
      request: new Request("https://api.snaplist.dev/v1/runs"),
    },
    {
      name: "retry",
      request: new Request(`https://api.snaplist.dev/v1/runs/${RUN_ID}/retry`, {
        method: "POST",
        headers: { "idempotency-key": REVIEW_REVISION },
      }),
    },
    {
      name: "cancel",
      request: new Request(`https://api.snaplist.dev/v1/runs/${RUN_ID}/cancel`, {
        method: "POST",
        headers: { "idempotency-key": REVIEW_REVISION },
      }),
    },
  ])("does not extend GuestBearer to Clerk-only run $name", async ({ request }) => {
    const retry = vi.fn();
    const cancel = vi.fn();
    const list = vi.fn();
    request.headers.set("authorization", "Bearer guestcap_fixture");
    const response = await createMobileApiHandler({
      authenticate: vi.fn().mockResolvedValue({
        kind: "verifiedGuest",
        userId: USER_ID,
        mintOperationToken: vi.fn(),
      } satisfies MobileApiPrincipal),
      runHistory: { list },
      runOperations: { get: vi.fn(), retry, cancel },
      worker: { consume: vi.fn() },
    })(request);

    expect(response.status).toBe(403);
    expect(retry).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });
});
