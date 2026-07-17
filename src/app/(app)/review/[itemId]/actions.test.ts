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
  repriceWithSpecs: vi.fn(),
  rpc: vi.fn(
    async (): Promise<{
      data: unknown;
      error: { message: string } | null;
    }> => ({ data: true, error: null }),
  ),
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
vi.mock("@/lib/pipeline/reprice", () => ({
  repriceWithSpecs: mocks.repriceWithSpecs,
}));
vi.mock("@/lib/observability", () => ({ logEvent: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ reportServerError: vi.fn() }));

import { regenerateCorrectedIdentity, saveReview, sharpenEstimate } from "./actions";

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
    mocks.createClient.mockResolvedValue({ rpc: mocks.rpc });
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
    expect(mocks.createStore).toHaveBeenCalledWith(
      expect.objectContaining({ rpc: mocks.rpc }),
      { useCreditLedger: true },
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "authorize_ai_item_guided_correction",
      {
        p_item_id: "item-1",
        p_expected_review_revision: "00000000-0000-4000-8000-000000000001",
      },
    );
    expect(mocks.regenerate).toHaveBeenCalledTimes(1);
    expect(mocks.regenerate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        itemId: "item-1",
        expectedReviewRevision: "00000000-0000-4000-8000-000000000001",
      }),
      { beforeModelWork: expect.any(Function) },
    );
  });

  it("does not start provider work when the included correction is unavailable", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "The included guided correction is unavailable." },
    });

    await expect(regenerateCorrectedIdentity(correctionForm())).rejects.toThrow(
      /REDIRECT:/,
    );

    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.recordPipelineRunAndMaybeAlert).not.toHaveBeenCalled();
  });

  it("does not count a regeneration rejected during preflight", async () => {
    mocks.regenerate.mockRejectedValueOnce(new Error("A published listing cannot be regenerated."));

    await expect(regenerateCorrectedIdentity(correctionForm())).rejects.toThrow(
      /REDIRECT:/,
    );

    expect(mocks.recordPipelineRunAndMaybeAlert).not.toHaveBeenCalled();
  });
});

describe("saveReview", () => {
  it("preserves stored category and condition when ordinary-save fields are forged", async () => {
    const rpc = vi.fn(async () => ({ error: null }));
    const filters = {
      eq: () => filters,
      maybeSingle: async () => ({
        data: {
          id: "item-1",
          attributes: {
            brand: "Sony",
            category: "electronics",
            condition: "good",
          },
          condition: "good",
        },
        error: null,
      }),
    };
    mocks.createClient.mockResolvedValueOnce({
      from: () => ({ select: () => filters }),
      rpc,
    });

    const form = correctionForm();
    form.set("listingId", "listing-1");
    form.set("title", "Seller edited title");
    form.set("description", "Seller edited description");
    form.set("category", "forged category");
    form.set("condition", "poor");
    form.set("price", "120");
    form.set("costBasis", "40");

    await expect(saveReview(form)).rejects.toThrow(/REDIRECT:/);

    expect(rpc).toHaveBeenCalledWith(
      "save_review_edits",
      expect.objectContaining({
        p_attributes: expect.objectContaining({ category: "electronics" }),
        p_condition: "good",
      }),
    );
  });
});

describe("sharpenEstimate", () => {
  it("stops before paid pricing work when any eBay row is non-editable", async () => {
    const itemFilters = {
      eq: () => itemFilters,
      maybeSingle: async () => ({
        data: {
          id: "item-1",
          attributes: { brand: "Sony", category: "electronics" },
          review_revision: "00000000-0000-4000-8000-000000000001",
        },
        error: null,
      }),
    };
    const listingFilters = {
      eq: () => listingFilters,
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({
          data: [
            {
              status: "draft",
              ebay_listing_id: "v1|1234567890|0",
              ebay_status: "published",
            },
          ],
          error: null,
        }).then(resolve),
    };
    mocks.createClient.mockResolvedValueOnce({
      from: (table: string) => {
        if (table === "items") return { select: () => itemFilters };
        if (table === "listings") return { select: () => listingFilters };
        throw new Error(`unexpected table ${table}`);
      },
    });

    const form = correctionForm();
    form.set("detail", "512GB");

    await expect(sharpenEstimate(form)).rejects.toThrow(/REDIRECT:/);
    expect(mocks.repriceWithSpecs).not.toHaveBeenCalled();
  });
});
