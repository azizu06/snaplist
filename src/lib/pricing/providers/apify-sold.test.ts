import { describe, expect, it, vi } from "vitest";
import { createInMemoryTtlCache, type TtlCache } from "../comp-cache";
import { priceResultSchema, type ItemSignal } from "../types";

const apifySdk = vi.hoisted(() => ({
  clients: [] as Array<Record<string, unknown>>,
  actorIds: [] as string[],
  call: vi.fn(),
  datasetIds: [] as string[],
  listItems: vi.fn(),
}));

vi.mock("apify-client", () => ({
  ApifyClient: class {
    constructor(options: Record<string, unknown>) {
      apifySdk.clients.push(options);
    }

    actor(actorId: string) {
      apifySdk.actorIds.push(actorId);
      return { call: apifySdk.call };
    }

    dataset(datasetId: string) {
      apifySdk.datasetIds.push(datasetId);
      return { listItems: apifySdk.listItems };
    }
  },
}));

import {
  APIFY_SOLD_ACTOR_BUILD_DEFAULT,
  APIFY_SOLD_ACTOR_ID,
  APIFY_SOLD_ACTOR_TIMEOUT_SECS_DEFAULT,
  APIFY_SOLD_DAYS_TO_SCRAPE_DEFAULT,
  APIFY_SOLD_INITIAL_RESULTS,
  APIFY_SOLD_MAX_RESULTS_DEFAULT,
  APIFY_SOLD_MAX_TOTAL_CHARGE_USD_DEFAULT,
  APIFY_SOLD_REQUEST_RETRIES_DEFAULT,
  APIFY_SOLD_WAIT_SECS_DEFAULT,
  apifySoldConfigured,
  createApifySoldPricingProvider,
  createDefaultApifySoldActorRunner,
  normalizeApifySoldItems,
  type ApifySoldComp,
  type ApifySoldRunRequest,
  type RunApifySoldActor,
} from "./apify-sold";

const SIGNAL: ItemSignal = {
  brand: "Sony",
  model: "WH-1000XM4",
  category: "electronics",
  condition: "good",
  conditionKnown: true,
};

function rawItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    itemId: "synthetic-1",
    url: "https://www.ebay.com/itm/synthetic-1",
    title: "Sony WH-1000XM4 Wireless Headphones",
    condition: "Pre-Owned",
    conditionId: 3000,
    endedAt: "2026-07-10T12:00:00.000Z",
    soldPrice: "180.00",
    soldCurrency: "USD",
    listingType: "buy_it_now",
    isBestOfferAccepted: false,
    sellerUsername: "must-not-survive-normalization",
    thumbnailUrl: "https://images.example/private.jpg",
    ...overrides,
  };
}

function successfulRun(items: readonly Record<string, unknown>[]): RunApifySoldActor {
  return vi.fn(async () => ({ status: "SUCCEEDED", items }));
}

function sharedTestCache<T>(
  ttlMs = 60_000,
  now: () => number = Date.now,
): TtlCache<T> {
  return createInMemoryTtlCache<T>(ttlMs, now, "shared");
}

