import { createServer, type Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";

const endpoint = vi.hoisted(() => ({ baseUrl: "" }));

// Redirect only the external API boundary. Actor start, HTTP timeouts, polling
// and dataset parsing all execute through the actual installed Apify SDK.
vi.mock("apify-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("apify-client")>();
  return {
    ...actual,
    ApifyClient: class extends actual.ApifyClient {
      constructor(options: ConstructorParameters<typeof actual.ApifyClient>[0]) {
        super({ ...options, baseUrl: endpoint.baseUrl });
      }
    },
  };
});

import { createDefaultApifySoldActorRunner, type ApifySoldRunRequest } from "./apify-sold";

const REQUEST: ApifySoldRunRequest = {
  actorId: "offline-actor",
  build: "1.23.3",
  input: {
    keywords: ["Sony WH-1000XM4"],
    count: 10,
    daysToScrape: 90,
    ebaySite: "ebay.com",
    sortOrder: "endedRecently",
    itemLocation: "default",
    itemCondition: "any",
    includeCompletedListings: true,
  },
  maxItems: 10,
  maxTotalChargeUsd: 0.11,
  timeoutSecs: 55,
  waitSecs: 60,
  requestRetries: 2,
  restartOnError: false,
};

let server: Server | undefined;
const timers = new Set<ReturnType<typeof setTimeout>>();

afterEach(async () => {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => error ? reject(error) : resolve());
    });
    server = undefined;
  }
});

async function listen(): Promise<void> {
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server!.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  endpoint.baseUrl = `http://127.0.0.1:${address.port}`;
}

it("retrieves a healthy 31-second run through the real SDK without a second paid start", async () => {
  let starts = 0;
  let finishesAt = 0;
  const statusWaits: number[] = [];
  let startParams: URLSearchParams | undefined;
  let datasetLimit: string | null = null;
  let datasetReads = 0;
  const items = [{ title: "offline sold candidate", soldPrice: "180.00" }];
  server = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    const send = (body: unknown) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(body));
    };
    if (request.method === "POST" && url.pathname === "/v2/actors/offline-actor/runs") {
      starts += 1;
      startParams = url.searchParams;
      finishesAt = Date.now() + 31_000;
      send({ data: { id: "offline-run", status: "RUNNING" } });
    } else if (request.method === "GET" && url.pathname === "/v2/actor-runs/offline-run") {
      const waitSecs = Number(url.searchParams.get("waitForFinish"));
      statusWaits.push(waitSecs);
      const timer = setTimeout(() => {
        timers.delete(timer);
        const status = Date.now() >= finishesAt ? "SUCCEEDED" : "RUNNING";
        send({ data: {
          id: "offline-run",
          status,
          ...(status === "SUCCEEDED" ? {
            defaultDatasetId: "offline-dataset",
            usageTotalUsd: 0.04,
            exitCode: 0,
          } : {}),
        } });
      }, Math.max(0, Math.min(waitSecs * 1_000, finishesAt - Date.now())));
      timers.add(timer);
    } else if (request.method === "GET" && url.pathname === "/v2/datasets/offline-dataset/items") {
      datasetReads += 1;
      datasetLimit = url.searchParams.get("limit");
      send(items);
    } else {
      response.statusCode = 404;
      send({ error: { message: "Unexpected offline API request" } });
    }
  });
  await listen();

  const result = await createDefaultApifySoldActorRunner("offline-only-token")(REQUEST);

  expect(result).toEqual({ status: "SUCCEEDED", items, chargedTotalUsd: 0.04, exitCode: 0 });
  expect(starts).toBe(1);
  expect(startParams?.get("timeout")).toBe("55");
  expect(startParams?.get("maxTotalChargeUsd")).toBe("0.11");
  expect(startParams?.get("maxItems")).toBe("10");
  expect(startParams?.get("build")).toBe("1.23.3");
  expect(startParams?.get("restartOnError")).toBe("0");
  expect(datasetReads).toBe(1);
  expect(datasetLimit).toBe("10");
  expect(statusWaits.length).toBeGreaterThan(1);
  // Each server-side long poll must fit inside its 30-second HTTP envelope.
  expect(statusWaits.every((wait) => wait > 0 && wait <= 20)).toBe(true);
}, 45_000);

it("bounds a stalled SDK status read by the configured wait without another start", async () => {
  let starts = 0;
  let statusReads = 0;
  server = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    response.setHeader("content-type", "application/json");
    if (request.method === "POST") {
      starts += 1;
      response.end(JSON.stringify({ data: { id: "offline-run", status: "RUNNING" } }));
    } else {
      if (url.pathname === "/v2/actor-runs/offline-run") statusReads += 1;
      // Model a status endpoint that accepts a request but never responds.
    }
  });
  await listen();
  const startedAt = Date.now();

  await expect(createDefaultApifySoldActorRunner("offline-only-token")({
    ...REQUEST,
    waitSecs: 1,
  })).rejects.toThrow("status observation unavailable");

  expect(Date.now() - startedAt).toBeLessThan(2_000);
  expect(starts).toBe(1);
  expect(statusReads).toBe(1);
});

it("does not retry a failed paid-start POST through the real SDK", async () => {
  let starts = 0;
  let otherRequests = 0;
  server = createServer((request, response) => {
    if (request.method === "POST") starts += 1;
    else otherRequests += 1;
    response.statusCode = 500;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: { type: "offline-failure", message: "Start unavailable" } }));
  });
  await listen();

  await expect(createDefaultApifySoldActorRunner("offline-only-token")(REQUEST))
    .rejects.toThrow("Start unavailable");

  expect(starts).toBe(1);
  expect(otherRequests).toBe(0);
});
