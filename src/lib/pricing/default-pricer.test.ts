import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetTtlCaches, type TtlCache } from "./comp-cache";
import { checkpointTrustedPriceEvidence } from "./approved-sold-provider";
import { createDefaultPricer } from "./default-pricer";
import type {
  ApifySoldComp,
  RunApifySoldActor,
} from "./providers/apify-sold";
import type { ItemSignal } from "./types";

const SIGNAL: ItemSignal = {
  brand: "Sony",
  model: "WH-1000XM4",
  category: "electronics",
  condition: "good",
  conditionKnown: true,
};

const PUBLIC_SOLD_HTML = `
  <ul class="srp-results">
    <li class="s-item">
      <div class="s-item__title">Sony WH-1000XM4 Wireless Headphones</div>
      <div class="s-item__price">$170.00</div>
      <div class="s-item__caption">Sold Jul 10, 2026</div>
      <div class="s-item__subtitle">Pre-Owned</div>
      <a class="s-item__link" href="https://www.ebay.com/itm/public-a">A</a>
    </li>
    <li class="s-item">
      <div class="s-item__title">Sony WH-1000XM4 Wireless Headphones</div>
      <div class="s-item__price">$190.00</div>
      <div class="s-item__caption">Sold Jul 11, 2026</div>
      <div class="s-item__subtitle">Pre-Owned</div>
      <a class="s-item__link" href="https://www.ebay.com/itm/public-b">B</a>
    </li>
  </ul>
`;

function apifyItems() {
  return [
    {
      url: "https://www.ebay.com/itm/apify-a",
      title: "Sony WH-1000XM4 Wireless Headphones",
      condition: "Pre-Owned",
      endedAt: "2026-07-10T12:00:00.000Z",
      soldPrice: "175",
      soldCurrency: "USD",
    },
    {
      url: "https://www.ebay.com/itm/apify-b",
      title: "Sony WH-1000XM4 Wireless Headphones",
      condition: "Pre-Owned",
      endedAt: "2026-07-11T12:00:00.000Z",
      soldPrice: "185",
      soldCurrency: "USD",
    },
  ];
}

