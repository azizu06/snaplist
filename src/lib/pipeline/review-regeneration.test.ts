import { describe, expect, it, vi } from "vitest";
import type { ListingCopy } from "./types";
import type { PriceResult } from "../pricing";
import {
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

function store(): ReviewRegenerationStore & {
  commit: ReturnType<typeof vi.fn>;
} {
  return {
    load: vi.fn(async () => ({
      itemId: "item-1",
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
        status: "draft",
        ebayListingId: null,
        ebayStatus: null,
      },
      prediction: {
        model: "vision-model",
        autopilotEnabled: true,
      },
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
        runId: "00000000-0000-4000-8000-000000000126",
        itemId: "item-1",
        listingId: "listing-1",
        attributes: expect.objectContaining({
          brand: "Sony",
          model: "WH-1000XM4",
          condition: "like-new",
          title: "Sony WH-1000XM4",
        }),
        condition: "like-new",
        listing: generated,
        prediction: expect.objectContaining({
          run_id: "00000000-0000-4000-8000-000000000126",
          price: 165,
          sources: soldPrice.sources,
          extracted_attrs: expect.objectContaining({ model: "WH-1000XM4" }),
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

  it("shows listing generation only seller-confirmed measurements", async () => {
    const persistence = store();
    persistence.load = vi.fn(async () => ({
      itemId: "item-1",
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
        attributes: expect.objectContaining({
          measurements: expect.arrayContaining([
            expect.objectContaining({ name: "pit_to_pit", confirmed: false }),
            expect.objectContaining({ name: "length", confirmed: true }),
          ]),
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
      attributes: { brand: "Sony" },
      priceOverride: null,
      listing: {
        id: "listing-1",
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
      attributes: { brand: "Sony" },
      priceOverride: null,
      listing: {
        id: "listing-1",
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
});
