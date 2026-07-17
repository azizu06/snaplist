import { describe, expect, it, vi } from "vitest";
import { SOLD_COMPS_BENCHMARK_CORPUS } from "./corpus";
import {
  APIFY_ACTOR_ID,
  fetchApifyPricingSnapshot,
  runApifyBenchmark,
  validateApifyAccess,
} from "./apify-client";

const METADATA = {
  data: {
    id: APIFY_ACTOR_ID,
    taggedBuilds: {
      latest: {
        buildId: "build-1-18-3",
        buildNumber: "1.18.3",
        finishedAt: "2026-07-07T13:31:08.410Z",
      },
    },
    pricingInfos: [
      {
        startedAt: "2026-03-11T00:00:00.000Z",
        pricingPerEvent: {
          actorChargeEvents: {
            "apify-default-dataset-item": { eventPriceUsd: 0.004 },
            "apify-actor-start": { eventPriceUsd: 0.00005 },
          },
        },
      },
      {
        startedAt: "2026-07-14T00:00:00.000Z",
        pricingPerEvent: {
          actorChargeEvents: {
            "apify-default-dataset-item": {
              eventTieredPricingUsd: {
                FREE: { tieredEventPriceUsd: 0.004 },
                GOLD: { tieredEventPriceUsd: 0.0025 },
              },
            },
            "apify-actor-start": { eventPriceUsd: 0.00005 },
          },
        },
      },
    ],
  },
};

describe("Apify live benchmark client", () => {
  it("reads the current public price and uses the highest account-tier price for the cap", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      void input;
      return Response.json(METADATA);
    });
    const snapshot = await fetchApifyPricingSnapshot({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => Date.parse("2026-07-16T00:00:00.000Z"),
    });

    expect(snapshot.resultPriceUpperBoundUsd).toBe(0.004);
    expect(snapshot.actorStartPriceUsd).toBe(0.00005);
    expect(snapshot.actorBuildNumber).toBe("1.18.3");
    expect(snapshot.pricingStartedAt).toBe("2026-07-14T00:00:00.000Z");
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("token");
  });

  it("validates token access with header auth before any paid Actor call", async () => {
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        void input;
        void init;
        return Response.json({ data: { id: "user" } });
      },
    );
    await validateApifyAccess({
      token: "apify-secret-token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://api.apify.com/v2/users/me");
    expect(String(url)).not.toContain("apify-secret-token");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer apify-secret-token",
    );
  });

  it("refuses to touch the network when the token is absent", async () => {
    const fetchImpl = vi.fn();
    await expect(
      runApifyBenchmark({
        entries: SOLD_COMPS_BENCHMARK_CORPUS.slice(0, 1),
        token: "",
        maxApifyUsd: 5,
        pricingSnapshot: {
          observedAt: "2026-07-16T00:00:00.000Z",
          actorId: APIFY_ACTOR_ID,
          actorBuildId: "build-1-18-3",
          actorBuildNumber: "1.18.3",
          actorBuildFinishedAt: "2026-07-07T13:31:08.410Z",
          pricingStartedAt: "2026-07-14T00:00:00.000Z",
          resultPriceUpperBoundUsd: 0.004,
          actorStartPriceUsd: 0.00005,
          actorStartUnitsPerRun: 4,
          source: "live-public-actor-metadata",
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/APIFY_TOKEN/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("batches at six keywords, passes per-run charge caps, and never puts the token in a URL or artifact", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let runNumber = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes(`/acts/${APIFY_ACTOR_ID}/runs`)) {
        runNumber += 1;
        return Response.json({
          data: {
            id: `run-${runNumber}`,
            status: "SUCCEEDED",
            defaultDatasetId: `dataset-${runNumber}`,
            usageTotalUsd: runNumber === 1 ? 0.12 : 0.02,
          },
        });
      }
      if (url.includes("dataset-1")) {
        const first = SOLD_COMPS_BENCHMARK_CORPUS[0];
        return Response.json([
          {
            itemId: "one",
            keyword: first.query,
            url: "https://www.ebay.com/itm/one",
            title: "Matilda Roald Dahl paperback ISBN 9780140328721",
            soldPrice: "8.00",
            soldCurrency: "USD",
            condition: "Pre-Owned",
            endedAt: "2026-07-01T00:00:00.000Z",
            isBestOfferAccepted: false,
            sellerUsername: "redact-me",
          },
        ]);
      }
      return Response.json([]);
    }) as unknown as typeof fetch;

    const result = await runApifyBenchmark({
      entries: SOLD_COMPS_BENCHMARK_CORPUS.slice(0, 7),
      token: "apify-secret-token",
      maxApifyUsd: 5,
      pricingSnapshot: {
        observedAt: "2026-07-16T00:00:00.000Z",
        actorId: APIFY_ACTOR_ID,
        actorBuildId: "build-1-18-3",
        actorBuildNumber: "1.18.3",
        actorBuildFinishedAt: "2026-07-07T13:31:08.410Z",
        pricingStartedAt: "2026-07-14T00:00:00.000Z",
        resultPriceUpperBoundUsd: 0.004,
        actorStartPriceUsd: 0.00005,
        actorStartUnitsPerRun: 4,
        source: "live-public-actor-metadata",
      },
      fetchImpl,
      now: () => 1_000,
    });

    const runRequests = requests.filter((request) => request.url.includes("/runs"));
    expect(runRequests).toHaveLength(2);
    for (const request of runRequests) {
      expect(request.url).toContain("maxTotalChargeUsd=");
      expect(request.url).toContain("build=1.18.3");
      expect(request.url).not.toContain("apify-secret-token");
      expect(new Headers(request.init?.headers).get("authorization")).toBe(
        "Bearer apify-secret-token",
      );
      const body = JSON.parse(String(request.init?.body));
      expect(body.count).toBe(25);
      expect(body.daysToScrape).toBe(90);
      expect(body.includeCompletedListings).toBe(true);
    }
    expect(result.queries).toHaveLength(7);
    expect(result.actualUsdSpent).toBeCloseTo(0.14, 6);
    expect(JSON.stringify(result)).not.toContain("redact-me");
    expect(JSON.stringify(result)).not.toContain("apify-secret-token");
    expect(result.queries[0].comps[0].usableForPricing).toBe(true);
  });
});