describe("Apify sold-comp configuration", () => {
  it("is default-off and requires both an explicit opt-in and a token", () => {
    expect(apifySoldConfigured({})).toBe(false);
    expect(apifySoldConfigured({ APIFY_SOLD_ENABLED: "true" })).toBe(false);
    expect(apifySoldConfigured({ APIFY_TOKEN: "secret" })).toBe(false);
    expect(
      apifySoldConfigured({ APIFY_SOLD_ENABLED: "true", APIFY_TOKEN: "secret" }),
    ).toBe(true);
    expect(
      apifySoldConfigured({ APIFY_SOLD_ENABLED: "off", APIFY_TOKEN: "secret" }),
    ).toBe(false);
  });

  it("uses zero launch retries and only retries the idempotent dataset read", async () => {
    apifySdk.clients.length = 0;
    apifySdk.actorIds.length = 0;
    apifySdk.datasetIds.length = 0;
    apifySdk.call.mockReset().mockResolvedValue({
      status: "SUCCEEDED",
      defaultDatasetId: "dataset-fixture",
    });
    apifySdk.listItems.mockReset().mockResolvedValue({ items: [rawItem()] });
    const runner = createDefaultApifySoldActorRunner("test-only-token");
    const request: ApifySoldRunRequest = {
      actorId: APIFY_SOLD_ACTOR_ID,
      build: APIFY_SOLD_ACTOR_BUILD_DEFAULT,
      input: {
        keywords: ["Sony WH-1000XM4"],
        count: APIFY_SOLD_MAX_RESULTS_DEFAULT,
        daysToScrape: APIFY_SOLD_DAYS_TO_SCRAPE_DEFAULT,
        ebaySite: "ebay.com",
        sortOrder: "endedRecently",
        itemLocation: "default",
        itemCondition: "any",
        includeCompletedListings: true,
      },
      maxItems: APIFY_SOLD_MAX_RESULTS_DEFAULT,
      maxTotalChargeUsd: APIFY_SOLD_MAX_TOTAL_CHARGE_USD_DEFAULT,
      timeoutSecs: APIFY_SOLD_ACTOR_TIMEOUT_SECS_DEFAULT,
      waitSecs: APIFY_SOLD_WAIT_SECS_DEFAULT,
      requestRetries: APIFY_SOLD_REQUEST_RETRIES_DEFAULT,
      restartOnError: false,
    };

    const result = await runner(request);

    expect(result).toMatchObject({ status: "SUCCEEDED", items: [rawItem()] });
    expect(apifySdk.clients).toHaveLength(2);
    expect(apifySdk.clients[0]).toMatchObject({ maxRetries: 0 });
    expect(apifySdk.clients[1]).toMatchObject({
      maxRetries: APIFY_SOLD_REQUEST_RETRIES_DEFAULT,
    });
    expect(apifySdk.actorIds).toEqual([APIFY_SOLD_ACTOR_ID]);
    expect(apifySdk.datasetIds).toEqual(["dataset-fixture"]);
    expect(apifySdk.call).toHaveBeenCalledWith(
      request.input,
      expect.objectContaining({
        build: APIFY_SOLD_ACTOR_BUILD_DEFAULT,
        restartOnError: false,
        maxItems: APIFY_SOLD_MAX_RESULTS_DEFAULT,
        maxTotalChargeUsd: APIFY_SOLD_MAX_TOTAL_CHARGE_USD_DEFAULT,
      }),
    );
    expect(apifySdk.listItems).toHaveBeenCalledWith({
      limit: APIFY_SOLD_MAX_RESULTS_DEFAULT,
    });
  });
});

