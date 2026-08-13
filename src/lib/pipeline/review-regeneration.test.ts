import { describe, expect, it, vi } from "vitest";
import type { ListingCopy } from "./types";
import type { PriceResult } from "../pricing";
import { recordModelUsage } from "../provider-usage";
import type { GuidedCorrectionCompletionGateway } from "./guided-correction-completion";
import {
  createSupabaseReviewRegenerationStore,
  parseIdentityCorrections,
  regenerateReviewListing,
  type ReviewRegenerationStore,
} from "./review-regeneration";

const soldPrice: PriceResult = {
  suggested: 165,
  range: { min: 145, max: 185 },
  confidence: 0.8,
  sources: [{ url: "https://www.ebay.com/itm/1", kind: "sold-comp" }],
  tier: "ebay-sold",
  compAgreement: 0.9,
};

const generated: ListingCopy = {
  platform: "ebay",
  title: "Sony WH-1000XM4 Wireless Headphones",
  description: "Sony WH-1000XM4 headphones in good condition.",
  fields: { itemSpecifics: { Brand: "Sony", Model: "WH-1000XM4" } },
};

const REVIEW_REVISION = "00000000-0000-4000-8000-000000000124";

function store(): ReviewRegenerationStore & {
  authorize: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  recordProviderUsage?: ReturnType<typeof vi.fn>;
} {
  return {
    load: vi.fn(async () => ({
      itemId: "item-1",
      reviewRevision: REVIEW_REVISION,
      reviewBlocked: false,
      attributes: {
        brand: "S0ny",
        model: "WH-1000XM3",
        category: "electronics",
        condition: "fair",
        upc: "027242919662",
        specs: ["wrong color", "wireless"],
        title: "S0ny WH-1000XM3 wrong identity",
      },
      priceOverride: 199,
      listing: {
        id: "listing-1",
        runId: "00000000-0000-4000-8000-000000000125",
        status: "draft",
        ebayListingId: null,
        ebayStatus: null,
      },
      prediction: {
        model: "vision-model",
        autopilotEnabled: true,
      },
    })),
    authorize: vi.fn(async () => ({
      token: "a".repeat(43),
      expiresAt: "2026-07-20T15:05:00+00:00",
    })),
    commit: vi.fn(async () => undefined),
  };
}

describe("parseIdentityCorrections", () => {
  it("normalizes the bounded identity fields and REPLACES specifications", () => {
    expect(
      parseIdentityCorrections({
        brand: "  Sony ",
        model: " WH-1000XM4 ",
        category: " Consumer electronics ",
        condition: " Good ",
        isbn: "",
        upc: "0 27242-91966 2",
        specifications: " wireless\nNoise cancelling, wireless ",
      }),
    ).toEqual({
      brand: "Sony",
      model: "WH-1000XM4",
      category: "Consumer electronics",
      condition: "good",
      isbn: null,
      upc: "027242919662",
      specs: ["wireless", "Noise cancelling"],
    });
  });

  it("supports generic items and explicit clearing without inventing identity", () => {
    expect(
      parseIdentityCorrections({
        brand: "",
        model: "",
        category: "miscellaneous",
        condition: "fair",
        isbn: "",
        upc: "",
        specifications: "",
      }),
    ).toEqual({
      brand: null,
      model: null,
      category: "miscellaneous",
      condition: "fair",
      isbn: null,
      upc: null,
      specs: [],
    });
  });

  it("normalizes the vision condition alias when another identity field changes", () => {
    expect(
      parseIdentityCorrections({
        brand: "Sony",
        model: "WH-1000XM4",
        category: "electronics",
        condition: "like-new",
        isbn: "",
        upc: "",
        specifications: "wireless",
      }).condition,
    ).toBe("like-new");
  });

  it.each(["very-good", "acceptable", "poor"])(
    "preserves the supported %s pricing grade when another field changes",
    (condition) => {
      expect(
        parseIdentityCorrections({
          brand: "Sony",
          model: "WH-1000XM4",
          category: "electronics",
          condition,
          isbn: "",
          upc: "",
          specifications: "wireless",
        }).condition,
      ).toBe(condition);
    },
  );

  it("rejects invalid identifiers, conditions, and unbounded specs", () => {
    const base = {
      brand: "Sony",
      model: "WH-1000XM4",
      category: "electronics",
      condition: "good",
      isbn: "",
      upc: "",
      specifications: "wireless",
    };
    expect(() => parseIdentityCorrections({ ...base, upc: "123" })).toThrow(/UPC/i);
    expect(() => parseIdentityCorrections({ ...base, isbn: "not-an-isbn" })).toThrow(/ISBN/i);
    expect(() => parseIdentityCorrections({ ...base, isbn: "4006381333931" })).toThrow(
      /ISBN/i,
    );
    expect(() => parseIdentityCorrections({ ...base, condition: "mint-ish" })).toThrow(
      /condition/i,
    );
    expect(() =>
      parseIdentityCorrections({
        ...base,
        specifications: Array.from({ length: 13 }, (_, i) => `spec ${i}`).join("\n"),
      }),
    ).toThrow(/12 specifications/i);
  });
});

