import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  revalidatePath: vi.fn(),
  createClient: vi.fn(async () => ({})),
  getUserId: vi.fn(async () => "user-1"),
  parseIdentityCorrections: vi.fn(() => ({
    brand: "Sony",
    model: "WH-1000XM4",
    category: "electronics",
    condition: "good",
    isbn: null,
    upc: null,
    specs: [],
  })),
  createStore: vi.fn(() => ({})),
  regenerate: vi.fn(),
  rateLimitAllows: vi.fn(async () => true),
  recordPipelineRunAndMaybeAlert: vi.fn(async () => undefined),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth", () => ({ getUserId: mocks.getUserId }));
vi.mock("@/lib/pipeline/review-regeneration", () => ({
  parseIdentityCorrections: mocks.parseIdentityCorrections,
  createSupabaseReviewRegenerationStore: mocks.createStore,
  regenerateReviewListing: mocks.regenerate,
}));
vi.mock("@/lib/abuse", () => ({
  rateLimitAllows: mocks.rateLimitAllows,
  recordPipelineRunAndMaybeAlert: mocks.recordPipelineRunAndMaybeAlert,
}));
vi.mock("@/lib/observability", () => ({ logEvent: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ reportServerError: vi.fn() }));

import { regenerateCorrectedIdentity } from "./actions";

function correctionForm(): FormData {
  const form = new FormData();
  form.set("itemId", "item-1");
  form.set("reviewRevision", "00000000-0000-4000-8000-000000000001");
  return form;
}

describe("regenerateCorrectedIdentity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserId.mockResolvedValue("user-1");
    mocks.rateLimitAllows.mockResolvedValue(true);
    mocks.regenerate.mockImplementation(async (_store, _input, deps) => {
      await deps.beforeModelWork();
      return {
        itemId: "item-1",
        listingId: "listing-1",
        runId: "run-1",
        priceOverride: null,
        price: { tier: "ebay-sold" },
        confidence: { score: 0.8, band: "high" },
      };
    });
  });

  it("stops before regeneration when the shared metered limit is exhausted", async () => {
    mocks.rateLimitAllows.mockResolvedValue(false);

    await expect(regenerateCorrectedIdentity(correctionForm())).rejects.toThrow(
      /REDIRECT:/,
    );

    expect(mocks.rateLimitAllows).toHaveBeenCalledWith("user-1");
    expect(mocks.regenerate).not.toHaveBeenCalled();
    expect(mocks.recordPipelineRunAndMaybeAlert).not.toHaveBeenCalled();
  });

  it("delegates budget accounting to the post-preflight model-work boundary", async () => {
    await expect(regenerateCorrectedIdentity(correctionForm())).rejects.toThrow(
      /REDIRECT:/,
    );

    expect(mocks.recordPipelineRunAndMaybeAlert).toHaveBeenCalledTimes(1);
    expect(mocks.regenerate).toHaveBeenCalledTimes(1);
    expect(mocks.regenerate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        itemId: "item-1",
        expectedReviewRevision: "00000000-0000-4000-8000-000000000001",
      }),
      { beforeModelWork: mocks.recordPipelineRunAndMaybeAlert },
    );
  });

  it("does not count a regeneration rejected during preflight", async () => {
    mocks.regenerate.mockRejectedValueOnce(new Error("A published listing cannot be regenerated."));

    await expect(regenerateCorrectedIdentity(correctionForm())).rejects.toThrow(
      /REDIRECT:/,
    );

    expect(mocks.recordPipelineRunAndMaybeAlert).not.toHaveBeenCalled();
  });
});
