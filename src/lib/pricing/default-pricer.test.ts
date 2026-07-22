import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetTtlCaches } from "./comp-cache";
import { createDefaultPricer } from "./default-pricer";
import type { RunApifySoldActor } from "./providers/apify-sold";
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
    {
      url: "https://www.ebay.com/itm/apify-c",
      title: "Sony WH-1000XM4 Wireless Headphones",
      condition: "Pre-Owned",
      endedAt: "2026-07-12T12:00:00.000Z",
      soldPrice: "180",
      soldCurrency: "USD",
    },
  ];
}

function apifyItem(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    url: `https://www.ebay.com/itm/${id}`,
    title: "Sony WH-1000XM4 Wireless Headphones",
    condition: "Pre-Owned",
    endedAt: "2026-07-10T12:00:00.000Z",
    soldPrice: "180",
    soldCurrency: "USD",
    ...overrides,
  };
}

describe("createDefaultPricer Apify composition", () => {
  beforeEach(() => {
    __resetTtlCaches();
  });

  it("expands one thin ten-candidate match to twenty and caches the deterministic best five", async () => {
    const initial = [
      apifyItem("initial-a", { endedAt: "2026-07-20T12:00:00.000Z" }),
      apifyItem("initial-b", { endedAt: "2026-07-04T12:00:00.000Z" }),
      ...Array.from({ length: 8 }, (_, index) =>
        apifyItem(`initial-reject-${index}`, {
          title: "Sony WH-1000XM4 replacement case",
          soldPrice: "20",
        }),
      ),
    ];
    const expanded = [
      apifyItem("initial-a", { endedAt: "2026-07-20T12:00:00.000Z" }),
      apifyItem("best-newest", { endedAt: "2026-07-19T12:00:00.000Z" }),
      apifyItem("best-second", { endedAt: "2026-07-18T12:00:00.000Z" }),
      apifyItem("tie-a", { endedAt: "2026-07-17T12:00:00.000Z" }),
      apifyItem("tie-b", { endedAt: "2026-07-17T12:00:00.000Z" }),
      apifyItem("best-fifth", { endedAt: "2026-07-16T12:00:00.000Z" }),
      apifyItem("lower-score-newer", {
        condition: "Like new",
        endedAt: "2026-07-20T12:00:00.000Z",
      }),
      ...Array.from({ length: 13 }, (_, index) =>
        apifyItem(`expanded-reject-${index}`, {
          title: "Sony WH-1000XM4 replacement case",
          soldPrice: "20",
        }),
      ),
    ];
    const requests: Parameters<RunApifySoldActor>[0][] = [];
    const runActor = vi.fn<RunApifySoldActor>(async (request) => {
      requests.push(request);
      return {
        status: "SUCCEEDED",
        items: request.maxItems === 10 ? initial : expanded,
      };
    });
    const fetchPage = vi.fn(async () => PUBLIC_SOLD_HTML);
    const price = createDefaultPricer({
      apifySold: { enabled: true, token: "secret", runActor },
      ebaySold: { fetchPage },
    });

    const first = await price(SIGNAL);
    const retry = await price(SIGNAL);
    const redelivery = await price(SIGNAL);

    expect(requests.map(({ maxItems }) => maxItems)).toEqual([10, 20]);
    expect(first.evidence?.map(({ sourceUrl }) => sourceUrl)).toEqual([
      "https://www.ebay.com/itm/initial-a",
      "https://www.ebay.com/itm/best-newest",
      "https://www.ebay.com/itm/best-second",
      "https://www.ebay.com/itm/tie-a",
      "https://www.ebay.com/itm/tie-b",
    ]);
    expect(first.sources.map(({ url }) => url)).toEqual(
      first.evidence?.map(({ sourceUrl }) => sourceUrl),
    );
    expect(retry.evidence).toEqual(first.evidence);
    expect(redelivery.evidence).toEqual(first.evidence);
    expect(runActor).toHaveBeenCalledTimes(2);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("returns an explicit empty verified-match collection when sold evidence stays sparse", async () => {
    const requests: Parameters<RunApifySoldActor>[0][] = [];
    const runActor = vi.fn<RunApifySoldActor>(async (request) => {
      requests.push(request);
      return { status: "SUCCEEDED", items: [] };
    });
    const emptySearchClient = { search: vi.fn(async () => []) };
    const price = createDefaultPricer({
      apifySold: { enabled: true, token: "secret", runActor },
      ebaySold: { fetchPage: async () => '<ul class="srp-results"></ul>' },
      webSearch: { searchClient: emptySearchClient },
      depreciation: { searchClient: emptySearchClient },
      llmOnly: {
        estimatePrice: async () => ({ suggested: 100, min: 50, max: 150 }),
      },
    });

    const result = await price(SIGNAL);

    expect(requests.map(({ maxItems }) => maxItems)).toEqual([10, 20]);
    expect(result.tier).toBe("llm-only");
    expect(result.evidence).toEqual([]);
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
    const requests: Parameters<RunApifySoldActor>[0][] = [];
    const runActor = vi.fn<RunApifySoldActor>(async (request) => {
      requests.push(request);
      return { status: "SUCCEEDED", items: apifyItems() };
    });
    const fetchPage = vi.fn(async () => PUBLIC_SOLD_HTML);
    const price = createDefaultPricer({
      apifySold: { enabled: true, token: "secret", runActor },
      ebaySold: { fetchPage },
    });

    const result = await price(SIGNAL);

    expect(result.tier).toBe("ebay-sold");
    expect(result.suggested).toBe(180);
    expect(requests.map(({ maxItems }) => maxItems)).toEqual([10]);
    expect(runActor).toHaveBeenCalledTimes(1);
    expect(fetchPage).not.toHaveBeenCalled();
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
    const redelivery = await price(SIGNAL);

    expect(result.tier).toBe("ebay-sold");
    expect(redelivery).toEqual(result);
    expect(result.suggested).toBe(190);
    expect(runActor).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("falls through when Actor retrieval has fewer than two matcher-approved anchors", async () => {
    const requests: Parameters<RunApifySoldActor>[0][] = [];
    const runActor = vi.fn<RunApifySoldActor>(async (request) => {
      requests.push(request);
      return {
        status: "SUCCEEDED",
        items: [
          apifyItems()[0],
          {
            ...apifyItems()[1],
            title: "Sony WH-1000XM4 replacement case",
            soldPrice: "20",
          },
        ],
      };
    });
    const fetchPage = vi.fn(async () => PUBLIC_SOLD_HTML);
    const price = createDefaultPricer({
      apifySold: { enabled: true, token: "secret", runActor },
      ebaySold: { fetchPage },
    });

    const result = await price(SIGNAL);

    expect(result.tier).toBe("ebay-sold");
    expect(result.suggested).toBe(190);
    expect(requests.map(({ maxItems }) => maxItems)).toEqual([10, 20]);
    expect(runActor).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
