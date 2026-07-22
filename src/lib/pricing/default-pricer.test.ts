import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetTtlCaches,
  createInMemoryTtlCache,
  type TtlCache,
} from "./comp-cache";
import {
  createDefaultPricer as createRawDefaultPricer,
  type CreateDefaultPricerOptions,
} from "./default-pricer";
import type {
  ApifySoldComp,
  RunApifySoldActor,
} from "./providers/apify-sold";
import type { EbaySoldComp, FetchPage } from "./providers/ebay-sold";
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

function sharedApifyCache(): TtlCache<ApifySoldComp[]> {
  return createInMemoryTtlCache<ApifySoldComp[]>(60_000, Date.now, "shared");
}

function sharedPublicSoldCache(): TtlCache<EbaySoldComp[]> {
  return createInMemoryTtlCache<EbaySoldComp[]>(60_000, Date.now, "shared");
}

/** Injected public-adapter tests keep their potentially billable path shared-fenced. */
function createDefaultPricer(options: CreateDefaultPricerOptions = {}) {
  return createRawDefaultPricer({
    ...options,
    ebaySold: {
      ...options.ebaySold,
      cache: options.ebaySold?.cache ?? sharedPublicSoldCache(),
    },
  });
}

describe("createDefaultPricer Apify composition", () => {
  beforeEach(() => {
    __resetTtlCaches();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("keeps the free default direct sold fallback without Upstash", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("EBAY_SOLD_PROXY_TEMPLATE", "");
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const html = new URL(String(input)).searchParams.has("LH_Sold")
        ? PUBLIC_SOLD_HTML
        : "";
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });
    vi.stubGlobal("fetch", fetchImpl);
    const price = createRawDefaultPricer({
      apifySold: { enabled: false },
    });

    const first = await price(SIGNAL);
    const retry = await price(SIGNAL);

    expect(first.tier).toBe("ebay-sold");
    expect(retry).toEqual(first);
    expect(
      fetchImpl.mock.calls.map(([input]) =>
        new URL(String(input)).searchParams.get("_ipg"),
      ),
    ).toEqual(["10", "20"]);
  });

  it("keeps an injected public fetch behind shared authority without Upstash", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("EBAY_SOLD_PROXY_TEMPLATE", "");
    const fetchPage = vi.fn<FetchPage>(async () => PUBLIC_SOLD_HTML);
    const emptySearchClient = { search: vi.fn(async () => []) };
    const price = createRawDefaultPricer({
      apifySold: { enabled: false },
      ebaySold: { fetchPage, emitDiagnostic: () => undefined },
      webSearch: { searchClient: emptySearchClient },
      depreciation: { searchClient: emptySearchClient },
      llmOnly: {
        estimatePrice: async () => ({ suggested: 100, min: 50, max: 150 }),
      },
    });

    const result = await price(SIGNAL);

    expect(result.tier).toBe("llm-only");
    expect(fetchPage).not.toHaveBeenCalled();
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
    const fetchPage = vi.fn<FetchPage>(async () => PUBLIC_SOLD_HTML);
    const price = createDefaultPricer({
      apifySold: {
        enabled: true,
        token: "secret",
        runActor,
        cache: sharedApifyCache(),
      },
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
      apifySold: {
        enabled: true,
        token: "secret",
        runActor,
        cache: sharedApifyCache(),
      },
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
    const fetchPage = vi.fn<FetchPage>(async () => PUBLIC_SOLD_HTML);
    const price = createDefaultPricer({
      apifySold: { enabled: false, token: "secret", runActor },
      ebaySold: { fetchPage },
    });

    const result = await price(SIGNAL);

    expect(result.tier).toBe("ebay-sold");
    expect(result.suggested).toBe(190);
    expect(runActor).not.toHaveBeenCalled();
    expect(
      fetchPage.mock.calls.map(([url]) => new URL(url).searchParams.get("_ipg")),
    ).toEqual(["10", "20"]);
  });

  it("uses Apify first when explicitly enabled and does not call the public provider on success", async () => {
    const requests: Parameters<RunApifySoldActor>[0][] = [];
    const runActor = vi.fn<RunApifySoldActor>(async (request) => {
      requests.push(request);
      return { status: "SUCCEEDED", items: apifyItems() };
    });
    const fetchPage = vi.fn<FetchPage>(async () => PUBLIC_SOLD_HTML);
    const price = createDefaultPricer({
      apifySold: {
        enabled: true,
        token: "secret",
        runActor,
        cache: sharedApifyCache(),
      },
      ebaySold: { fetchPage },
    });

    const result = await price(SIGNAL);

    expect(result.tier).toBe("ebay-sold");
    expect(result.suggested).toBe(180);
    expect(requests.map(({ maxItems }) => maxItems)).toEqual([10]);
    expect(runActor).toHaveBeenCalledTimes(1);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("does not reuse a ten-only cache entry across matcher-sensitive conditions", async () => {
    const requests: Parameters<RunApifySoldActor>[0][] = [];
    const runActor = vi.fn<RunApifySoldActor>(async (request) => {
      requests.push(request);
      return {
        status: "SUCCEEDED",
        items:
          request.maxItems === 10
            ? apifyItems()
            : [
                apifyItem("new-a", { condition: "Brand New" }),
                apifyItem("new-b", { condition: "Brand New" }),
                apifyItem("new-c", { condition: "Brand New" }),
              ],
      };
    });
    const emptySearchClient = { search: vi.fn(async () => []) };
    const price = createDefaultPricer({
      apifySold: {
        enabled: true,
        token: "secret",
        runActor,
        cache: sharedApifyCache(),
      },
      ebaySold: { fetchPage: async () => '<ul class="srp-results"></ul>' },
      webSearch: { searchClient: emptySearchClient },
      depreciation: { searchClient: emptySearchClient },
      llmOnly: {
        estimatePrice: async () => ({ suggested: 100, min: 50, max: 150 }),
      },
    });

    await price(SIGNAL);
    await price({ ...SIGNAL, condition: "new" });

    expect(requests.map(({ maxItems }) => maxItems)).toEqual([10, 10, 20]);
  });

  it("joins a same-runtime paid winner before considering public fallback", async () => {
    let releaseActor!: () => void;
    const actorGate = new Promise<void>((resolve) => {
      releaseActor = resolve;
    });
    let actorStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      actorStarted = resolve;
    });
    const runActor = vi.fn<RunApifySoldActor>(async () => {
      actorStarted();
      await actorGate;
      return { status: "SUCCEEDED", items: apifyItems() };
    });
    const fetchPage = vi.fn<FetchPage>(async () => PUBLIC_SOLD_HTML);
    const price = createDefaultPricer({
      apifySold: {
        enabled: true,
        token: "secret",
        runActor,
        cache: sharedApifyCache(),
      },
      ebaySold: { fetchPage },
    });

    const first = price(SIGNAL);
    const concurrent = price(SIGNAL);
    await started;
    releaseActor();
    const [firstResult, concurrentResult] = await Promise.all([first, concurrent]);

    expect(concurrentResult).toEqual(firstResult);
    expect(runActor).toHaveBeenCalledTimes(1);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("atomically fences concurrent fresh-runtime redelivery to one bounded paid pass", async () => {
    const values = new Map<string, ApifySoldComp[]>();
    const claims = new Set<string>();
    const cacheForRuntime = () =>
      ({
        scope: "shared",
        get: async (key: string) => values.get(key) ?? null,
        set: async (key: string, value: ApifySoldComp[]) => {
          values.set(key, value);
        },
        claim: async (key: string) => {
          if (claims.has(key)) return false;
          claims.add(key);
          return true;
        },
      }) as TtlCache<ApifySoldComp[]> & {
        claim(key: string): Promise<boolean>;
      };
    const initial = [
      apifyItem("initial-a"),
      apifyItem("initial-b"),
      ...Array.from({ length: 8 }, (_, index) =>
        apifyItem(`initial-reject-${index}`, {
          title: "Sony WH-1000XM4 replacement case",
          soldPrice: "20",
        }),
      ),
    ];
    const expanded = Array.from({ length: 5 }, (_, index) =>
      apifyItem(`expanded-${index}`, {
        endedAt: `2026-07-${String(19 - index).padStart(2, "0")}T12:00:00.000Z`,
      }),
    );
    const requests: Parameters<RunApifySoldActor>[0][] = [];
    const runActor = vi.fn<RunApifySoldActor>(async (request) => {
      requests.push(request);
      return {
        status: "SUCCEEDED",
        items: request.maxItems === 10 ? initial : expanded,
      };
    });
    const priceForRuntime = () =>
      createDefaultPricer({
        apifySold: {
          enabled: true,
          token: "secret",
          runActor,
          cache: cacheForRuntime(),
        },
        ebaySold: { fetchPage: async () => PUBLIC_SOLD_HTML },
      });

    const first = priceForRuntime()(SIGNAL);
    const concurrentRedelivery = priceForRuntime()(SIGNAL);
    await Promise.all([first, concurrentRedelivery]);
    const laterRedelivery = await priceForRuntime()(SIGNAL);

    expect(requests.map(({ maxItems }) => maxItems)).toEqual([10, 20]);
    expect(laterRedelivery.evidence).toHaveLength(5);
  });

  it("declines without a shared cost fence before starting paid retrieval", async () => {
    const runActor = vi.fn<RunApifySoldActor>(async () => {
      throw new Error("actor unavailable");
    });
    const fetchPage = vi.fn<FetchPage>(async () => PUBLIC_SOLD_HTML);
    const price = createDefaultPricer({
      apifySold: { enabled: true, token: "secret", runActor, emitDiagnostic: () => undefined },
      ebaySold: { fetchPage },
    });

    const result = await price(SIGNAL);
    const redelivery = await price(SIGNAL);

    expect(result.tier).toBe("ebay-sold");
    expect(redelivery).toEqual(result);
    expect(result.suggested).toBe(190);
    expect(runActor).not.toHaveBeenCalled();
    expect(
      fetchPage.mock.calls.map(([url]) => new URL(url).searchParams.get("_ipg")),
    ).toEqual(["10", "20"]);
  });

  it("does not expand or repeat a terminal initial failure behind the shared fence", async () => {
    const runActor = vi.fn<RunApifySoldActor>(async () => {
      throw new Error("actor unavailable");
    });
    const fetchPage = vi.fn<FetchPage>(async () => PUBLIC_SOLD_HTML);
    const price = createDefaultPricer({
      apifySold: {
        enabled: true,
        token: "secret",
        runActor,
        cache: sharedApifyCache(),
        emitDiagnostic: () => undefined,
      },
      ebaySold: { fetchPage },
    });

    const result = await price(SIGNAL);
    const redelivery = await price(SIGNAL);

    expect(result.tier).toBe("ebay-sold");
    expect(redelivery).toEqual(result);
    expect(runActor).toHaveBeenCalledTimes(1);
    expect(
      fetchPage.mock.calls.map(([url]) => new URL(url).searchParams.get("_ipg")),
    ).toEqual(["10", "20"]);
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
    const fetchPage = vi.fn<FetchPage>(async () => PUBLIC_SOLD_HTML);
    const price = createDefaultPricer({
      apifySold: {
        enabled: true,
        token: "secret",
        runActor,
        cache: sharedApifyCache(),
      },
      ebaySold: { fetchPage },
    });

    const result = await price(SIGNAL);

    expect(result.tier).toBe("ebay-sold");
    expect(result.suggested).toBe(190);
    expect(requests.map(({ maxItems }) => maxItems)).toEqual([10, 20]);
    expect(runActor).toHaveBeenCalledTimes(2);
    expect(
      fetchPage.mock.calls.map(([url]) => new URL(url).searchParams.get("_ipg")),
    ).toEqual(["10", "20"]);
  });
});