describe("normalizeApifySoldItems", () => {
  it("normalizes only provider-neutral pricing fields and drops seller/image identity", () => {
    const [comp] = normalizeApifySoldItems([rawItem()]);

    expect(comp).toEqual({
      url: "https://www.ebay.com/itm/synthetic-1",
      title: "Sony WH-1000XM4 Wireless Headphones",
      price: 180,
      condition: "Pre-Owned",
      soldAt: Date.parse("2026-07-10T12:00:00.000Z"),
      isBestOfferAccepted: false,
      priceDisclosure: "displayed-sold-price",
    });
    expect(comp).not.toHaveProperty("itemId");
    expect(comp).not.toHaveProperty("sellerUsername");
    expect(comp).not.toHaveProperty("thumbnailUrl");
  });

  it("uses conditionId only as a fallback when the Actor omits condition text", () => {
    const conditions = normalizeApifySoldItems([
      rawItem({ itemId: "n", url: "https://www.ebay.com/itm/n", condition: null, conditionId: 1000 }),
      rawItem({ itemId: "o", url: "https://www.ebay.com/itm/o", condition: null, conditionId: 1500 }),
      rawItem({ itemId: "l", url: "https://www.ebay.com/itm/l", condition: null, conditionId: 2750 }),
      rawItem({ itemId: "r", url: "https://www.ebay.com/itm/r", condition: null, conditionId: 2030 }),
      rawItem({ itemId: "u", url: "https://www.ebay.com/itm/u", condition: null, conditionId: 3000 }),
      rawItem({ itemId: "x", url: "https://www.ebay.com/itm/x", condition: null, conditionId: 2990 }),
      rawItem({ itemId: "f", url: "https://www.ebay.com/itm/f", condition: null, conditionId: 3010 }),
      rawItem({ itemId: "p", url: "https://www.ebay.com/itm/p", condition: null, conditionId: 7000 }),
    ]).map((comp) => comp.condition);

    expect(conditions).toEqual([
      "New",
      "Open box",
      "Like new",
      "Refurbished",
      "Used",
      "Pre-owned - Excellent",
      "Pre-owned - Fair",
      "For parts or not working",
    ]);
  });

  it("rejects non-USD, invalid prices, unsafe URLs, malformed rows, and duplicate listings", () => {
    const comps = normalizeApifySoldItems([
      rawItem(),
      rawItem({ itemId: "duplicate", url: "https://www.ebay.com/itm/synthetic-1" }),
      rawItem({ itemId: "eur", url: "https://www.ebay.com/itm/eur", soldCurrency: "EUR" }),
      rawItem({ itemId: "zero", url: "https://www.ebay.com/itm/zero", soldPrice: 0 }),
      rawItem({ itemId: "evil", url: "https://evil.example/itm/evil" }),
      rawItem({ itemId: "not-item", url: "https://www.ebay.com/help" }),
      rawItem({ itemId: "missing", url: null }),
    ]);

    expect(comps).toHaveLength(1);
    expect(comps[0].url).toBe("https://www.ebay.com/itm/synthetic-1");
  });

  it("retains Best Offer disclosure so the provider-neutral matcher rejects its asking price", () => {
    const [comp] = normalizeApifySoldItems([
      rawItem({ listingType: "best_offer_accepted", isBestOfferAccepted: true }),
    ]);

    expect(comp.isBestOfferAccepted).toBe(true);
    expect(comp.priceDisclosure).toBe("asking-price-not-accepted-amount");
  });

  it("caps normalized output before untrusted Actor rows can grow downstream work", () => {
    const rows = Array.from({ length: APIFY_SOLD_MAX_RESULTS_DEFAULT + 5 }, (_unused, index) =>
      rawItem({ itemId: String(index), url: `https://www.ebay.com/itm/synthetic-${index}` }),
    );
    expect(normalizeApifySoldItems(rows)).toHaveLength(APIFY_SOLD_MAX_RESULTS_DEFAULT);
  });
});

