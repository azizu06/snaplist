import { describe, expect, it, vi } from "vitest";
import {
  createInMemoryTtlCache,
  type CacheClaimAuthority,
  type TtlCache,
} from "../comp-cache";
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

  it("fails soft by the pricing deadline when the initial shared-cache read never settles", async () => {
    vi.useFakeTimers();
    try {
      const runActor = successfulRun([]);
      const cache: TtlCache<ApifySoldComp[]> = {
        scope: "shared",
        get: vi.fn(() => new Promise<ApifySoldComp[] | null>(() => undefined)),
        set: async () => undefined,
        claim: async () => true,
      };
      const provider = createApifySoldPricingProvider({
        enabled: true,
        token: "secret",
        cache,
        runActor,
        timeoutSecs: 1,
        waitSecs: 1,
        emitDiagnostic: () => undefined,
      });
      let settled = false;
      const result = provider.price(SIGNAL).then((value) => {
        settled = true;
        return value;
      });

      await vi.advanceTimersByTimeAsync(2_501);

      expect(settled).toBe(true);
      await expect(result).resolves.toBeNull();
      expect(runActor).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails soft by the pricing deadline when the shared claim neither commits nor settles", async () => {
    vi.useFakeTimers();
    try {
      const runActor = successfulRun([]);
      const claim = vi.fn(
        () => new Promise<boolean>(() => undefined),
      );
      const getClaimOwner = vi.fn(async () => null);
      const cache: TtlCache<ApifySoldComp[]> = {
        scope: "shared",
        get: async () => null,
        set: async () => undefined,
        claim,
        getClaimOwner,
      };
      const provider = createApifySoldPricingProvider({
        enabled: true,
        token: "secret",
        cache,
        runActor,
        timeoutSecs: 1,
        waitSecs: 1,
        emitDiagnostic: () => undefined,
      });
      let settled = false;
      const result = provider.price(SIGNAL).then((value) => {
        settled = true;
        return value;
      });

      await vi.advanceTimersByTimeAsync(2_501);

      expect(settled).toBe(true);
      await expect(result).resolves.toBeNull();
      expect(claim).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(AbortSignal),
        expect.any(String),
      );
      expect(getClaimOwner).toHaveBeenCalled();
      expect(runActor).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles a delayed exact owner after observing the expiring previous owner", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-24T12:00:00.000Z"));
      let cached: ApifySoldComp[] | null = null;
      let cacheReads = 0;
      let currentOwner = "owner-a";
      let claimedOwner: string | null = null;
      let claimSettled = false;
      let selfObservationSeen = false;
      let authority: CacheClaimAuthority = {
        ownerToken: currentOwner,
        state: "live",
        updatedAt: Date.now(),
      };
      const events: string[] = [];
      const cache: TtlCache<ApifySoldComp[]> = {
        scope: "shared",
        get: async () => {
          cacheReads += 1;
          if (cacheReads === 2) {
            await new Promise<void>((resolve) => setTimeout(resolve, 2));
          }
          return cached;
        },
        set: async (_key, value) => {
          cached = value;
        },
        claim: (_key, _signal, ownerToken) => {
          claimedOwner = ownerToken ?? "legacy-owner";
          return new Promise<boolean>((resolve) => {
            setTimeout(() => {
              currentOwner = claimedOwner!;
              authority = {
                ownerToken: currentOwner,
                state: "live",
                updatedAt: Date.now(),
              };
              claimSettled = true;
              events.push(`claim:${currentOwner}`);
              resolve(true);
            }, 1);
          });
        },
        getClaimOwner: async () => {
          events.push(`owner:${currentOwner}`);
          return currentOwner;
        },
        getClaimAuthority: async () => {
          if (claimedOwner != null && currentOwner === claimedOwner) {
            selfObservationSeen = true;
          }
          return { ...authority };
        },
        refreshClaimAuthority: async (_key, ownerToken) => {
          if (
            currentOwner !== ownerToken ||
            authority.ownerToken !== ownerToken ||
            authority.state !== "live"
          ) {
            return false;
          }
          authority = {
            ownerToken,
            state: "live",
            updatedAt: Date.now(),
          };
          return true;
        },
        terminateClaimAuthority: async (_key, ownerToken) => {
          if (currentOwner !== ownerToken || authority.ownerToken !== ownerToken) {
            return false;
          }
          authority = {
            ownerToken,
            state: "terminal",
            updatedAt: Date.now(),
          };
          return true;
        },
      };
      const runActor = vi.fn<RunApifySoldActor>(async () => ({
        status: "SUCCEEDED",
        items: [
          rawItem({ itemId: "a", url: "https://www.ebay.com/itm/a", soldPrice: "170" }),
          rawItem({ itemId: "b", url: "https://www.ebay.com/itm/b", soldPrice: "190" }),
          rawItem({ itemId: "c", url: "https://www.ebay.com/itm/c", soldPrice: "180" }),
        ],
      }));
      const provider = createApifySoldPricingProvider({
        enabled: true,
        token: "secret",
        cache,
        runActor,
        timeoutSecs: 1,
        waitSecs: 1,
        emitDiagnostic: () => undefined,
      });

      const pending = provider.price(SIGNAL);
      await vi.advanceTimersByTimeAsync(2_501);
      const result = await pending;

      const oldOwnerObservationIndex = events.indexOf("owner:owner-a");
      const delayedClaimSettleIndex = events.findIndex((event) =>
        event.startsWith("claim:"),
      );
      expect(oldOwnerObservationIndex).toBeGreaterThanOrEqual(0);
      expect(delayedClaimSettleIndex).toBeGreaterThanOrEqual(0);
      expect(oldOwnerObservationIndex).toBeLessThan(delayedClaimSettleIndex);
      expect({
        actorCalls: runActor.mock.calls.length,
        claimSettled,
        resultIsNull: result == null,
        selfObservationSeen,
      }).toEqual({
        actorCalls: 1,
        claimSettled: true,
        resultIsNull: false,
        selfObservationSeen: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles an exact committed claim owner before bounded retrieval", async () => {
    vi.useFakeTimers();
    try {
      let claimOwner: string | null = null;
      let stored: ApifySoldComp[] | null = null;
      const suppliedOwnerTokens: Array<string | undefined> = [];
      const getClaimOwner = vi.fn(async () => claimOwner);
      const cacheForRuntime = (): TtlCache<ApifySoldComp[]> => ({
        scope: "shared",
        get: async () => stored,
        set: async (_key, value) => {
          stored = value;
        },
        claim: (_key, _signal, ownerToken) => {
          suppliedOwnerTokens.push(ownerToken);
          if (claimOwner != null) return Promise.resolve(false);
          claimOwner = ownerToken ?? "legacy-owner";
          return new Promise<boolean>(() => undefined);
        },
        getClaimOwner,
      });
      const runActor = vi.fn<RunApifySoldActor>(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        return {
          status: "SUCCEEDED",
          items: [
            rawItem({ itemId: "a", url: "https://www.ebay.com/itm/a", soldPrice: "170" }),
            rawItem({ itemId: "b", url: "https://www.ebay.com/itm/b", soldPrice: "190" }),
            rawItem({ itemId: "c", url: "https://www.ebay.com/itm/c", soldPrice: "180" }),
          ],
        };
      });
      const providerForRuntime = () =>
        createApifySoldPricingProvider({
          enabled: true,
          token: "secret",
          cache: cacheForRuntime(),
          runActor,
          timeoutSecs: 1,
          waitSecs: 1,
          emitDiagnostic: () => undefined,
        });

      let ownerSettled = false;
      let separateRuntimeSettled = false;
      const owner = providerForRuntime().price(SIGNAL).then((result) => {
        ownerSettled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(0);
      const separateRuntime = providerForRuntime().price(SIGNAL).then((result) => {
        separateRuntimeSettled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(499);

      expect(ownerSettled).toBe(true);
      expect(separateRuntimeSettled).toBe(true);
      const [ownerResult, separateRuntimeResult] = await Promise.all([
        owner,
        separateRuntime,
      ]);
      const retryResult = await providerForRuntime().price(SIGNAL);

      expect(getClaimOwner).toHaveBeenCalled();
      expect(suppliedOwnerTokens[0]).toEqual(expect.any(String));
      expect(claimOwner).toBe(suppliedOwnerTokens[0]);
      expect(runActor).toHaveBeenCalledTimes(1);
      expect(ownerResult).not.toBeNull();
      expect(separateRuntimeResult).toEqual(ownerResult);
      expect(retryResult).toEqual(ownerResult);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles an exact owner when the committed claim response rejects", async () => {
    const sharedCache = sharedTestCache<ApifySoldComp[]>();
    const cache: TtlCache<ApifySoldComp[]> = {
      ...sharedCache,
      claim: async (key, signal, ownerToken) => {
        await sharedCache.claim?.(key, signal, ownerToken);
        throw new Error("claim response rejected after remote commit");
      },
    };
    const runActor = successfulRun([
      rawItem({ itemId: "a", url: "https://www.ebay.com/itm/a", soldPrice: "170" }),
      rawItem({ itemId: "b", url: "https://www.ebay.com/itm/b", soldPrice: "190" }),
      rawItem({ itemId: "c", url: "https://www.ebay.com/itm/c", soldPrice: "180" }),
    ]);
    const providerForRuntime = () =>
      createApifySoldPricingProvider({
        enabled: true,
        token: "secret",
        cache,
        runActor,
        timeoutSecs: 1,
        waitSecs: 1,
        emitDiagnostic: () => undefined,
      });

    const ownerResult = await providerForRuntime().price(SIGNAL);
    const retryResult = await providerForRuntime().price(SIGNAL);

    expect(runActor).toHaveBeenCalledTimes(1);
    expect(ownerResult).not.toBeNull();
    expect(retryResult).toEqual(ownerResult);
  });

  it("observes an exact owner committed during the final backoff interval", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
      let claimOwner: string | null = null;
      let stored: ApifySoldComp[] | null = null;
      const cache: TtlCache<ApifySoldComp[]> = {
        scope: "shared",
        get: async () => stored,
        set: async (_key, value) => {
          stored = value;
        },
        claim: (_key, _signal, ownerToken) => {
          setTimeout(() => {
            claimOwner = ownerToken ?? "legacy-owner";
          }, 2_400);
          return new Promise<boolean>(() => undefined);
        },
        getClaimOwner: async () => claimOwner,
      };
      const runActor = successfulRun([
        rawItem({ itemId: "a", url: "https://www.ebay.com/itm/a", soldPrice: "170" }),
        rawItem({ itemId: "b", url: "https://www.ebay.com/itm/b", soldPrice: "190" }),
        rawItem({ itemId: "c", url: "https://www.ebay.com/itm/c", soldPrice: "180" }),
      ]);
      const provider = createApifySoldPricingProvider({
        enabled: true,
        token: "secret",
        cache,
        runActor,
        timeoutSecs: 1,
        waitSecs: 1,
        emitDiagnostic: () => undefined,
      });
      const startedAt = Date.now();
      let settledAt: number | null = null;
      const result = provider.price(SIGNAL).then((value) => {
        settledAt = Date.now();
        return value;
      });

      await vi.advanceTimersByTimeAsync(2_501);

      expect(settledAt).not.toBeNull();
      expect(settledAt! - startedAt).toBeLessThanOrEqual(2_500);
      expect(runActor).toHaveBeenCalledTimes(1);
      await expect(result).resolves.not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails soft by the pricing deadline when the winner-result store never settles", async () => {
    vi.useFakeTimers();
    try {
      const runActor = successfulRun([
        rawItem({ itemId: "a", url: "https://www.ebay.com/itm/a", soldPrice: "170" }),
        rawItem({ itemId: "b", url: "https://www.ebay.com/itm/b", soldPrice: "190" }),
        rawItem({ itemId: "c", url: "https://www.ebay.com/itm/c", soldPrice: "180" }),
      ]);
      const cache: TtlCache<ApifySoldComp[]> = {
        scope: "shared",
        get: async () => null,
        set: vi.fn(() => new Promise<void>(() => undefined)),
        claim: async () => true,
      };
      const provider = createApifySoldPricingProvider({
        enabled: true,
        token: "secret",
        cache,
        runActor,
        timeoutSecs: 1,
        waitSecs: 1,
        emitDiagnostic: () => undefined,
      });
      let settled = false;
      const result = provider.price(SIGNAL).then((value) => {
        settled = true;
        return value;
      });

      await vi.advanceTimersByTimeAsync(2_501);

      expect(settled).toBe(true);
      await expect(result).resolves.toBeNull();
      expect(runActor).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails soft when a rejected winner store leaves no shared result for retry", async () => {
    vi.useFakeTimers();
    try {
      let claimed = false;
      const runActor = successfulRun([
        rawItem({ itemId: "a", url: "https://www.ebay.com/itm/a", soldPrice: "170" }),
        rawItem({ itemId: "b", url: "https://www.ebay.com/itm/b", soldPrice: "190" }),
        rawItem({ itemId: "c", url: "https://www.ebay.com/itm/c", soldPrice: "180" }),
      ]);
      const cache: TtlCache<ApifySoldComp[]> = {
        scope: "shared",
        get: async () => null,
        set: async () => {
          throw new Error("winner store rejected without committing");
        },
        claim: async () => {
          if (claimed) return false;
          claimed = true;
          return true;
        },
      };
      const providerForRequest = () =>
        createApifySoldPricingProvider({
          enabled: true,
          token: "secret",
          cache,
          runActor,
          timeoutSecs: 1,
          waitSecs: 1,
          emitDiagnostic: () => undefined,
        });

      const winnerResult = providerForRequest().price(SIGNAL);
      await vi.advanceTimersByTimeAsync(2_501);
      const winner = await winnerResult;
      const retryResult = providerForRequest().price(SIGNAL);
      await vi.advanceTimersByTimeAsync(2_501);
      const retry = await retryResult;

      expect(winner).toBeNull();
      expect(retry).toEqual(winner);
      expect(runActor).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a commit-then-reject winner only after the exact shared result is observable", async () => {
    let claimed = false;
    let stored: ApifySoldComp[] | null = null;
    const runActor = successfulRun([
      rawItem({ itemId: "a", url: "https://www.ebay.com/itm/a", soldPrice: "170" }),
      rawItem({ itemId: "b", url: "https://www.ebay.com/itm/b", soldPrice: "190" }),
      rawItem({ itemId: "c", url: "https://www.ebay.com/itm/c", soldPrice: "180" }),
    ]);
    const cache: TtlCache<ApifySoldComp[]> = {
      scope: "shared",
      get: async () => stored,
      set: async (_key, value) => {
        stored = value;
        throw new Error("winner store response rejected after commit");
      },
      claim: async () => {
        if (claimed) return false;
        claimed = true;
        return true;
      },
    };
    const providerForRequest = () =>
      createApifySoldPricingProvider({
        enabled: true,
        token: "secret",
        cache,
        runActor,
        emitDiagnostic: () => undefined,
      });

    const winner = await providerForRequest().price(SIGNAL);
    const retry = await providerForRequest().price(SIGNAL);

    expect(winner).not.toBeNull();
    expect(retry).toEqual(winner);
    expect(runActor).toHaveBeenCalledTimes(1);
  });

  it("rejects a different shared result after the winner store is rejected", async () => {
    vi.useFakeTimers();
    try {
      let storeAttempted = false;
      const differentResult: ApifySoldComp[] = [
        {
          url: "https://www.ebay.com/itm/different",
          title: "Sony WH-1000XM4 Wireless Headphones",
          price: 999,
        },
      ];
      const runActor = successfulRun([
        rawItem({ itemId: "a", url: "https://www.ebay.com/itm/a", soldPrice: "170" }),
        rawItem({ itemId: "b", url: "https://www.ebay.com/itm/b", soldPrice: "190" }),
        rawItem({ itemId: "c", url: "https://www.ebay.com/itm/c", soldPrice: "180" }),
      ]);
      const cache: TtlCache<ApifySoldComp[]> = {
        scope: "shared",
        get: async () => (storeAttempted ? differentResult : null),
        set: async () => {
          storeAttempted = true;
          throw new Error("winner store rejected after the cache exposed a different value");
        },
        claim: async () => true,
      };
      const provider = createApifySoldPricingProvider({
        enabled: true,
        token: "secret",
        cache,
        runActor,
        timeoutSecs: 1,
        waitSecs: 1,
        emitDiagnostic: () => undefined,
      });

      const result = provider.price(SIGNAL);
      await vi.advanceTimersByTimeAsync(2_501);

      await expect(result).resolves.toBeNull();
      expect(runActor).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns an ambiguously settled winner only after the exact shared result is observable", async () => {
    let claimed = false;
    let stored: ApifySoldComp[] | null = null;
    const runActor = successfulRun([
      rawItem({ itemId: "a", url: "https://www.ebay.com/itm/a", soldPrice: "170" }),
      rawItem({ itemId: "b", url: "https://www.ebay.com/itm/b", soldPrice: "190" }),
      rawItem({ itemId: "c", url: "https://www.ebay.com/itm/c", soldPrice: "180" }),
    ]);
    const cache: TtlCache<ApifySoldComp[]> = {
      scope: "shared",
      get: async () => stored,
      set: (_key, value) => {
        stored = value;
        return new Promise<void>(() => undefined);
      },
      claim: async () => {
        if (claimed) return false;
        claimed = true;
        return true;
      },
    };
    const providerForRequest = () =>
      createApifySoldPricingProvider({
        enabled: true,
        token: "secret",
        cache,
        runActor,
        emitDiagnostic: () => undefined,
      });

    const winner = await providerForRequest().price(SIGNAL);
    const retry = await providerForRequest().price(SIGNAL);

    expect(winner).not.toBeNull();
    expect(retry).toEqual(winner);
    expect(runActor).toHaveBeenCalledTimes(1);
  });

  it.each([
    { commitDelayMs: 600, cacheReadDelayMs: 0 },
    { commitDelayMs: 2_400, cacheReadDelayMs: 10 },
  ])(
    "keeps observing an ambiguous winner store visible after $commitDelayMs ms with a $cacheReadDelayMs ms read",
    async ({ commitDelayMs, cacheReadDelayMs }) => {
      vi.useFakeTimers();
      try {
        let claimed = false;
        let storeAttempted = false;
        let stored: ApifySoldComp[] | null = null;
        const runActor = successfulRun([
          rawItem({ itemId: "a", url: "https://www.ebay.com/itm/a", soldPrice: "170" }),
          rawItem({ itemId: "b", url: "https://www.ebay.com/itm/b", soldPrice: "190" }),
          rawItem({ itemId: "c", url: "https://www.ebay.com/itm/c", soldPrice: "180" }),
        ]);
        const cache: TtlCache<ApifySoldComp[]> = {
          scope: "shared",
          get: () =>
            new Promise<ApifySoldComp[] | null>((resolve) => {
              setTimeout(() => resolve(stored), storeAttempted ? cacheReadDelayMs : 0);
            }),
          set: (_key, value) => {
            storeAttempted = true;
            setTimeout(() => {
              stored = value;
            }, commitDelayMs);
            return new Promise<void>(() => undefined);
          },
          claim: async () => {
            if (claimed) return false;
            claimed = true;
            return true;
          },
        };
        const providerForRequest = () =>
          createApifySoldPricingProvider({
            enabled: true,
            token: "secret",
            cache,
            runActor,
            timeoutSecs: 1,
            waitSecs: 1,
            emitDiagnostic: () => undefined,
          });

        const winnerResult = providerForRequest().price(SIGNAL);
        await vi.advanceTimersByTimeAsync(2_501);
        const winner = await winnerResult;
        const retryResult = providerForRequest().price(SIGNAL);
        await vi.advanceTimersByTimeAsync(cacheReadDelayMs);
        const retry = await retryResult;

        expect(winner).not.toBeNull();
        expect(retry).toEqual(winner);
        expect(runActor).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("recovers when exact winner observation follows one transient cache read failure", async () => {
    vi.useFakeTimers();
    try {
      let claimed = false;
      let reads = 0;
      let stored: ApifySoldComp[] | null = null;
      const runActor = successfulRun([
        rawItem({ itemId: "a", url: "https://www.ebay.com/itm/a", soldPrice: "170" }),
        rawItem({ itemId: "b", url: "https://www.ebay.com/itm/b", soldPrice: "190" }),
        rawItem({ itemId: "c", url: "https://www.ebay.com/itm/c", soldPrice: "180" }),
      ]);
      const cache: TtlCache<ApifySoldComp[]> = {
        scope: "shared",
        get: async () => {
          reads += 1;
          if (reads === 1) return null;
          if (reads === 2) throw new Error("transient cache read failure");
          return stored;
        },
        set: (_key, value) => {
          stored = value;
          return new Promise<void>(() => undefined);
        },
        claim: async () => {
          if (claimed) return false;
          claimed = true;
          return true;
        },
      };
      const providerForRequest = () =>
        createApifySoldPricingProvider({
          enabled: true,
          token: "secret",
          cache,
          runActor,
          timeoutSecs: 1,
          waitSecs: 1,
          emitDiagnostic: () => undefined,
        });

      const winnerResult = providerForRequest().price(SIGNAL);
      await vi.advanceTimersByTimeAsync(1_000);
      const winner = await winnerResult;
      const retry = await providerForRequest().price(SIGNAL);

      expect(winner).not.toBeNull();
      expect(retry).toEqual(winner);
      expect(runActor).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails soft by the pricing deadline when the losing claimant cache read never settles", async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const runActor = successfulRun([]);
      const cache: TtlCache<ApifySoldComp[]> = {
        scope: "shared",
        get: vi.fn(() => {
          reads += 1;
          return reads === 1
            ? Promise.resolve(null)
            : new Promise<ApifySoldComp[] | null>(() => undefined);
        }),
        set: async () => undefined,
        claim: async () => false,
      };
      const provider = createApifySoldPricingProvider({
        enabled: true,
        token: "secret",
        cache,
        runActor,
        timeoutSecs: 1,
        waitSecs: 1,
        emitDiagnostic: () => undefined,
      });
      let settled = false;
      const result = provider.price(SIGNAL).then((value) => {
        settled = true;
        return value;
      });

      await vi.advanceTimersByTimeAsync(2_501);

      expect(settled).toBe(true);
      await expect(result).resolves.toBeNull();
      expect(runActor).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start the optional paid expansion after the pricing deadline", async () => {
    vi.useFakeTimers();
    try {
      const runActor = vi.fn<RunApifySoldActor>(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 2_501));
        return {
          status: "SUCCEEDED",
          items: [rawItem()],
        };
      });
      const provider = createApifySoldPricingProvider({
        enabled: true,
        token: "secret",
        cache: sharedTestCache(),
        runActor,
        timeoutSecs: 1,
        waitSecs: 1,
        emitDiagnostic: () => undefined,
      });
      const result = provider.price(SIGNAL);

      await vi.advanceTimersByTimeAsync(5_002);

      await expect(result).resolves.toBeNull();
      expect(runActor).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps each staggered caller bounded by its own pricing deadline", async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const runActor = successfulRun([]);
      const cache: TtlCache<ApifySoldComp[]> = {
        scope: "shared",
        get: vi.fn(async () => {
          reads += 1;
          if (reads === 1) {
            await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
          }
          return null;
        }),
        set: async () => undefined,
        claim: vi.fn(() => new Promise<boolean>(() => undefined)),
      };
      const provider = createApifySoldPricingProvider({
        enabled: true,
        token: "secret",
        cache,
        runActor,
        timeoutSecs: 1,
        waitSecs: 1,
        emitDiagnostic: () => undefined,
      });
      let firstSettled = false;
      let secondSettled = false;
      const first = provider.price(SIGNAL).then((value) => {
        firstSettled = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const second = provider.price(SIGNAL).then((value) => {
        secondSettled = true;
        return value;
      });

      await vi.advanceTimersByTimeAsync(1_501);

      expect(firstSettled).toBe(true);
      expect(secondSettled).toBe(false);
      await expect(first).resolves.toBeNull();
      expect(runActor).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(secondSettled).toBe(true);
      await expect(second).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails soft and cleans up the shared flight when the Actor never settles", async () => {
    vi.useFakeTimers();
    try {
      const runActor = vi.fn<RunApifySoldActor>(
        () => new Promise<never>(() => undefined),
      );
      const provider = createApifySoldPricingProvider({
        enabled: true,
        token: "secret",
        cache: sharedTestCache(),
        runActor,
        timeoutSecs: 1,
        waitSecs: 1,
        emitDiagnostic: () => undefined,
      });
      let settled = false;
      const first = provider.price(SIGNAL).then((value) => {
        settled = true;
        return value;
      });

      await vi.advanceTimersByTimeAsync(2_501);

      expect(settled).toBe(true);
      await expect(first).resolves.toBeNull();
      const retry = provider.price(SIGNAL);
      await vi.advanceTimersByTimeAsync(2_501);
      await expect(retry).resolves.toBeNull();
      expect(runActor).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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