describe("regenerateReviewListing", () => {
  it("feeds corrected identity to pricing and listing generation, then commits one coherent run", async () => {
    const persistence = store();
    const priceItem = vi.fn(async () => soldPrice);
    const generateListing = vi.fn(async () => ({ copy: generated, model: "listing-model" }));
    const beforeModelWork = vi.fn(async () => undefined);

    const result = await regenerateReviewListing(
      persistence,
      {
        itemId: "item-1",
        expectedReviewRevision: REVIEW_REVISION,
        corrections: parseIdentityCorrections({
          brand: "Sony",
          model: "WH-1000XM4",
          category: "electronics",
          condition: "like new",
          isbn: "",
          upc: "027242919662",
          specifications: "wireless\nnoise-cancelling",
        }),
      },
      {
        priceItem,
        generateListing,
        beforeModelWork,
        randomUUID: () => "00000000-0000-4000-8000-000000000126",
      },
    );

    expect(persistence.authorize).toHaveBeenCalledWith({
      itemId: "item-1",
      listingId: "listing-1",
      runId: "00000000-0000-4000-8000-000000000126",
      expectedRunId: "00000000-0000-4000-8000-000000000125",
      expectedReviewRevision: REVIEW_REVISION,
    });
    expect(persistence.authorize.mock.invocationCallOrder[0]).toBeLessThan(
      beforeModelWork.mock.invocationCallOrder[0]!,
    );
    expect(beforeModelWork).toHaveBeenCalledTimes(1);
    expect(beforeModelWork.mock.invocationCallOrder[0]).toBeLessThan(
      priceItem.mock.invocationCallOrder[0]!,
    );
    expect(priceItem).toHaveBeenCalledWith(
      expect.objectContaining({
        brand: "Sony",
        model: "WH-1000XM4",
        condition: "like-new",
        upc: "027242919662",
        specs: ["wireless", "noise-cancelling"],
      }),
    );
    expect(generateListing).toHaveBeenCalledWith({
      attributes: expect.objectContaining({
        brand: "Sony",
        model: "WH-1000XM4",
        condition: "like-new",
        specs: ["wireless", "noise-cancelling"],
      }),
    });
    expect(persistence.commit).toHaveBeenCalledTimes(1);
    expect(persistence.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityToken: "a".repeat(43),
        runId: "00000000-0000-4000-8000-000000000126",
        expectedRunId: "00000000-0000-4000-8000-000000000125",
        expectedReviewRevision: REVIEW_REVISION,
        itemId: "item-1",
        listingId: "listing-1",
        result: expect.objectContaining({
          attributes: expect.objectContaining({
            brand: "Sony",
            model: "WH-1000XM4",
            condition: "like-new",
            title: "Sony WH-1000XM4",
          }),
          listing: generated,
          price: soldPrice,
        }),
      }),
    );
    expect(result.priceOverride).toBe(199);
    expect(result.price).toEqual(soldPrice);
  });

  it("keeps generic items on the honest low-confidence fallback", async () => {
    const persistence = store();
    const fallback: PriceResult = {
      suggested: 12,
      range: { min: 7, max: 18 },
      confidence: 0.2,
      sources: [],
      tier: "llm-only",
    };
    const result = await regenerateReviewListing(
      persistence,
      {
        itemId: "item-1",
        expectedReviewRevision: REVIEW_REVISION,
        corrections: {
          brand: null,
          model: null,
          category: "miscellaneous",
          condition: "fair",
          isbn: null,
          upc: null,
          specs: [],
        },
      },
      {
        priceItem: async () => fallback,
        generateListing: async () => ({ copy: generated, model: "listing-model" }),
        randomUUID: () => "00000000-0000-4000-8000-000000000127",
      },
    );
    expect(result.confidence.band).toBe("low");
    expect(result.confidence.autopilotEligible).toBe(false);
  });

  it("runs independent pricing and listing generation concurrently after metering", async () => {
    const persistence = store();
    let releasePrice: ((price: PriceResult) => void) | undefined;
    const priceItem = vi.fn(
      () =>
        new Promise<PriceResult>((resolve) => {
          releasePrice = resolve;
        }),
    );
    const generateListing = vi.fn(async () => ({ copy: generated, model: "listing-model" }));
    const beforeModelWork = vi.fn(async () => undefined);

    const regeneration = regenerateReviewListing(
      persistence,
      {
        itemId: "item-1",
        expectedReviewRevision: REVIEW_REVISION,
        corrections: {
          brand: "Sony",
          model: "WH-1000XM4",
          category: "electronics",
          condition: "good",
          isbn: null,
          upc: null,
          specs: [],
        },
      },
      {
        priceItem,
        generateListing,
        beforeModelWork,
        randomUUID: () => "00000000-0000-4000-8000-000000000131",
      },
    );

    await vi.waitFor(() => {
      expect(priceItem).toHaveBeenCalledTimes(1);
      expect(generateListing).toHaveBeenCalledTimes(1);
    });
    expect(beforeModelWork.mock.invocationCallOrder[0]).toBeLessThan(
      priceItem.mock.invocationCallOrder[0]!,
    );
    expect(beforeModelWork.mock.invocationCallOrder[0]).toBeLessThan(
      generateListing.mock.invocationCallOrder[0]!,
    );

    releasePrice?.(soldPrice);
    await regeneration;
  });

  it("shows listing generation only seller-confirmed measurements", async () => {
    const persistence = store();
    persistence.load = vi.fn(async () => ({
      itemId: "item-1",
      reviewRevision: REVIEW_REVISION,
      reviewBlocked: false,
      attributes: {
        brand: "Patagonia",
        model: "Better Sweater",
        category: "jacket",
        condition: "good",
        measurements: [
          {
            name: "pit_to_pit",
            value_in: 21,
            tolerance_in: 1,
            method: "prior-based",
            confirmed: false,
          },
          {
            name: "length",
            value_in: 27,
            tolerance_in: 0,
            method: "seller-entered",
            confirmed: true,
          },
        ],
      },
      priceOverride: null,
      listing: {
        id: "listing-1",
        runId: null,
        status: "draft",
        ebayListingId: null,
        ebayStatus: null,
      },
      prediction: { model: "vision-model", autopilotEnabled: false },
    }));
    const generateListing = vi.fn(async () => ({ copy: generated, model: "listing-model" }));

    await regenerateReviewListing(
      persistence,
      {
        itemId: "item-1",
        expectedReviewRevision: REVIEW_REVISION,
        corrections: {
          brand: "Patagonia",
          model: "Better Sweater",
          category: "jacket",
          condition: "good",
          isbn: null,
          upc: null,
          specs: [],
        },
      },
      {
        priceItem: async () => soldPrice,
        generateListing,
        randomUUID: () => "00000000-0000-4000-8000-000000000128",
      },
    );

    expect(generateListing).toHaveBeenCalledWith({
      attributes: expect.objectContaining({
        measurements: [
          expect.objectContaining({ name: "length", value_in: 27, confirmed: true }),
        ],
      }),
    });
    expect(persistence.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          attributes: expect.objectContaining({
            measurements: expect.arrayContaining([
              expect.objectContaining({ name: "pit_to_pit", confirmed: false }),
              expect.objectContaining({ name: "length", confirmed: true }),
            ]),
          }),
        }),
      }),
    );
  });

  it("does not commit when pricing or listing generation fails", async () => {
    const pricingStore = store();
    await expect(
      regenerateReviewListing(
        pricingStore,
        {
          itemId: "item-1",
          expectedReviewRevision: REVIEW_REVISION,
          corrections: {
            brand: "Sony",
            model: "WH-1000XM4",
            category: "electronics",
            condition: "good",
            isbn: null,
            upc: null,
            specs: [],
          },
        },
        {
          priceItem: async () => {
            throw new Error("pricing unavailable");
          },
          generateListing: async () => ({ copy: generated, model: "listing-model" }),
        },
      ),
    ).rejects.toThrow(/pricing unavailable/);
    expect(pricingStore.commit).not.toHaveBeenCalled();

    const listingStore = store();
    await expect(
      regenerateReviewListing(
        listingStore,
        {
          itemId: "item-1",
          expectedReviewRevision: REVIEW_REVISION,
          corrections: {
            brand: "Sony",
            model: "WH-1000XM4",
            category: "electronics",
            condition: "good",
            isbn: null,
            upc: null,
            specs: [],
          },
        },
        {
          priceItem: async () => soldPrice,
          generateListing: async () => {
            throw new Error("listing unavailable");
          },
        },
      ),
    ).rejects.toThrow(/listing unavailable/);
    expect(listingStore.commit).not.toHaveBeenCalled();
  });

  it("rejects published listings before running paid or external work", async () => {
    const persistence = store();
    persistence.load = vi.fn(async () => ({
      itemId: "item-1",
      reviewRevision: REVIEW_REVISION,
      reviewBlocked: true,
      attributes: { brand: "Sony" },
      priceOverride: null,
      listing: {
        id: "listing-1",
        runId: null,
        status: "published",
        ebayListingId: null,
        ebayStatus: null,
      },
      prediction: { model: "vision-model", autopilotEnabled: true },
    }));
    const priceItem = vi.fn(async () => soldPrice);
    const beforeModelWork = vi.fn(async () => undefined);
    await expect(
      regenerateReviewListing(
        persistence,
        {
          itemId: "item-1",
          expectedReviewRevision: REVIEW_REVISION,
          corrections: {
            brand: "Sony",
            model: null,
            category: "electronics",
            condition: "good",
            isbn: null,
            upc: null,
            specs: [],
          },
        },
        {
          priceItem,
          beforeModelWork,
          generateListing: async () => ({ copy: generated, model: "listing" }),
          randomUUID: () => "00000000-0000-4000-8000-000000000129",
        },
      ),
    ).rejects.toThrow(/published/i);
    expect(priceItem).not.toHaveBeenCalled();
    expect(beforeModelWork).not.toHaveBeenCalled();
    expect(persistence.commit).not.toHaveBeenCalled();
  });

  it("rejects authoritative live eBay state before running paid or external work", async () => {
    const persistence = store();
    persistence.load = vi.fn(async () => ({
      itemId: "item-1",
      reviewRevision: REVIEW_REVISION,
      reviewBlocked: true,
      attributes: { brand: "Sony" },
      priceOverride: null,
      listing: {
        id: "listing-1",
        runId: null,
        status: "draft",
        ebayListingId: "v1|1234567890|0",
        ebayStatus: "published",
      },
      prediction: { model: "vision-model", autopilotEnabled: true },
    }));
    const priceItem = vi.fn(async () => soldPrice);

    await expect(
      regenerateReviewListing(
        persistence,
        {
          itemId: "item-1",
          expectedReviewRevision: REVIEW_REVISION,
          corrections: {
            brand: "Sony",
            model: null,
            category: "electronics",
            condition: "good",
            isbn: null,
            upc: null,
            specs: [],
          },
        },
        {
          priceItem,
          generateListing: async () => ({ copy: generated, model: "listing" }),
          randomUUID: () => "00000000-0000-4000-8000-000000000130",
        },
      ),
    ).rejects.toThrow(/published/i);
    expect(priceItem).not.toHaveBeenCalled();
    expect(persistence.commit).not.toHaveBeenCalled();
  });

  it("rejects an older non-editable eBay row before running paid work", async () => {
    const persistence = store();
    persistence.load = vi.fn(async () => ({
      itemId: "item-1",
      reviewRevision: REVIEW_REVISION,
      attributes: { brand: "Sony" },
      priceOverride: null,
      listing: {
        id: "newest-draft",
        runId: null,
        status: "draft",
        ebayListingId: null,
        ebayStatus: null,
      },
      prediction: { model: "vision-model", autopilotEnabled: true },
      reviewBlocked: true,
    }));
    const beforeModelWork = vi.fn(async () => undefined);
    const priceItem = vi.fn(async () => soldPrice);

    await expect(
      regenerateReviewListing(
        persistence,
        {
          itemId: "item-1",
          expectedReviewRevision: REVIEW_REVISION,
          corrections: {
            brand: "Sony",
            model: null,
            category: "electronics",
            condition: "good",
            isbn: null,
            upc: null,
            specs: [],
          },
        },
        {
          beforeModelWork,
          priceItem,
          generateListing: async () => ({ copy: generated, model: "listing" }),
        },
      ),
    ).rejects.toThrow(/published/i);
    expect(beforeModelWork).not.toHaveBeenCalled();
    expect(priceItem).not.toHaveBeenCalled();
    expect(persistence.commit).not.toHaveBeenCalled();
  });

  it("rejects a stale rendered review revision before model work", async () => {
    const persistence = store();
    const beforeModelWork = vi.fn(async () => undefined);
    const priceItem = vi.fn(async () => soldPrice);

    await expect(
      regenerateReviewListing(
        persistence,
        {
          itemId: "item-1",
          expectedReviewRevision: "00000000-0000-4000-8000-000000000123",
          corrections: {
            brand: "Sony",
            model: "WH-1000XM4",
            category: "electronics",
            condition: "good",
            isbn: null,
            upc: null,
            specs: [],
          },
        },
        {
          beforeModelWork,
          priceItem,
          generateListing: async () => ({ copy: generated, model: "listing" }),
        },
      ),
    ).rejects.toThrow(/review changed/i);
    expect(beforeModelWork).not.toHaveBeenCalled();
    expect(priceItem).not.toHaveBeenCalled();
    expect(persistence.commit).not.toHaveBeenCalled();
  });

  it("reports what the correction consumed under the capability that committed it", async () => {
    const persistence = store();
    const recordProviderUsage = vi.fn(async () => undefined);
    persistence.recordProviderUsage = recordProviderUsage;

    await regenerateReviewListing(
      persistence,
      {
        itemId: "item-1",
        expectedReviewRevision: REVIEW_REVISION,
        corrections: {
          brand: "Sony",
          model: "WH-1000XM4",
          category: "electronics",
          condition: "good",
          isbn: null,
          upc: null,
          specs: [],
        },
      },
      {
        priceItem: async () => {
          recordModelUsage({
            role: "pricingAgent",
            provider: "openai",
            model: "resolved-pricing",
            inputTokens: 100,
            outputTokens: 20,
          });
          return soldPrice;
        },
        generateListing: async () => {
          recordModelUsage({
            role: "listing",
            provider: "openai",
            model: "resolved-listing",
            inputTokens: 200,
            outputTokens: 40,
          });
          return { copy: generated, model: "resolved-listing" };
        },
      },
    );

    expect(recordProviderUsage).toHaveBeenCalledTimes(1);
    expect(recordProviderUsage).toHaveBeenCalledWith({
      capabilityToken: "a".repeat(43),
      usage: expect.objectContaining({
        schemaVersion: 1,
        modelCalls: 2,
        inputTokens: 300,
        outputTokens: 60,
        models: [
          expect.objectContaining({ role: "listing", model: "resolved-listing", calls: 1 }),
          expect.objectContaining({ role: "pricingAgent", model: "resolved-pricing", calls: 1 }),
        ],
      }),
    });
    // Bookkeeping follows the durable correction; it never gates it.
    expect(recordProviderUsage.mock.invocationCallOrder[0]).toBeGreaterThan(
      persistence.commit.mock.invocationCallOrder[0]!,
    );
  });

  it("returns the seller's correction even when the usage record cannot be written", async () => {
    const persistence = store();
    persistence.recordProviderUsage = vi.fn(async () => {
      throw new Error("provider usage writer is unavailable");
    });

    const result = await regenerateReviewListing(
      persistence,
      {
        itemId: "item-1",
        expectedReviewRevision: REVIEW_REVISION,
        corrections: {
          brand: "Sony",
          model: "WH-1000XM4",
          category: "electronics",
          condition: "good",
          isbn: null,
          upc: null,
          specs: [],
        },
      },
      {
        priceItem: async () => soldPrice,
        generateListing: async () => ({ copy: generated, model: "resolved-listing" }),
        randomUUID: () => "00000000-0000-4000-8000-000000000131",
      },
    );

    expect(persistence.commit).toHaveBeenCalledTimes(1);
    expect(result.runId).toBe("00000000-0000-4000-8000-000000000131");
    expect(result.listing).toEqual(generated);
  });

  it("wires the Supabase store to report a correction's spend", async () => {
    // The store is what regenerateReviewListing reports through, so a store
    // built for production has to actually carry the reporter. Without it the
    // measurement is taken and then dropped on the floor.
    const gateway = {
      authorize: vi.fn(),
      authorizeMobile: vi.fn(),
      complete: vi.fn(),
      completeMobile: vi.fn(),
      recordProviderUsage: vi.fn(async () => {}),
    } satisfies GuidedCorrectionCompletionGateway;
    const store = createSupabaseReviewRegenerationStore(
      {} as never,
      gateway,
    );
    const report = {
      capabilityToken: "b".repeat(43),
      usage: {
        schemaVersion: 1 as const,
        modelCalls: 1,
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 2,
        reasoningTokens: 0,
        models: [],
        transcriptions: [],
        soldComps: [],
      },
    };

    await store.recordProviderUsage?.(report);

    expect(gateway.recordProviderUsage).toHaveBeenCalledWith(report);
  });
});
