import { describe, expect, it, vi } from "vitest";
import type { PipelineResult } from "./types";
import {
  createSupabaseGuidedCorrectionCompletionGateway,
  type GuidedCorrectionAuthorizationRpcClient,
  type GuidedCorrectionCompletionRpcClient,
} from "./guided-correction-completion";

const token = "a".repeat(43);
const now = Date.parse("2026-07-20T15:00:00.000Z");

const result: PipelineResult = {
  attributes: {
    brand: "Sony",
    model: "WH-1000XM5",
    category: "electronics",
    condition: "good",
    title: "Sony WH-1000XM5",
  },
  identification: {
    label: "Sony WH-1000XM5",
    confident: true,
    evidence: 1,
  },
  price: {
    suggested: 199,
    range: { min: 180, max: 220 },
    confidence: 0.85,
    sources: [{ url: "HTTPS://example.com:443/valid", kind: "sold-comp" }],
    tier: "ebay-sold",
    evidence: [
      {
        id: "upper-port",
        sourceUrl: "HTTPS://example.com:443/valid",
        title: "界".repeat(167),
        price: 199,
        currency: "USD",
        kind: "sold-comparable",
        priceDisclosure: "displayed-sold-price",
      },
    ],
  },
  confidence: { score: 0.85, band: "high", autopilotEligible: false },
  listing: {
    platform: "ebay",
    title: "Sony WH-1000XM5 Headphones",
    description: "Corrected model in good used condition.",
    fields: { itemSpecifics: { Brand: "Sony", Model: "WH-1000XM5" } },
  },
  model: "vision-model",
  listingModel: "listing-model",
};

function clients() {
  const authorizationRpc = vi.fn(async () => ({
    data: { expiresAt: "2026-07-20T15:05:00+00:00" },
    error: null,
  }));
  const completionRpc = vi.fn(async () => ({ data: true, error: null }));
  return {
    authorizationRpc,
    completionRpc,
    authorization: { rpc: authorizationRpc } as GuidedCorrectionAuthorizationRpcClient,
    completion: { rpc: completionRpc } as GuidedCorrectionCompletionRpcClient,
  };
}

describe("guided correction completion gateway", () => {
  it("mints a deterministic short-lived capability bound to the whole review attempt", async () => {
    const rpc = clients();
    const gateway = createSupabaseGuidedCorrectionCompletionGateway(
      rpc.authorization,
      rpc.completion,
      { now: () => now, tokenGenerator: () => token },
    );

    await expect(
      gateway.authorize({
        itemId: "00000000-0000-4000-8000-000000000001",
        listingId: "00000000-0000-4000-8000-000000000002",
        runId: "00000000-0000-4000-8000-000000000003",
        expectedRunId: "00000000-0000-4000-8000-000000000004",
        expectedReviewRevision: "00000000-0000-4000-8000-000000000005",
      }),
    ).resolves.toEqual({
      token,
      expiresAt: "2026-07-20T15:05:00+00:00",
    });

    expect(rpc.authorizationRpc).toHaveBeenCalledWith(
      "authorize_ai_item_guided_correction",
      {
        p_completion_run_id: "00000000-0000-4000-8000-000000000003",
        p_completion_token: token,
        p_expires_at: "2026-07-20T15:05:00.000Z",
        p_expected_review_revision: "00000000-0000-4000-8000-000000000005",
        p_expected_run_id: "00000000-0000-4000-8000-000000000004",
        p_item_id: "00000000-0000-4000-8000-000000000001",
        p_listing_id: "00000000-0000-4000-8000-000000000002",
      },
    );
  });

  it("constructs one strict reader-compatible commit before the fixed internal RPC", async () => {
    const rpc = clients();
    const gateway = createSupabaseGuidedCorrectionCompletionGateway(
      rpc.authorization,
      rpc.completion,
      { now: () => now, tokenGenerator: () => token },
    );

    await gateway.complete({
      capabilityToken: token,
      itemId: "00000000-0000-4000-8000-000000000001",
      listingId: "00000000-0000-4000-8000-000000000002",
      runId: "00000000-0000-4000-8000-000000000003",
      expectedRunId: "00000000-0000-4000-8000-000000000004",
      expectedReviewRevision: "00000000-0000-4000-8000-000000000005",
      result,
    });

    expect(rpc.completionRpc).toHaveBeenCalledOnce();
    expect(rpc.completionRpc).toHaveBeenCalledWith(
      "complete_guided_review_correction",
      {
        p_completion_token: token,
        p_commit: expect.objectContaining({
          item_id: "00000000-0000-4000-8000-000000000001",
          listing_id: "00000000-0000-4000-8000-000000000002",
          run_id: "00000000-0000-4000-8000-000000000003",
          expected_run_id: "00000000-0000-4000-8000-000000000004",
          expected_review_revision: "00000000-0000-4000-8000-000000000005",
          pricing_snapshot: expect.objectContaining({
            item: { title: "Sony WH-1000XM5", condition: "good" },
            evidence: [
              expect.objectContaining({
                sourceUrl: "HTTPS://example.com:443/valid",
                title: "界".repeat(167),
              }),
            ],
          }),
        }),
      },
    );
  });

  it("fails before privileged completion when the result is not strict-reader valid", async () => {
    const rpc = clients();
    const gateway = createSupabaseGuidedCorrectionCompletionGateway(
      rpc.authorization,
      rpc.completion,
      { now: () => now, tokenGenerator: () => token },
    );
    const invalid = structuredClone(result);
    invalid.price.sources[0]!.url = "https://%";
    invalid.price.evidence![0]!.sourceUrl = "https://%";

    await expect(
      gateway.complete({
        capabilityToken: token,
        itemId: "00000000-0000-4000-8000-000000000001",
        listingId: "00000000-0000-4000-8000-000000000002",
        runId: "00000000-0000-4000-8000-000000000003",
        expectedRunId: "00000000-0000-4000-8000-000000000004",
        expectedReviewRevision: "00000000-0000-4000-8000-000000000005",
        result: invalid,
      }),
    ).rejects.toThrow();
    expect(rpc.completionRpc).not.toHaveBeenCalled();
  });
});