describe("createApifySoldPricingProvider", () => {
  it("runs the pinned Actor with bounded read retries, timeout, result count, and charge cap", async () => {
    const requests: ApifySoldRunRequest[] = [];
    const runActor: RunApifySoldActor = async (request) => {
      requests.push(request);
      return {
        status: "SUCCEEDED",
        items: [
          rawItem({ itemId: "a", url: "https://www.ebay.com/itm/a", soldPrice: "175" }),
          rawItem({ itemId: "b", url: "https://www.ebay.com/itm/b", soldPrice: "185" }),
          rawItem({ itemId: "c", url: "https://www.ebay.com/itm/c", soldPrice: "180" }),
        ],
      };
    };
    const provider = createApifySoldPricingProvider({
      enabled: true,
      token: "secret",
      runActor,
      cache: sharedTestCache(),
      now: () => Date.parse("2026-07-16T12:00:00.000Z"),
    });

    const result = await provider.price(SIGNAL);

    expect(priceResultSchema.safeParse(result).success).toBe(true);
    expect(result?.tier).toBe("ebay-sold");
    expect(result?.suggested).toBe(180);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      actorId: APIFY_SOLD_ACTOR_ID,
      build: APIFY_SOLD_ACTOR_BUILD_DEFAULT,
      maxItems: APIFY_SOLD_INITIAL_RESULTS,
      requestRetries: APIFY_SOLD_REQUEST_RETRIES_DEFAULT,
      restartOnError: false,
      timeoutSecs: APIFY_SOLD_ACTOR_TIMEOUT_SECS_DEFAULT,
      waitSecs: APIFY_SOLD_WAIT_SECS_DEFAULT,
      maxTotalChargeUsd: APIFY_SOLD_MAX_TOTAL_CHARGE_USD_DEFAULT,
    });
    expect(requests[0].input).toMatchObject({
      keywords: ["Sony WH-1000XM4"],
      count: APIFY_SOLD_INITIAL_RESULTS,
      daysToScrape: APIFY_SOLD_DAYS_TO_SCRAPE_DEFAULT,
      includeCompletedListings: true,
      itemCondition: "any",
    });
  });

  it("feeds Actor rows through the merged matcher and declines with fewer than two anchors", async () => {
    const provider = createApifySoldPricingProvider({
      enabled: true,
      token: "secret",
      cache: sharedTestCache(),
      runActor: successfulRun([
        rawItem({ itemId: "valid", url: "https://www.ebay.com/itm/valid" }),
        rawItem({
          itemId: "case",
          url: "https://www.ebay.com/itm/case",
          title: "Sony WH-1000XM4 replacement case",
          soldPrice: "20",
        }),
        rawItem({
          itemId: "offer",
          url: "https://www.ebay.com/itm/offer",
          listingType: "best_offer_accepted",
          isBestOfferAccepted: true,
        }),
      ]),
    });

    await expect(provider.price(SIGNAL)).resolves.toBeNull();
  });

  it("rejects hostile cached rows without starting the Actor", async () => {
    const runActor = successfulRun([]);
    const cache: TtlCache<ApifySoldComp[]> = {
      scope: "shared",
      get: async () => [
        {
          url: "https://evil.example/itm/poisoned-a",
          title: "Sony WH-1000XM4 Wireless Headphones",
          price: 170,
        },
        {
          url: "https://www.ebay.com/help/poisoned-b",
          title: "Sony WH-1000XM4 Wireless Headphones",
          price: 190,
        },
        {
          url: "/itm/poisoned-c",
          title: "Sony WH-1000XM4 Wireless Headphones",
          price: 175,
        },
        {
          url: "itm/poisoned-d",
          title: "Sony WH-1000XM4 Wireless Headphones",
          price: 185,
        },
      ],
      set: async () => undefined,
      claim: async () => true,
    };
    const provider = createApifySoldPricingProvider({
      enabled: true,
      token: "secret",
      runActor,
      cache,
    });

    await expect(provider.price(SIGNAL)).resolves.toBeNull();
    expect(runActor).not.toHaveBeenCalled();
  });

  it("normalizes canonical cached rows without starting the Actor", async () => {
    const runActor = successfulRun([]);
    const cache: TtlCache<ApifySoldComp[]> = {
      scope: "shared",
      get: async () => [
        {
          url: "https://www.ebay.com/itm/cache-a?hash=item-a#fragment",
          title: "Sony WH-1000XM4 Wireless Headphones",
          price: 170,
        },
        {
          url: "https://www.ebay.com/itm/cache-b?hash=item-b#fragment",
          title: "Sony WH-1000XM4 Wireless Headphones",
          price: 190,
        },
      ],
      set: async () => undefined,
      claim: async () => true,
    };
    const provider = createApifySoldPricingProvider({
      enabled: true,
      token: "secret",
      runActor,
      cache,
    });

    const result = await provider.price(SIGNAL);

    expect(result?.sources.map(({ url }) => url)).toEqual([
      "https://www.ebay.com/itm/cache-a",
      "https://www.ebay.com/itm/cache-b",
    ]);
    expect(runActor).not.toHaveBeenCalled();
  });

  it("caches successful empty and usable responses so repeat pricing does not start another paid run", async () => {
    const cache = sharedTestCache<ApifySoldComp[]>();
    const emptyRun = successfulRun([]);
    const emptyProvider = createApifySoldPricingProvider({
      enabled: true,
      token: "secret",
      runActor: emptyRun,
      cache,
    });
    await expect(emptyProvider.price(SIGNAL)).resolves.toBeNull();
    await expect(emptyProvider.price(SIGNAL)).resolves.toBeNull();
    expect(emptyRun).toHaveBeenCalledTimes(2);

    const usableRun = successfulRun([
      rawItem({ itemId: "a", url: "https://www.ebay.com/itm/a", soldPrice: "170" }),
      rawItem({ itemId: "b", url: "https://www.ebay.com/itm/b", soldPrice: "190" }),
      rawItem({ itemId: "c", url: "https://www.ebay.com/itm/c", soldPrice: "180" }),
    ]);
    const usableProvider = createApifySoldPricingProvider({
      enabled: true,
      token: "secret",
      runActor: usableRun,
      cache: sharedTestCache<ApifySoldComp[]>(),
    });
    await usableProvider.price(SIGNAL);
    await usableProvider.price(SIGNAL);
    expect(usableRun).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent cache misses into one bounded two-request pricing pass", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runActor = vi.fn(async () => {
      await gate;
      return {
        status: "SUCCEEDED" as const,
        items: [
          rawItem({ itemId: "a", url: "https://www.ebay.com/itm/a", soldPrice: "170" }),
          rawItem({ itemId: "b", url: "https://www.ebay.com/itm/b", soldPrice: "190" }),
        ],
      };
    });
    const provider = createApifySoldPricingProvider({
      enabled: true,
      token: "secret",
      runActor,
      cache: sharedTestCache<ApifySoldComp[]>(),
    });

    const first = provider.price(SIGNAL);
    const second = provider.price(SIGNAL);
    release();
    await Promise.all([first, second]);

    expect(runActor).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent misses across provider instances into one bounded pricing pass", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runActor = vi.fn(async () => {
      await gate;
      return {
        status: "SUCCEEDED" as const,
        items: [
          rawItem({ itemId: "a", url: "https://www.ebay.com/itm/a", soldPrice: "170" }),
          rawItem({ itemId: "b", url: "https://www.ebay.com/itm/b", soldPrice: "190" }),
        ],
      };
    });
    const cache = sharedTestCache<ApifySoldComp[]>();
    const firstProvider = createApifySoldPricingProvider({
      enabled: true,
      token: "secret",
      runActor,
      cache,
    });
    const secondProvider = createApifySoldPricingProvider({
      enabled: true,
      token: "secret",
      runActor,
      cache,
    });

    const first = firstProvider.price(SIGNAL);
    const second = secondProvider.price(SIGNAL);
    release();
    await Promise.all([first, second]);

    expect(runActor).toHaveBeenCalledTimes(2);
  });

  it("reapplies staleness on cached rows instead of treating the cache as authority", async () => {
    let now = Date.parse("2026-07-16T12:00:00.000Z");
    const runActor = successfulRun([
      rawItem({ itemId: "a", url: "https://www.ebay.com/itm/a", soldPrice: "170" }),
      rawItem({ itemId: "b", url: "https://www.ebay.com/itm/b", soldPrice: "190" }),
    ]);
    const provider = createApifySoldPricingProvider({
      enabled: true,
      token: "secret",
      runActor,
      cache: sharedTestCache<ApifySoldComp[]>(365 * 86_400_000, () => now),
      now: () => now,
      staleDays: 10,
    });

    await expect(provider.price(SIGNAL)).resolves.not.toBeNull();
    now = Date.parse("2026-08-01T12:00:00.000Z");
    await expect(provider.price(SIGNAL)).resolves.toBeNull();
    expect(runActor).toHaveBeenCalledTimes(2);
  });

  it("bounds failures, opens a circuit, and falls through without leaking raw error text", async () => {
    let now = 1_000;
    const runActor = vi.fn(async () => {
      throw new Error("Bearer private-token https://api.apify.com/private");
    });
    const diagnostics: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const provider = createApifySoldPricingProvider({
      enabled: true,
      token: "secret",
      runActor,
      cache: sharedTestCache<ApifySoldComp[]>(60_000, () => now),
      now: () => now,
      circuitFailureThreshold: 2,
      circuitCooldownMs: 5_000,
      emitDiagnostic: (event, fields) => diagnostics.push({ event, fields }),
    });

    await expect(provider.price(SIGNAL)).resolves.toBeNull();
    await expect(
      provider.price({ ...SIGNAL, model: "WH-1000XM5" }),
    ).resolves.toBeNull();
    await expect(
      provider.price({ ...SIGNAL, model: "WH-1000XM3" }),
    ).resolves.toBeNull();
    expect(runActor).toHaveBeenCalledTimes(2);
    expect(diagnostics.some(({ event }) => event === "pricing.apify_sold.circuit_open")).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain("private-token");
    expect(JSON.stringify(diagnostics)).not.toContain("api.apify.com/private");

    now += 5_001;
    await expect(
      provider.price({ ...SIGNAL, model: "WH-1000XM2" }),
    ).resolves.toBeNull();
    expect(runActor).toHaveBeenCalledTimes(3);
  });

  it("shares the failure circuit across request-scoped providers using one cache", async () => {
    let now = 1_000;
    const runActor = vi.fn(async () => {
      throw new Error("actor unavailable");
    });
    const cache = sharedTestCache<ApifySoldComp[]>();
    const providerForRequest = () =>
      createApifySoldPricingProvider({
        enabled: true,
        token: "secret",
        runActor,
        cache,
        now: () => now,
        circuitFailureThreshold: 2,
        circuitCooldownMs: 5_000,
        emitDiagnostic: () => undefined,
      });

    await expect(providerForRequest().price(SIGNAL)).resolves.toBeNull();
    await expect(
      providerForRequest().price({ ...SIGNAL, model: "WH-1000XM5" }),
    ).resolves.toBeNull();
    await expect(
      providerForRequest().price({ ...SIGNAL, model: "WH-1000XM3" }),
    ).resolves.toBeNull();
    expect(runActor).toHaveBeenCalledTimes(2);

    now += 5_001;
    await expect(providerForRequest().price(SIGNAL)).resolves.toBeNull();
    expect(runActor).toHaveBeenCalledTimes(2);
  });

  it("declines before paid retrieval when the shared cost fence is unavailable", async () => {
    const runActor = successfulRun([
      rawItem({ itemId: "a", url: "https://www.ebay.com/itm/a", soldPrice: "170" }),
      rawItem({ itemId: "b", url: "https://www.ebay.com/itm/b", soldPrice: "190" }),
    ]);
    const brokenCache: TtlCache<ApifySoldComp[]> = {
      scope: "shared",
      get: async () => {
        throw new Error("redis unavailable");
      },
      set: async () => {
        throw new Error("redis unavailable");
      },
      claim: async () => {
        throw new Error("redis unavailable");
      },
    };
    const provider = createApifySoldPricingProvider({
      enabled: true,
      token: "secret",
      cache: brokenCache,
      runActor,
      emitDiagnostic: () => undefined,
    });

    await expect(provider.price(SIGNAL)).resolves.toBeNull();
    expect(runActor).not.toHaveBeenCalled();
  });
});
