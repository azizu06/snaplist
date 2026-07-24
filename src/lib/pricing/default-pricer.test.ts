import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetTtlCaches,
  createInMemoryTtlCache,
  type CacheClaimAuthority,
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
import { createAuthorityCacheFixture } from "./pricing-authority-test-fixtures";
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

type AuthorityRaceEvent =
  | { type: "owner-observed"; ownerToken: string | null }
  | { type: "claim-requested"; ownerToken: string }
  | { type: "claim-aborted"; ownerToken: string }
  | { type: "claim-settled"; ownerToken: string; committed: boolean };

function createAuthorityPricerFixture(
  cache: TtlCache<ApifySoldComp[]>,
  runActor: RunApifySoldActor,
) {
  const fetchPage = vi.fn<FetchPage>(async () => PUBLIC_SOLD_HTML);
  const priceForRuntime = () =>
    createDefaultPricer({
      apifySold: {
        enabled: true,
        token: "secret",
        runActor,
        timeoutSecs: 1,
        waitSecs: 1,
        cache,
      },
      ebaySold: {
        fetchPage,
        cache: sharedPublicSoldCache(),
      },
    });
  return { fetchPage, priceForRuntime };
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

  it("waits for a shared Apify winner before public fallback across runtimes", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
      vi.stubEnv("APIFY_SOLD_CLAIM_AUTHORITY_WINDOW_MS", "1");
      const apifyCacheCalls = {
        get: 0,
        getClaimAuthority: 0,
        refreshClaimAuthority: 0,
        terminateClaimAuthority: 0,
      };
      const cacheForRuntime = <T>(
        backend: TtlCache<T>,
        onLostClaim?: () => void,
        calls?: typeof apifyCacheCalls,
      ): TtlCache<T> => ({
        scope: "shared",
        get: (key, signal) => {
          if (calls) calls.get += 1;
          return backend.get(key, signal);
        },
        set: (key, value, signal) => backend.set(key, value, signal),
        claim: async (key, signal, ownerToken) => {
          const claimed = await backend.claim?.(key, signal, ownerToken);
          if (claimed === false) onLostClaim?.();
          return claimed === true;
        },
        getClaimOwner: (key, signal) =>
          backend.getClaimOwner?.(key, signal) ?? Promise.resolve(null),
        getClaimAuthority: (key, signal) => {
          if (calls) calls.getClaimAuthority += 1;
          return backend.getClaimAuthority?.(key, signal) ?? Promise.resolve(null);
        },
        refreshClaimAuthority: (key, ownerToken, signal) => {
          if (calls) calls.refreshClaimAuthority += 1;
          return (
            backend.refreshClaimAuthority?.(key, ownerToken, signal) ??
            Promise.resolve(false)
          );
        },
        terminateClaimAuthority: (key, ownerToken, signal) => {
          if (calls) calls.terminateClaimAuthority += 1;
          return (
            backend.terminateClaimAuthority?.(key, ownerToken, signal) ??
            Promise.resolve(false)
          );
        },
      });
      const apifyBackend = sharedApifyCache();
      const publicBackend = sharedPublicSoldCache();
      let reportLostApifyClaim!: () => void;
      const lostApifyClaim = new Promise<void>((resolve) => {
        reportLostApifyClaim = resolve;
      });
      const runActor = vi.fn<RunApifySoldActor>(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 800));
        return { status: "SUCCEEDED", items: apifyItems() };
      });
      const fetchPage = vi.fn<FetchPage>(async () => PUBLIC_SOLD_HTML);
      const priceForRuntime = () =>
        createDefaultPricer({
          apifySold: {
            enabled: true,
            token: "secret",
            runActor,
            timeoutSecs: 1,
            waitSecs: 1,
            cache: cacheForRuntime(
              apifyBackend,
              reportLostApifyClaim,
              apifyCacheCalls,
            ),
          },
          ebaySold: {
            fetchPage,
            cache: cacheForRuntime(publicBackend),
          },
        });

      const winner = priceForRuntime()(SIGNAL);
      await vi.advanceTimersByTimeAsync(0);
      const loser = priceForRuntime()(SIGNAL);
      await lostApifyClaim;
      await vi.advanceTimersByTimeAsync(799);

      expect(runActor).toHaveBeenCalledTimes(1);
      expect(fetchPage).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(501);
      const [winnerResult, loserResult] = await Promise.all([winner, loser]);
      const retryResult = await priceForRuntime()(SIGNAL);

      expect(runActor).toHaveBeenCalledTimes(1);
      expect(fetchPage).not.toHaveBeenCalled();
      expect(winnerResult.evidence).toHaveLength(3);
      expect(loserResult.evidence).toEqual(winnerResult.evidence);
      expect(retryResult.evidence).toEqual(winnerResult.evidence);
      expect(apifyCacheCalls.get).toBeLessThanOrEqual(12);
      expect(apifyCacheCalls.getClaimAuthority).toBeLessThanOrEqual(8);
      expect(apifyCacheCalls.refreshClaimAuthority).toBeGreaterThan(0);
      expect(apifyCacheCalls.refreshClaimAuthority).toBeLessThanOrEqual(4);
      expect(apifyCacheCalls.terminateClaimAuthority).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps public fallback suppressed when a delayed exact Apify claim replaces an expired owner", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-24T12:00:00.000Z"));
      const backend = createInMemoryTtlCache<ApifySoldComp[]>(
        1,
        Date.now,
        "shared",
      );
      const events: AuthorityRaceEvent[] = [];
      let seededPreviousOwner = false;
      const cache: TtlCache<ApifySoldComp[]> = {
        ...backend,
        claim: async (key, signal, ownerToken) => {
          if (!seededPreviousOwner) {
            seededPreviousOwner = true;
            await backend.claim?.(key, signal, "owner-a");
          }
          const requestedOwner = ownerToken ?? "legacy-owner";
          events.push({
            type: "claim-requested",
            ownerToken: requestedOwner,
          });
          return new Promise<boolean>((resolve) => {
            setTimeout(async () => {
              const claimed =
                (await backend.claim?.(key, signal, ownerToken)) === true;
              events.push({
                type: "claim-settled",
                ownerToken: requestedOwner,
                committed: claimed,
              });
              resolve(claimed);
            }, 1);
          });
        },
        getClaimOwner: async (key, signal) => {
          const owner = (await backend.getClaimOwner?.(key, signal)) ?? null;
          events.push({ type: "owner-observed", ownerToken: owner });
          return owner;
        },
      };
      let actorStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        actorStarted = resolve;
      });
      let releaseActor!: () => void;
      const actorGate = new Promise<void>((resolve) => {
        releaseActor = resolve;
      });
      const runActor = vi.fn<RunApifySoldActor>(async () => {
        actorStarted();
        await actorGate;
        return { status: "SUCCEEDED", items: apifyItems() };
      });
      const fetchPage = vi.fn<FetchPage>(async () => PUBLIC_SOLD_HTML);
      const publicCache = sharedPublicSoldCache();
      const priceForRuntime = () =>
        createDefaultPricer({
          apifySold: {
            enabled: true,
            token: "secret",
            runActor,
            timeoutSecs: 1,
            waitSecs: 1,
            cache,
          },
          ebaySold: {
            fetchPage,
            cache: publicCache,
          },
        });

      const winner = priceForRuntime()(SIGNAL);
      await vi.advanceTimersByTimeAsync(1);
      await started;

      expect(runActor).toHaveBeenCalledTimes(1);
      expect(fetchPage).not.toHaveBeenCalled();

      releaseActor();
      await vi.advanceTimersByTimeAsync(0);
      const winnerResult = await winner;
      const retryResult = await priceForRuntime()(SIGNAL);
      const oldOwnerObservationIndex = events.findIndex(
        (event) =>
          event.type === "owner-observed" && event.ownerToken === "owner-a",
      );
      const requestedClaimOwner = events.find(
        (event) => event.type === "claim-requested",
      )?.ownerToken;
      const delayedClaimSettleIndex = events.findIndex(
        (event) =>
          event.type === "claim-settled" &&
          event.ownerToken === requestedClaimOwner &&
          event.committed,
      );

      expect(oldOwnerObservationIndex).toBeGreaterThanOrEqual(0);
      expect(requestedClaimOwner).toEqual(expect.any(String));
      expect(requestedClaimOwner).not.toBe("owner-a");
      expect(delayedClaimSettleIndex).toBeGreaterThanOrEqual(0);
      expect(oldOwnerObservationIndex).toBeLessThan(delayedClaimSettleIndex);
      expect(winnerResult.evidence).toHaveLength(3);
      expect(retryResult).toEqual(winnerResult);
      expect(runActor).toHaveBeenCalledTimes(1);
      expect(fetchPage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back promptly when an exact Apify claim commits after reconciliation expires", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-24T12:00:00.000Z"));
      const backend = createInMemoryTtlCache<ApifySoldComp[]>(
        500,
        Date.now,
        "shared",
      );
      const events: AuthorityRaceEvent[] = [];
      let cacheReads = 0;
      let seededPreviousOwner = false;
      let claimedOwner: string | null = null;
      let remoteClaimCommitted = false;
      let selfWinnerObserved = false;
      const cache: TtlCache<ApifySoldComp[]> = {
        ...backend,
        get: async (key, signal) => {
          cacheReads += 1;
          if (cacheReads === 2) {
            await new Promise<void>((resolve) => setTimeout(resolve, 2));
          }
          return backend.get(key, signal);
        },
        claim: async (key, signal, ownerToken) => {
          if (!seededPreviousOwner) {
            seededPreviousOwner = true;
            await backend.claim?.(key, signal, "owner-a");
          }
          claimedOwner = ownerToken ?? "legacy-owner";
          return new Promise<boolean>((resolve) => {
            signal?.addEventListener(
              "abort",
              () => {
                events.push({
                  type: "claim-aborted",
                  ownerToken: claimedOwner!,
                });
                setTimeout(async () => {
                  remoteClaimCommitted =
                    (await backend.claim?.(key, undefined, claimedOwner!)) === true;
                  events.push({
                    type: "claim-settled",
                    ownerToken: claimedOwner!,
                    committed: remoteClaimCommitted,
                  });
                  resolve(remoteClaimCommitted);
                }, 1);
              },
              { once: true },
            );
          });
        },
        getClaimOwner: async (key, signal) => {
          const owner = (await backend.getClaimOwner?.(key, signal)) ?? null;
          events.push({ type: "owner-observed", ownerToken: owner });
          return owner;
        },
        getClaimAuthority: async (key, signal) => {
          const authority =
            (await backend.getClaimAuthority?.(key, signal)) ?? null;
          if (authority?.ownerToken === claimedOwner) {
            selfWinnerObserved = true;
          }
          return authority;
        },
      };
      const runActor = vi.fn<RunApifySoldActor>();
      const { fetchPage, priceForRuntime } = createAuthorityPricerFixture(
        cache,
        runActor,
      );
      const price = priceForRuntime();

      let settled = false;
      const result = price(SIGNAL).then((value) => {
        settled = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(700);

      const oldOwnerObservationIndex = events.findIndex(
        (event) =>
          event.type === "owner-observed" && event.ownerToken === "owner-a",
      );
      const claimAbortIndex = events.findIndex(
        (event) =>
          event.type === "claim-aborted" && event.ownerToken === claimedOwner,
      );
      const delayedClaimCommitIndex = events.findIndex(
        (event) =>
          event.type === "claim-settled" &&
          event.ownerToken === claimedOwner &&
          event.committed,
      );
      expect(oldOwnerObservationIndex).toBeGreaterThanOrEqual(0);
      expect(claimedOwner).toEqual(expect.any(String));
      expect(claimedOwner).not.toBe("owner-a");
      expect(claimAbortIndex).toBeGreaterThanOrEqual(0);
      expect(delayedClaimCommitIndex).toBeGreaterThanOrEqual(0);
      expect(oldOwnerObservationIndex).toBeLessThan(claimAbortIndex);
      expect(claimAbortIndex).toBeLessThan(delayedClaimCommitIndex);
      expect({
        actorCalls: runActor.mock.calls.length,
        publicCalls: fetchPage.mock.calls.length,
        remoteClaimCommitted,
        selfWinnerObserved,
        settled,
      }).toEqual({
        actorCalls: 0,
        publicCalls: 2,
        remoteClaimCommitted: true,
        selfWinnerObserved: false,
        settled: true,
      });
      await expect(result).resolves.toMatchObject({ tier: "ebay-sold" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds rejected uncommitted Apify claims before public fallback", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
      const cache: TtlCache<ApifySoldComp[]> = {
        scope: "shared",
        get: async () => null,
        set: async () => undefined,
        claim: async () => {
          throw new Error("claim response rejected before commit");
        },
        getClaimOwner: async () => null,
        getClaimAuthority: async () => null,
        refreshClaimAuthority: async () => false,
        terminateClaimAuthority: async () => false,
      };
      const runActor = vi.fn<RunApifySoldActor>();
      const { fetchPage, priceForRuntime } = createAuthorityPricerFixture(
        cache,
        runActor,
      );
      const price = priceForRuntime();

      let settled = false;
      const result = price(SIGNAL).then((value) => {
        settled = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(700);

      expect(settled).toBe(true);
      await expect(result).resolves.toMatchObject({ tier: "ebay-sold" });
      expect(runActor).not.toHaveBeenCalled();
      expect(fetchPage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires refreshed exact authority before Actor work after ambiguous claim commit", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
      let claimOwner: string | null = null;
      let claimAuthority: CacheClaimAuthority | null = null;
      const refreshClaimAuthority = vi.fn(async () => false);
      const cache: TtlCache<ApifySoldComp[]> = {
        scope: "shared",
        get: async () => null,
        set: async () => undefined,
        claim: async (_key, _signal, ownerToken) => {
          claimOwner = ownerToken ?? "owner";
          claimAuthority = {
            ownerToken: claimOwner,
            state: "live",
            updatedAt: Date.now(),
          };
          throw new Error("claim committed before response rejection");
        },
        getClaimOwner: async () => claimOwner,
        getClaimAuthority: async () =>
          claimAuthority == null ? null : { ...claimAuthority },
        refreshClaimAuthority,
        terminateClaimAuthority: async () => false,
      };
      const runActor = vi.fn<RunApifySoldActor>(async () => ({
        status: "SUCCEEDED",
        items: apifyItems(),
      }));
      const { fetchPage, priceForRuntime } = createAuthorityPricerFixture(
        cache,
        runActor,
      );
      const price = priceForRuntime();

      const result = price(SIGNAL);
      await vi.advanceTimersByTimeAsync(700);

      await expect(result).resolves.toMatchObject({ tier: "ebay-sold" });
      expect(refreshClaimAuthority).toHaveBeenCalledTimes(1);
      expect(runActor).not.toHaveBeenCalled();
      expect(fetchPage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reserves the coordination allowance for terminal authority after a hung store", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
      const authority = createAuthorityCacheFixture<ApifySoldComp[]>({
        set: () => new Promise<void>(() => undefined),
        terminateDelayMs: 100,
      });
      const runActor = vi.fn<RunApifySoldActor>(async () => ({
        status: "SUCCEEDED",
        items: apifyItems(),
      }));
      const { fetchPage, priceForRuntime } = createAuthorityPricerFixture(
        authority.cache,
        runActor,
      );
      const price = priceForRuntime();

      let settled = false;
      const result = price(SIGNAL).then((value) => {
        settled = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(2_400);

      expect(settled).toBe(true);
      expect(authority.getAuthority()).toMatchObject({
        state: "terminal",
      });
      await expect(result).resolves.toMatchObject({ tier: "ebay-sold" });
      expect(runActor).toHaveBeenCalledTimes(1);
      expect(fetchPage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases terminal Apify authority before a later caller's pricing deadline", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
      const authority = createAuthorityCacheFixture<ApifySoldComp[]>({
        set: async () => {
          throw new Error("winner result was not committed");
        },
      });
      const runActor = vi.fn<RunApifySoldActor>(async () => ({
        status: "SUCCEEDED",
        items: apifyItems(),
      }));
      const { fetchPage, priceForRuntime } =
        createAuthorityPricerFixture(authority.cache, runActor);

      const terminalOwner = priceForRuntime()(SIGNAL);
      await vi.advanceTimersByTimeAsync(2_501);
      await terminalOwner;
      fetchPage.mockClear();

      let laterSettled = false;
      const later = priceForRuntime()(SIGNAL).then((result) => {
        laterSettled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(700);

      expect(runActor).toHaveBeenCalledTimes(1);
      expect(laterSettled).toBe(true);
      await expect(later).resolves.toMatchObject({
        tier: "ebay-sold",
        evidence: expect.any(Array),
      });
      expect(fetchPage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails soft promptly when shared Apify authority is malformed", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
      const cacheForRuntime = (): TtlCache<ApifySoldComp[]> => ({
        scope: "shared",
        get: async () => null,
        set: async () => undefined,
        claim: async () => false,
        getClaimOwner: async () => "owner-a",
        getClaimAuthority: async () =>
          ({
            ownerToken: "owner-a",
            state: "unknown",
            updatedAt: Date.now(),
          }) as unknown as CacheClaimAuthority,
        refreshClaimAuthority: async () => false,
        terminateClaimAuthority: async () => false,
      });
      const runActor = vi.fn<RunApifySoldActor>();
      const { fetchPage, priceForRuntime } = createAuthorityPricerFixture(
        cacheForRuntime(),
        runActor,
      );
      const price = priceForRuntime();

      let settled = false;
      const result = price(SIGNAL).then((value) => {
        settled = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(700);

      expect(settled).toBe(true);
      await expect(result).resolves.toMatchObject({ tier: "ebay-sold" });
      expect(runActor).not.toHaveBeenCalled();
      expect(fetchPage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds an unavailable Apify authority read below the pricing deadline", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
      vi.stubEnv("APIFY_SOLD_CLAIM_AUTHORITY_WINDOW_MS", "60000");
      const cache: TtlCache<ApifySoldComp[]> = {
        scope: "shared",
        get: async () => null,
        set: async () => undefined,
        claim: async () => false,
        getClaimOwner: async () => "owner-a",
        getClaimAuthority: () =>
          new Promise<CacheClaimAuthority | null>(() => undefined),
        refreshClaimAuthority: async () => false,
        terminateClaimAuthority: async () => false,
      };
      const runActor = vi.fn<RunApifySoldActor>();
      const { fetchPage, priceForRuntime } = createAuthorityPricerFixture(
        cache,
        runActor,
      );
      const price = priceForRuntime();

      let settled = false;
      const result = price(SIGNAL).then((value) => {
        settled = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(700);

      expect(settled).toBe(true);
      await expect(result).resolves.toMatchObject({ tier: "ebay-sold" });
      expect(runActor).not.toHaveBeenCalled();
      expect(fetchPage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      name: "stale",
      authority: (): CacheClaimAuthority => ({
        ownerToken: "owner-a",
        state: "live",
        updatedAt: Date.now() - 626,
      }),
    },
    {
      name: "mismatched",
      authority: (): CacheClaimAuthority => ({
        ownerToken: "owner-b",
        state: "live",
        updatedAt: Date.now(),
      }),
    },
    {
      name: "future-dated",
      authority: (): CacheClaimAuthority => ({
        ownerToken: "owner-a",
        state: "live",
        updatedAt: Date.now() + 10_000,
      }),
    },
  ])(
    "fails soft promptly when shared Apify authority is $name",
    async ({ authority }) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
        const cache: TtlCache<ApifySoldComp[]> = {
          scope: "shared",
          get: async () => null,
          set: async () => undefined,
          claim: async () => false,
          getClaimOwner: async () => "owner-a",
          getClaimAuthority: async () => authority(),
          refreshClaimAuthority: async () => false,
          terminateClaimAuthority: async () => false,
        };
        const runActor = vi.fn<RunApifySoldActor>();
        const { fetchPage, priceForRuntime } = createAuthorityPricerFixture(
          cache,
          runActor,
        );
        const price = priceForRuntime();

        let settled = false;
        const result = price(SIGNAL).then((value) => {
          settled = true;
          return value;
        });
        await vi.advanceTimersByTimeAsync(700);

        expect(settled).toBe(true);
        await expect(result).resolves.toMatchObject({ tier: "ebay-sold" });
        expect(runActor).not.toHaveBeenCalled();
        expect(fetchPage).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    },
  );

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
