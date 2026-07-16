import type { ApifyPricingSnapshot, BenchmarkCorpusEntry, ProviderQueryCapture } from "./types";
import {
  APIFY_ACTOR_ID,
  APIFY_MAX_KEYWORDS_PER_RUN,
  BENCHMARK_SOLD_WINDOW_DAYS,
  BENCHMARK_MAX_RESULTS_PER_QUERY,
  buildApifyRunBudget,
  normalizeApifyItems,
  pricingSnapshotFromActorMetadata,
} from "./core";

export { APIFY_ACTOR_ID } from "./core";

const APIFY_API_BASE = "https://api.apify.com/v2";
const TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);

export interface FetchApifyPricingSnapshotOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export async function fetchApifyPricingSnapshot(
  options: FetchApifyPricingSnapshotOptions = {},
): Promise<ApifyPricingSnapshot> {
  const response = await (options.fetchImpl ?? fetch)(
    `${APIFY_API_BASE}/acts/${APIFY_ACTOR_ID}`,
    { headers: { accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error("Unable to verify current Actor pricing; no paid run was started.");
  }
  const observedAt = new Date((options.now ?? Date.now)()).toISOString();
  return pricingSnapshotFromActorMetadata(await response.json(), observedAt);
}

export async function validateApifyAccess(options: {
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const token = options.token.trim();
  if (!token) {
    throw new Error("APIFY_TOKEN is required for live preflight; no paid run was started.");
  }
  const response = await (options.fetchImpl ?? fetch)(
    `${APIFY_API_BASE}/users/me`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
    },
  );
  if (!response.ok) {
    throw new Error("Live preflight could not validate Apify access; no paid run was started.");
  }
}

interface ApifyRunData {
  id?: string;
  status?: string;
  defaultDatasetId?: string;
  usageTotalUsd?: number;
}

interface ApifyRunResponse {
  data?: ApifyRunData;
}

async function jsonOrThrow(response: Response, message: string): Promise<unknown> {
  if (!response.ok) throw new Error(message);
  return response.json();
}

async function waitForTerminalRun(
  initial: ApifyRunData,
  token: string,
  fetchImpl: typeof fetch,
): Promise<ApifyRunData> {
  let run = initial;
  for (let poll = 0; poll < 4 && !TERMINAL_STATUSES.has(run.status ?? ""); poll += 1) {
    if (!run.id) break;
    const response = await fetchImpl(
      `${APIFY_API_BASE}/actor-runs/${encodeURIComponent(run.id)}?waitForFinish=30`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
      },
    );
    const body = (await jsonOrThrow(response, "Actor run status request failed")) as ApifyRunResponse;
    run = body.data ?? {};
  }
  return run;
}

function splitIntoBatches<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function allocateRunCost(
  total: number | null,
  counts: readonly number[],
): Array<number | null> {
  if (total == null) return counts.map(() => null);
  const countTotal = counts.reduce((sum, count) => sum + count, 0);
  if (countTotal === 0) {
    const equal = total / counts.length;
    return counts.map((_count, index) =>
      index === counts.length - 1
        ? total - equal * (counts.length - 1)
        : equal,
    );
  }
  let allocated = 0;
  return counts.map((count, index) => {
    if (index === counts.length - 1) return total - allocated;
    const share = total * (count / countTotal);
    allocated += share;
    return share;
  });
}

export interface RunApifyBenchmarkOptions {
  entries: readonly BenchmarkCorpusEntry[];
  token: string;
  maxApifyUsd: number;
  pricingSnapshot: ApifyPricingSnapshot;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface RunApifyBenchmarkResult {
  queries: ProviderQueryCapture[];
  actualUsdSpent: number | null;
  projectedUpperBoundUsd: number;
  totalPlatformCapsUsd: number;
}

export async function runApifyBenchmark(
  options: RunApifyBenchmarkOptions,
): Promise<RunApifyBenchmarkResult> {
  const token = options.token.trim();
  if (!token) {
    throw new Error("APIFY_TOKEN is required for the live candidate benchmark; no request was made.");
  }
  const budget = buildApifyRunBudget({
    queryCount: options.entries.length,
    maxResultsPerQuery: BENCHMARK_MAX_RESULTS_PER_QUERY,
    maxKeywordsPerRun: APIFY_MAX_KEYWORDS_PER_RUN,
    resultPriceUsd: options.pricingSnapshot.resultPriceUpperBoundUsd,
    actorStartPriceUsd: options.pricingSnapshot.actorStartPriceUsd,
    actorStartUnitsPerRun: options.pricingSnapshot.actorStartUnitsPerRun,
    hardCeilingUsd: options.maxApifyUsd,
  });
  const batches = splitIntoBatches(options.entries, APIFY_MAX_KEYWORDS_PER_RUN);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const queries: ProviderQueryCapture[] = [];
  const runCosts: Array<number | null> = [];

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    const batchBudget = budget.batches[batchIndex];
    const started = now();
    const runUrl = new URL(`${APIFY_API_BASE}/acts/${APIFY_ACTOR_ID}/runs`);
    runUrl.searchParams.set("waitForFinish", "30");
    runUrl.searchParams.set("memory", "4096");
    runUrl.searchParams.set("build", options.pricingSnapshot.actorBuildNumber);
    runUrl.searchParams.set(
      "maxTotalChargeUsd",
      batchBudget.maxTotalChargeUsd.toFixed(6),
    );
    let run: ApifyRunData = {};
    try {
      const response = await fetchImpl(runUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          keywords: batch.map((entry) => entry.query),
          count: BENCHMARK_MAX_RESULTS_PER_QUERY,
          daysToScrape: BENCHMARK_SOLD_WINDOW_DAYS,
          ebaySite: "ebay.com",
          sortOrder: "endedRecently",
          itemLocation: "default",
          itemCondition: "any",
          includeCompletedListings: true,
        }),
      });
      const body = (await jsonOrThrow(response, "Actor run request failed")) as ApifyRunResponse;
      run = await waitForTerminalRun(body.data ?? {}, token, fetchImpl);
      runCosts.push(typeof run.usageTotalUsd === "number" ? run.usageTotalUsd : null);
    } catch {
      runCosts.push(null);
      for (const entry of batch) {
        queries.push({
          provider: "caffein-apify",
          queryId: entry.id,
          status: "error",
          latencyMs: Math.max(0, now() - started),
          attempts: 1,
          retries: 0,
          creditsSpent: null,
          actualUsdSpent: null,
          bestOfferPolicy: "labeled-and-excluded",
          comps: [],
          boundedError: "actor-failed",
        });
      }
      continue;
    }

    if (run.status !== "SUCCEEDED" || !run.defaultDatasetId) {
      for (const entry of batch) {
        queries.push({
          provider: "caffein-apify",
          queryId: entry.id,
          status: "error",
          latencyMs: Math.max(0, now() - started),
          attempts: 1,
          retries: 0,
          creditsSpent: null,
          actualUsdSpent: null,
          bestOfferPolicy: "labeled-and-excluded",
          comps: [],
          boundedError: "actor-failed",
        });
      }
      continue;
    }

    let rawItems: Array<Record<string, unknown>> = [];
    let datasetFailed = false;
    try {
      const datasetUrl = new URL(
        `${APIFY_API_BASE}/datasets/${encodeURIComponent(run.defaultDatasetId)}/items`,
      );
      datasetUrl.searchParams.set("clean", "true");
      datasetUrl.searchParams.set("format", "json");
      datasetUrl.searchParams.set(
        "limit",
        String(batch.length * BENCHMARK_MAX_RESULTS_PER_QUERY),
      );
      const datasetResponse = await fetchImpl(datasetUrl, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
      });
      const parsed = await jsonOrThrow(datasetResponse, "Actor dataset request failed");
      rawItems = Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
    } catch {
      rawItems = [];
      datasetFailed = true;
    }

    if (datasetFailed) {
      const costShares = allocateRunCost(
        typeof run.usageTotalUsd === "number" ? run.usageTotalUsd : null,
        batch.map(() => 0),
      );
      for (let index = 0; index < batch.length; index += 1) {
        queries.push({
          provider: "caffein-apify",
          queryId: batch[index].id,
          status: "error",
          latencyMs: Math.max(0, now() - started),
          attempts: 1,
          retries: 0,
          creditsSpent: null,
          actualUsdSpent: costShares[index],
          bestOfferPolicy: "labeled-and-excluded",
          comps: [],
          boundedError: "actor-failed",
        });
      }
      continue;
    }

    const normalizedByEntry = batch.map((entry) =>
      normalizeApifyItems(
        entry,
        rawItems.filter((item) => item.keyword === entry.query),
      ),
    );
    const costShares = allocateRunCost(
      typeof run.usageTotalUsd === "number" ? run.usageTotalUsd : null,
      normalizedByEntry.map((items) => items.length),
    );
    for (let index = 0; index < batch.length; index += 1) {
      const comps = normalizedByEntry[index];
      queries.push({
        provider: "caffein-apify",
        queryId: batch[index].id,
        status: comps.length > 0 ? "success" : "empty",
        latencyMs: Math.max(0, now() - started),
        attempts: 1,
        retries: 0,
        creditsSpent: null,
        actualUsdSpent: costShares[index],
        bestOfferPolicy: "labeled-and-excluded",
        comps,
      });
    }
  }

  const knownRunCosts = runCosts.filter((cost): cost is number => cost != null);
  return {
    queries,
    actualUsdSpent: knownRunCosts.length === runCosts.length
      ? knownRunCosts.reduce((sum, cost) => sum + cost, 0)
      : null,
    projectedUpperBoundUsd: budget.projectedUpperBoundUsd,
    totalPlatformCapsUsd: budget.totalMaxChargeUsd,
  };
}