describe("createDefaultPricer Apify composition", () => {
  beforeEach(() => {
    __resetTtlCaches();
  });

  it("keeps the Apify candidate inert by default and preserves the public sold provider", async () => {
    const runActor = vi.fn<RunApifySoldActor>(async () => ({
      status: "SUCCEEDED",
      items: apifyItems(),
    }));
    const fetchPage = vi.fn(async () => PUBLIC_SOLD_HTML);
    const price = createDefaultPricer({
      apifySold: { enabled: false, token: "secret", runActor },
      ebaySold: { fetchPage },
    });

    const result = await price(SIGNAL);

    expect(result.tier).toBe("ebay-sold");
    expect(result.suggested).toBe(190);
    expect(runActor).not.toHaveBeenCalled();
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("uses Apify first when explicitly enabled and does not call the public provider on success", async () => {
    const runActor = vi.fn<RunApifySoldActor>(async () => ({
      status: "SUCCEEDED",
      items: apifyItems(),
    }));
    const fetchPage = vi.fn(async () => PUBLIC_SOLD_HTML);
    const price = createDefaultPricer({
      apifySold: { enabled: true, token: "secret", runActor },
      ebaySold: { fetchPage },
    });

    const result = await price(SIGNAL);

    expect(result.tier).toBe("ebay-sold");
    expect(result.suggested).toBe(185);
    expect(runActor).toHaveBeenCalledTimes(1);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("preserves approved sold provenance through the production ordered provider", async () => {
    const price = createDefaultPricer({
      apifySold: {
        enabled: true,
        token: "secret",
        now: () => Date.parse("2026-07-18T12:00:00.000Z"),
        runActor: async () => ({
          status: "SUCCEEDED",
          items: [
            ...apifyItems(),
            {
              ...apifyItems()[0],
              url: "https://www.ebay.com/itm/apify-c",
              endedAt: "2026-07-12T12:00:00.000Z",
              soldPrice: "180",
            },
          ],
        }),
      },
      ebaySold: { fetchPage: async () => PUBLIC_SOLD_HTML },
    });

    const result = await price(SIGNAL);

    const checkpointed = checkpointTrustedPriceEvidence(result);
    expect(checkpointed.sources.filter((source) => source.kind === "sold-comp"))
      .toHaveLength(3);
    expect(checkpointed.sources.map((source) => source.soldProvider)).toEqual([
      "apify-ebay-sold",
      "apify-ebay-sold",
      "apify-ebay-sold",
    ]);
  });

  it("does not mint trusted Apify provenance from legacy cached rows with arbitrary URLs and prices", async () => {
    const cache: TtlCache<ApifySoldComp[]> = {
      async get() {
        return [
          {
            url: "https://evil.example/listing/a",
            title: "Sony WH-1000XM4 Wireless Headphones",
            price: 9_990,
            condition: "Pre-Owned",
            soldAt: Date.parse("2026-07-10T12:00:00.000Z"),
          },
          {
            url: "https://evil.example/listing/b",
            title: "Sony WH-1000XM4 Wireless Headphones",
            price: 10_010,
            condition: "Pre-Owned",
            soldAt: Date.parse("2026-07-11T12:00:00.000Z"),
          },
        ];
      },
      async set() {},
    };
    const runActor = vi.fn<RunApifySoldActor>(async () => {
      throw new Error("actor unavailable");
    });
    const fetchPage = vi.fn(async () => PUBLIC_SOLD_HTML);
    const price = createDefaultPricer({
      apifySold: {
        enabled: true,
        token: "secret",
        cache,
        now: () => Date.parse("2026-07-18T12:00:00.000Z"),
        runActor,
        emitDiagnostic: () => undefined,
      },
      ebaySold: { fetchPage },
    });

    const checkpointed = checkpointTrustedPriceEvidence(await price(SIGNAL));
    const soldSources = checkpointed.sources.filter(
      (source) => source.kind === "sold-comp",
    );

    expect({
      suggested: checkpointed.suggested,
      runActorCalls: runActor.mock.calls.length,
      publicFetchCalls: fetchPage.mock.calls.length,
      soldProviders: soldSources.map((source) => source.soldProvider),
      soldHosts: soldSources.map((source) => new URL(source.url).hostname),
    }).toEqual({
      suggested: 190,
      runActorCalls: 1,
      publicFetchCalls: 1,
      soldProviders: ["ebay-public-sold", "ebay-public-sold"],
      soldHosts: ["www.ebay.com", "www.ebay.com"],
    });
  });

  it("preserves approved sold provenance through the ISBN nested sold lookup", async () => {
    const isbn = "9780140328721";
    const price = createDefaultPricer({
      isbn: {
        fetchJson: async (url) =>
          url.includes("openlibrary.org")
            ? {
                title: "Fantastic Mr Fox",
                isbn_13: [isbn],
                key: "/books/OL7353617M",
              }
            : {
                totalItems: 1,
                items: [{
                  id: "GB_VOL_1",
                  volumeInfo: {
                    title: "Fantastic Mr Fox",
                    industryIdentifiers: [{ type: "ISBN_13", identifier: isbn }],
                    infoLink: "https://books.google.com/books?id=GB_VOL_1",
                  },
                  saleInfo: {
                    saleability: "FOR_SALE",
                    retailPrice: { amount: 8, currencyCode: "USD" },
                  },
                }],
              },
      },
      apifySold: {
        enabled: true,
        token: "secret",
        now: () => Date.parse("2026-07-18T12:00:00.000Z"),
        runActor: async () => ({
          status: "SUCCEEDED",
          items: [5, 6, 7].map((soldPrice, index) => ({
            url: `https://www.ebay.com/itm/book-${index}`,
            title: "Fantastic Mr Fox Roald Dahl Paperback",
            condition: "Pre-Owned",
            endedAt: `2026-07-${10 + index}T12:00:00.000Z`,
            soldPrice,
            soldCurrency: "USD",
          })),
        }),
      },
      ebaySold: { fetchPage: async () => PUBLIC_SOLD_HTML },
    });

    const result = await price({
      isbn,
      resolvedName: "Fantastic Mr Fox",
      category: "books",
      condition: "good",
      conditionKnown: true,
    });

    expect(result.tier).toBe("isbn-lookup");
    const checkpointed = checkpointTrustedPriceEvidence(result);
    expect(
      checkpointed.sources
        .filter((source) => source.kind === "sold-comp")
        .map((source) => source.soldProvider),
    ).toEqual([
      "apify-ebay-sold",
      "apify-ebay-sold",
      "apify-ebay-sold",
    ]);
  });

  it("falls through from Actor failure to the public sold provider without blocking listing pricing", async () => {
    const runActor = vi.fn<RunApifySoldActor>(async () => {
      throw new Error("actor unavailable");
    });
    const fetchPage = vi.fn(async () => PUBLIC_SOLD_HTML);
    const price = createDefaultPricer({
      apifySold: { enabled: true, token: "secret", runActor, emitDiagnostic: () => undefined },
      ebaySold: { fetchPage },
    });

    const result = await price(SIGNAL);

    expect(result.tier).toBe("ebay-sold");
    expect(result.suggested).toBe(190);
    expect(runActor).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("falls through when Actor retrieval has fewer than two matcher-approved anchors", async () => {
    const runActor = vi.fn<RunApifySoldActor>(async () => ({
      status: "SUCCEEDED",
      items: [
        apifyItems()[0],
        {
          ...apifyItems()[1],
          title: "Sony WH-1000XM4 replacement case",
          soldPrice: "20",
        },
      ],
    }));
    const fetchPage = vi.fn(async () => PUBLIC_SOLD_HTML);
    const price = createDefaultPricer({
      apifySold: { enabled: true, token: "secret", runActor },
      ebaySold: { fetchPage },
    });

    const result = await price(SIGNAL);

    expect(result.tier).toBe("ebay-sold");
    expect(result.suggested).toBe(190);
    expect(runActor).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
