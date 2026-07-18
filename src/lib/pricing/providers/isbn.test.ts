import { describe, it, expect, vi } from "vitest";
import {
  createIsbnPricingProvider,
  USED_PRICE_FRACTION,
  type FetchJson,
} from "./isbn";
import { PriceRouter } from "../router";
import {
  PRICE_RESULT_MAX_SOURCES,
  PRICE_SOURCE_TITLE_MAX_LENGTH,
  PRICE_SOURCE_URL_MAX_LENGTH,
  priceResultSchema,
  type ItemSignal,
  type PriceResult,
} from "../types";

/**
 * The ISBN provider is tier 1 (`isbn-lookup`) — true structured lookup via
 * Open Library + Google Books (PRD §"Pricing pipeline": "ISBN present → true
 * structured lookup (Open Library + Google Books, free). Highest confidence.").
 *
 * The network call is INJECTED (`fetchJson`) so every test here runs fully
 * offline and deterministically — no real HTTP. We assert the contract
 * (`{ suggested, range, confidence, sources[] }`), that BOTH APIs are cited,
 * high confidence on a clean hit, the decline (null) path, and router tier
 * selection for an ISBN-bearing signal.
 */

const ISBN = "9780140328721"; // Fantastic Mr Fox (Roald Dahl), Penguin

// --- Canned API payloads (shapes mirror the real Open Library / Google Books) ---

/** Open Library `/isbn/{isbn}.json` edition record. */
const openLibraryEdition = {
  title: "Fantastic Mr Fox",
  authors: [{ key: "/authors/OL34184A" }],
  publishers: ["Puffin"],
  publish_date: "1988",
  number_of_pages: 96,
  isbn_13: [ISBN],
  key: "/books/OL7353617M",
};

/** Google Books `volumes?q=isbn:{isbn}` response with a retail listing price. */
const googleBooksVolumes = {
  totalItems: 1,
  items: [
    {
      id: "GB_VOL_1",
      volumeInfo: {
        title: "Fantastic Mr. Fox",
        authors: ["Roald Dahl"],
        publisher: "Puffin Books",
        publishedDate: "1988",
        industryIdentifiers: [{ type: "ISBN_13", identifier: ISBN }],
        infoLink: "https://books.google.com/books?id=GB_VOL_1",
      },
      saleInfo: {
        saleability: "FOR_SALE",
        listPrice: { amount: 9.99, currencyCode: "USD" },
        retailPrice: { amount: 7.99, currencyCode: "USD" },
      },
    },
  ],
};

/**
 * A fake fetchJson that routes by URL substring to the canned payloads above.
 * Lets us assert the provider calls BOTH APIs without touching the network.
 */
function fakeFetchJson(overrides?: {
  openLibrary?: unknown | null;
  googleBooks?: unknown | null;
}): FetchJson {
  return vi.fn(async (url: string) => {
    if (url.includes("openlibrary.org")) {
      const v = overrides?.openLibrary;
      return v === undefined ? openLibraryEdition : v;
    }
    if (url.includes("googleapis.com/books")) {
      const v = overrides?.googleBooks;
      return v === undefined ? googleBooksVolumes : v;
    }
    throw new Error(`unexpected url: ${url}`);
  });
}

describe("ISBN pricing provider", () => {
  it("declares the isbn-lookup tier and handles ISBN-bearing signals", () => {
    const provider = createIsbnPricingProvider({ fetchJson: fakeFetchJson() });
    expect(provider.tier).toBe("isbn-lookup");
    expect(provider.canHandle?.({ isbn: ISBN })).toBe(true);
    expect(provider.canHandle?.({ upc: "036000291452" })).toBe(false);
    expect(provider.canHandle?.({})).toBe(false);
  });

  it("prices a clean ISBN hit with a cited range from BOTH APIs", async () => {
    const fetchJson = fakeFetchJson();
    const provider = createIsbnPricingProvider({ fetchJson });
    const result = await provider.price({ isbn: ISBN });

    expect(result).not.toBeNull();
    // Contract: validates against the shared PriceResult schema.
    expect(() => priceResultSchema.parse(result)).not.toThrow();
    expect(result!.tier).toBe("isbn-lookup");

    // Both APIs were consulted...
    const calledUrls = (fetchJson as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as string,
    );
    expect(calledUrls.some((u) => u.includes("openlibrary.org"))).toBe(true);
    expect(calledUrls.some((u) => u.includes("googleapis.com/books"))).toBe(true);

    // ...and both are cited in sources[].
    const sourceUrls = result!.sources.map((s) => s.url);
    expect(sourceUrls.some((u) => u.includes("openlibrary.org"))).toBe(true);
    expect(sourceUrls.some((u) => u.includes("google"))).toBe(true);
    // Sources carry a human-readable title (the resolved book title).
    expect(result!.sources.every((s) => (s.title ?? "").length > 0)).toBe(true);
  });

  it("bounds external catalog citation metadata before the shared router validates it", async () => {
    const oversizedTitle = "T".repeat(PRICE_SOURCE_TITLE_MAX_LENGTH + 1);
    const oversizedUrlSuffix = "u".repeat(PRICE_SOURCE_URL_MAX_LENGTH);
    const provider = createIsbnPricingProvider({
      fetchJson: fakeFetchJson({
        openLibrary: {
          ...openLibraryEdition,
          title: oversizedTitle,
          key: `/books/${oversizedUrlSuffix}`,
        },
        googleBooks: {
          ...googleBooksVolumes,
          items: [
            {
              ...googleBooksVolumes.items[0],
              volumeInfo: {
                ...googleBooksVolumes.items[0].volumeInfo,
                title: oversizedTitle,
                infoLink: `https://books.google.com/books?id=${oversizedUrlSuffix}`,
              },
            },
          ],
        },
      }),
    });

    const result = await new PriceRouter([provider]).price({ isbn: ISBN });

    expect(result.sources).toHaveLength(2);
    expect(result.sources.every((source) => source.url.length <= PRICE_SOURCE_URL_MAX_LENGTH)).toBe(
      true,
    );
    expect(
      result.sources.every(
        (source) => (source.title?.length ?? 0) <= PRICE_SOURCE_TITLE_MAX_LENGTH,
      ),
    ).toBe(true);
    expect(result.sources.map((source) => source.url)).toEqual([
      `https://openlibrary.org/isbn/${ISBN}`,
      `https://books.google.com/books?q=isbn:${ISBN}`,
    ]);
  });

  it("bounds catalog titles without splitting a Unicode surrogate pair", async () => {
    const boundaryTitle = `${"A".repeat(
      PRICE_SOURCE_TITLE_MAX_LENGTH - 1,
    )}😀B`;
    const provider = createIsbnPricingProvider({
      fetchJson: fakeFetchJson({
        openLibrary: { ...openLibraryEdition, title: boundaryTitle },
        googleBooks: {
          ...googleBooksVolumes,
          items: [
            {
              ...googleBooksVolumes.items[0],
              volumeInfo: {
                ...googleBooksVolumes.items[0].volumeInfo,
                title: boundaryTitle,
              },
            },
          ],
        },
      }),
    });

    const result = await new PriceRouter([provider]).price({ isbn: ISBN });

    expect(result.sources.map((source) => source.title)).toEqual([
      "A".repeat(PRICE_SOURCE_TITLE_MAX_LENGTH - 1),
      "A".repeat(PRICE_SOURCE_TITLE_MAX_LENGTH - 1),
    ]);
    expect(JSON.stringify(result.sources)).not.toContain("\\ud83d");
  });

  it("suggests a used price below retail, inside the band", async () => {
    const provider = createIsbnPricingProvider({ fetchJson: fakeFetchJson() });
    const result = await provider.price({ isbn: ISBN });

    // Heuristic: used ≈ USED_PRICE_FRACTION of the discovered retail (7.99).
    const expectedUsed = 7.99 * USED_PRICE_FRACTION;
    expect(result!.suggested).toBeCloseTo(expectedUsed, 2);
    // Suggested sits within the band, and the band is below retail at the top.
    expect(result!.suggested).toBeGreaterThanOrEqual(result!.range.min);
    expect(result!.suggested).toBeLessThanOrEqual(result!.range.max);
    expect(result!.range.max).toBeLessThanOrEqual(7.99);
  });

  it("reports HIGH confidence for a clean single-match hit", async () => {
    const provider = createIsbnPricingProvider({ fetchJson: fakeFetchJson() });
    const result = await provider.price({ isbn: ISBN });
    expect(result!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("applies a condition-specific factor when the signal carries a condition", async () => {
    const provider = createIsbnPricingProvider({ fetchJson: fakeFetchJson() });
    const good = await provider.price({ isbn: ISBN, condition: "good" });
    const likeNew = await provider.price({ isbn: ISBN, condition: "like-new" });
    // A better condition should not price below a worse one.
    expect(likeNew!.suggested).toBeGreaterThanOrEqual(good!.suggested);
  });

  it("still prices from list price when only Google Books has a price", async () => {
    // Open Library has no price field at all; Google Books carries listPrice only.
    const gbListOnly = {
      totalItems: 1,
      items: [
        {
          id: "GB_VOL_2",
          volumeInfo: {
            title: "Fantastic Mr Fox",
            authors: ["Roald Dahl"],
            infoLink: "https://books.google.com/books?id=GB_VOL_2",
            industryIdentifiers: [{ type: "ISBN_13", identifier: ISBN }],
          },
          saleInfo: {
            saleability: "FOR_SALE",
            listPrice: { amount: 8.0, currencyCode: "USD" },
          },
        },
      ],
    };
    const provider = createIsbnPricingProvider({
      fetchJson: fakeFetchJson({ googleBooks: gbListOnly }),
    });
    const result = await provider.price({ isbn: ISBN });
    expect(result).not.toBeNull();
    expect(result!.suggested).toBeGreaterThan(0);
    expect(() => priceResultSchema.parse(result)).not.toThrow();
  });

  it("declines (null) when neither API yields a usable match", async () => {
    const provider = createIsbnPricingProvider({
      fetchJson: fakeFetchJson({
        openLibrary: null, // Open Library 404 → our fetchJson returns null
        googleBooks: { totalItems: 0, items: [] },
      }),
    });
    const result = await provider.price({ isbn: ISBN });
    expect(result).toBeNull();
  });

  it("declines (null) when no ISBN is present", async () => {
    const provider = createIsbnPricingProvider({ fetchJson: fakeFetchJson() });
    expect(await provider.price({ upc: "036000291452" })).toBeNull();
  });

  it("never fabricates a price: a match with no discoverable price still declines or cites a source", async () => {
    // Metadata resolves (a real book) but NO price anywhere. We must not invent
    // a number with empty sources — either decline, or only price with sources.
    const provider = createIsbnPricingProvider({
      fetchJson: fakeFetchJson({
        googleBooks: {
          totalItems: 1,
          items: [
            {
              id: "GB_NO_PRICE",
              volumeInfo: {
                title: "Fantastic Mr Fox",
                infoLink: "https://books.google.com/books?id=GB_NO_PRICE",
                industryIdentifiers: [{ type: "ISBN_13", identifier: ISBN }],
              },
              saleInfo: { saleability: "NOT_FOR_SALE" },
            },
          ],
        },
      }),
    });
    const result = await provider.price({ isbn: ISBN });
    if (result !== null) {
      expect(result.sources.length).toBeGreaterThan(0);
      expect(() => priceResultSchema.parse(result)).not.toThrow();
    }
  });

  it("propagates an upstream API failure as a thrown error (not a silent decline)", async () => {
    const boom: FetchJson = vi.fn(async () => {
      throw new Error("openlibrary 503");
    });
    const provider = createIsbnPricingProvider({ fetchJson: boom });
    await expect(provider.price({ isbn: ISBN })).rejects.toThrow(/503/);
  });
});

describe("ISBN provider wired into the PriceRouter (tier 1)", () => {
  it("the router SELECTS the ISBN provider for an ISBN-bearing signal", async () => {
    const isbnProvider = createIsbnPricingProvider({
      fetchJson: fakeFetchJson(),
    });
    // A trivial lower-tier fallback so the router has somewhere to fall through to.
    const fallback = {
      tier: "llm-only" as const,
      price: async () => ({
        suggested: 5,
        range: { min: 1, max: 10 },
        confidence: 0.1,
        sources: [],
        tier: "llm-only" as const,
      }),
    };
    const router = new PriceRouter([isbnProvider, fallback]);

    const isbnSignal: ItemSignal = { isbn: ISBN };
    const result = await router.price(isbnSignal);
    expect(result.tier).toBe("isbn-lookup");
    expect(result.sources.length).toBeGreaterThan(0);
  });

  it("the router falls through past the ISBN provider when there is no ISBN", async () => {
    const isbnProvider = createIsbnPricingProvider({
      fetchJson: fakeFetchJson(),
    });
    const fallback = {
      tier: "llm-only" as const,
      price: async () => ({
        suggested: 5,
        range: { min: 1, max: 10 },
        confidence: 0.1,
        sources: [],
        tier: "llm-only" as const,
      }),
    };
    const router = new PriceRouter([isbnProvider, fallback]);
    const result = await router.price({ brand: "Sony", model: "WH-1000XM4" });
    expect(result.tier).toBe("llm-only");
  });
});

describe("ISBN provider — sold-comp grounding (#2 confidence lever)", () => {
  /** A fake eBay-sold PriceResult, as the injected `soldLookup` would return. */
  const soldResult = (overrides: Partial<PriceResult> = {}): PriceResult => ({
    suggested: 6.5,
    range: { min: 5, max: 8 },
    confidence: 0.8,
    sources: [
      {
        url: "https://www.ebay.com/itm/sold-1",
        title: "Fantastic Mr Fox (used, paperback)",
        kind: "sold-comp",
      },
    ],
    tier: "ebay-sold",
    compAgreement: 0.9,
    ...overrides,
  });

  it("upgrades to a sold-grounded price (real used sales) while staying the isbn-lookup tier", async () => {
    const soldLookup = vi.fn(async () => soldResult());
    const provider = createIsbnPricingProvider({
      fetchJson: fakeFetchJson(),
      soldLookup,
    });
    const result = await provider.price({ isbn: ISBN });

    expect(result).not.toBeNull();
    expect(() => priceResultSchema.parse(result)).not.toThrow();
    // The tier stays isbn-lookup (structured identity) ...
    expect(result!.tier).toBe("isbn-lookup");
    // ... but the price now comes from the SOLD comps, not retail × 0.5 (catalog
    // would be ~3.995; the sold median is 6.5).
    expect(result!.suggested).toBeCloseTo(6.5, 2);
    expect(result!.range).toEqual({ min: 5, max: 8 });
    // It carries the sold-comp tightness for the composite ...
    expect(result!.compAgreement).toBe(0.9);
    // ... and cites BOTH the structured identity (isbn-lookup) AND the sold comps —
    // the sold-comp kind is exactly what the pipeline bridge needs to restore the
    // top `isbn` (0.95) confidence tier (confidence/from-price.ts: hasSoldComp).
    expect(result!.sources.some((s) => s.kind === "isbn-lookup")).toBe(true);
    expect(result!.sources.some((s) => s.kind === "sold-comp")).toBe(true);
  });

  it("reserves source slots for catalog identity when sold evidence already fills the shared cap", async () => {
    const soldSources = Array.from(
      { length: PRICE_RESULT_MAX_SOURCES },
      (_, index) => ({
        url: `https://www.ebay.com/itm/sold-${index + 1}`,
        title: `Fantastic Mr Fox sold comp ${index + 1}`,
        kind: "sold-comp",
      }),
    );
    const provider = createIsbnPricingProvider({
      fetchJson: fakeFetchJson(),
      soldLookup: vi.fn(async () => soldResult({ sources: soldSources })),
    });

    // Exercise the highest shared seam: the router validates every provider
    // result against the common PriceResult contract before returning it.
    const result = await new PriceRouter([provider]).price({ isbn: ISBN });

    expect(result.sources).toHaveLength(PRICE_RESULT_MAX_SOURCES);
    expect(result.sources.filter((source) => source.kind === "isbn-lookup")).toHaveLength(2);
    expect(result.sources.filter((source) => source.kind === "sold-comp")).toHaveLength(
      PRICE_RESULT_MAX_SOURCES - 2,
    );
    expect(result.sources[0].url).toContain("openlibrary.org");
    expect(result.sources[1].url).toContain("google");
    expect(result.sources[2].url).toBe("https://www.ebay.com/itm/sold-1");
    expect(result.sources.at(-1)?.url).toBe("https://www.ebay.com/itm/sold-58");
  });

  it("calls soldLookup with the signal, but only after a catalog identity resolves", async () => {
    const soldLookup = vi.fn(async () => soldResult());
    const provider = createIsbnPricingProvider({
      fetchJson: fakeFetchJson(),
      soldLookup,
    });
    const signal: ItemSignal = { isbn: ISBN };
    await provider.price(signal);
    expect(soldLookup).toHaveBeenCalledTimes(1);
    expect(soldLookup).toHaveBeenCalledWith(signal);
  });

  it("falls back to the catalog used-price estimate when NO sold comps are found", async () => {
    const soldLookup = vi.fn(async () => null);
    const provider = createIsbnPricingProvider({
      fetchJson: fakeFetchJson(),
      soldLookup,
    });
    const result = await provider.price({ isbn: ISBN });

    expect(result!.tier).toBe("isbn-lookup");
    // Catalog heuristic: ~retail (7.99) × USED_PRICE_FRACTION.
    expect(result!.suggested).toBeCloseTo(7.99 * USED_PRICE_FRACTION, 2);
    // No sold comp → stays a retail-derived estimate (bridge keeps it sub-gate).
    expect(result!.sources.some((s) => s.kind === "sold-comp")).toBe(false);
  });

  it("does NOT fetch sold comps when there is no catalog identity (declines; router falls to the eBay-sold tier)", async () => {
    const soldLookup = vi.fn(async () => soldResult());
    const provider = createIsbnPricingProvider({
      fetchJson: fakeFetchJson({
        openLibrary: null,
        googleBooks: { totalItems: 0, items: [] },
      }),
      soldLookup,
    });
    const result = await provider.price({ isbn: ISBN });
    expect(result).toBeNull();
    // No identity → don't spend a sold-comp fetch here; the standalone ebay-sold
    // tier handles the ISBN signal next and prices it as `ebay-sold`.
    expect(soldLookup).not.toHaveBeenCalled();
  });

  it("prices from sold comps even when the catalog exposed no retail anchor (identity + sold = top tier)", async () => {
    // A book with metadata but no list/retail price would normally DECLINE; with
    // sold comps it now prices from real sales and earns the isbn tier.
    const soldLookup = vi.fn(async () => soldResult());
    const provider = createIsbnPricingProvider({
      fetchJson: fakeFetchJson({
        googleBooks: {
          totalItems: 1,
          items: [
            {
              id: "GB_NO_PRICE",
              volumeInfo: {
                title: "Fantastic Mr Fox",
                infoLink: "https://books.google.com/books?id=GB_NO_PRICE",
                industryIdentifiers: [{ type: "ISBN_13", identifier: ISBN }],
              },
              saleInfo: { saleability: "NOT_FOR_SALE" },
            },
          ],
        },
      }),
      soldLookup,
    });
    const result = await provider.price({ isbn: ISBN });
    expect(result).not.toBeNull();
    expect(result!.tier).toBe("isbn-lookup");
    expect(result!.suggested).toBeCloseTo(6.5, 2);
    expect(result!.sources.some((s) => s.kind === "sold-comp")).toBe(true);
  });
});
