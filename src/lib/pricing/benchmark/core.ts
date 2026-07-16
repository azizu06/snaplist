import { createHash } from "node:crypto";
import {
  assertSafeEbayUrl,
  buildSoldSearchUrl,
  EBAY_SOLD_FETCH_TIMEOUT_MS,
  EBAY_SOLD_USER_AGENT_DEFAULT,
  filterRelevantComps,
  parseSoldComps,
  soldFetchFailureReason,
  type EbaySoldComp,
} from "../providers/ebay-sold";
import {
  buildEbaySoldProxyRequestUrl,
  validateEbaySoldProxyTemplate,
} from "../ebay-sold-egress";
import { PRODUCT_RESEARCH_SUBSET_IDS, SOLD_COMPS_BENCHMARK_CORPUS } from "./corpus";
import type {
  ApifyPricingSnapshot,
  BenchmarkCapture,
  BenchmarkComp,
  BenchmarkCompLabel,
  BenchmarkCorpusEntry,
  BenchmarkProvider,
  ProviderQueryCapture,
  ProviderSummary,
  RedactedBenchmarkArtifact,
} from "./types";

export const APIFY_ACTOR_ID = "oTtB3VgfuE9GtxQt2";
export const APIFY_ACTOR_NAME = "caffein.dev/ebay-sold-listings";
export const APIFY_HARD_CEILING_USD = 5;
export const BENCHMARK_MAX_RESULTS_PER_QUERY = 25;
export const APIFY_MAX_KEYWORDS_PER_RUN = 6;
export const BENCHMARK_SOLD_WINDOW_DAYS = 90;

export interface BenchmarkArgs {
  mode: "dry-run" | "live";
  provider: "both" | "scrapingbee" | "apify";
  maxApifyUsd: number;
  outputDir: string;
  labelsPath?: string;
  capturePath?: string;
  productResearchPath?: string;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseBenchmarkArgs(args: string[]): BenchmarkArgs {
  const live = args.includes("--live");
  const confirmed = args.includes("--confirm-live");
  if (live !== confirmed) {
    throw new Error("Live benchmark requires both --live and --confirm-live; no request was made.");
  }

  let maxApifyUsd = APIFY_HARD_CEILING_USD;
  let provider: BenchmarkArgs["provider"] = "both";
  let outputDir = "docs/benchmarks/sold-comps/latest";
  let labelsPath: string | undefined;
  let capturePath: string | undefined;
  let productResearchPath: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--max-apify-usd") {
      maxApifyUsd = Number(requireValue(args, i, arg));
      i += 1;
    } else if (arg === "--provider") {
      const value = requireValue(args, i, arg);
      if (!(["both", "scrapingbee", "apify"] as const).includes(value as BenchmarkArgs["provider"])) {
        throw new Error("--provider must be both, scrapingbee, or apify");
      }
      provider = value as BenchmarkArgs["provider"];
      i += 1;
    } else if (arg === "--output-dir") {
      outputDir = requireValue(args, i, arg);
      i += 1;
    } else if (arg === "--labels") {
      labelsPath = requireValue(args, i, arg);
      i += 1;
    } else if (arg === "--from-capture") {
      capturePath = requireValue(args, i, arg);
      i += 1;
    } else if (arg === "--product-research") {
      productResearchPath = requireValue(args, i, arg);
      i += 1;
    }
  }
  if (!Number.isFinite(maxApifyUsd) || maxApifyUsd <= 0) {
    throw new Error("--max-apify-usd must be a positive number");
  }
  if (maxApifyUsd > APIFY_HARD_CEILING_USD) {
    throw new Error("The Issue #188 benchmark has an absolute USD $5 ceiling.");
  }
  if (capturePath && live) {
    throw new Error("--from-capture is offline scoring and cannot be combined with --live");
  }
  return {
    mode: live ? "live" : "dry-run",
    provider,
    maxApifyUsd,
    outputDir,
    ...(labelsPath ? { labelsPath } : {}),
    ...(capturePath ? { capturePath } : {}),
    ...(productResearchPath ? { productResearchPath } : {}),
  };
}

export function buildDryRunPlan(args: BenchmarkArgs) {
  return {
    mode: args.mode,
    provider: args.provider,
    queryCount: SOLD_COMPS_BENCHMARK_CORPUS.length,
    maxResultsPerQuery: BENCHMARK_MAX_RESULTS_PER_QUERY,
    apifyActorId: APIFY_ACTOR_ID,
    apifyHardCeilingUsd: args.maxApifyUsd,
    externalRequests: 0,
    productResearch: {
      status: "operator-pending" as const,
      queryIds: PRODUCT_RESEARCH_SUBSET_IDS,
    },
  };
}

export interface BuildApifyRunBudgetInput {
  queryCount: number;
  maxResultsPerQuery: number;
  maxKeywordsPerRun: number;
  resultPriceUsd: number;
  actorStartPriceUsd: number;
  actorStartUnitsPerRun: number;
  hardCeilingUsd: number;
}

export interface ApifyRunBudget {
  projectedUpperBoundUsd: number;
  totalMaxChargeUsd: number;
  batches: Array<{
    queryCount: number;
    maxResultsPerQuery: number;
    projectedUpperBoundUsd: number;
    maxTotalChargeUsd: number;
  }>;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function buildApifyRunBudget(input: BuildApifyRunBudgetInput): ApifyRunBudget {
  const runCount = Math.ceil(input.queryCount / input.maxKeywordsPerRun);
  const batches = Array.from({ length: runCount }, (_unused, index) => {
    const remaining = input.queryCount - index * input.maxKeywordsPerRun;
    const queryCount = Math.min(input.maxKeywordsPerRun, remaining);
    const projectedUpperBoundUsd =
      queryCount * input.maxResultsPerQuery * input.resultPriceUsd +
      input.actorStartPriceUsd * input.actorStartUnitsPerRun;
    // A per-run platform cap is rounded up by one micro-dollar. The sum of all
    // per-run caps is preflighted, so no sequence of runs can exceed the global cap.
    const maxTotalChargeUsd = Math.ceil(projectedUpperBoundUsd * 1_000_000) / 1_000_000;
    return {
      queryCount,
      maxResultsPerQuery: input.maxResultsPerQuery,
      projectedUpperBoundUsd: roundUsd(projectedUpperBoundUsd),
      maxTotalChargeUsd,
    };
  });
  const projectedUpperBoundUsd = roundUsd(
    batches.reduce((sum, batch) => sum + batch.projectedUpperBoundUsd, 0),
  );
  const totalMaxChargeUsd = roundUsd(
    batches.reduce((sum, batch) => sum + batch.maxTotalChargeUsd, 0),
  );
  if (totalMaxChargeUsd > input.hardCeilingUsd) {
    throw new Error(
      `Projected Apify maximum USD ${totalMaxChargeUsd.toFixed(6)} exceeds the configured USD ${input.hardCeilingUsd.toFixed(2)} cap; no Actor run was started.`,
    );
  }
  return { projectedUpperBoundUsd, totalMaxChargeUsd, batches };
}

function compId(provider: BenchmarkProvider, queryId: string, identity: string): string {
  return createHash("sha256")
    .update(`${provider}\0${queryId}\0${identity}`)
    .digest("hex")
    .slice(0, 20);
}

function toFinitePositive(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

interface ApifyItemLike {
  itemId?: unknown;
  keyword?: unknown;
  url?: unknown;
  title?: unknown;
  soldPrice?: unknown;
  soldCurrency?: unknown;
  condition?: unknown;
  endedAt?: unknown;
  listingType?: unknown;
  isBestOfferAccepted?: unknown;
  [key: string]: unknown;
}

export function normalizeApifyItems(
  entry: BenchmarkCorpusEntry,
  rawItems: readonly ApifyItemLike[],
): BenchmarkComp[] {
  const selected = rawItems.slice(0, BENCHMARK_MAX_RESULTS_PER_QUERY).flatMap((raw) => {
    const price = toFinitePositive(raw.soldPrice);
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    const currency = typeof raw.soldCurrency === "string" ? raw.soldCurrency : "";
    if (!price || !title || !currency) return [];
    const itemIdentity =
      (typeof raw.itemId === "string" && raw.itemId) ||
      (typeof raw.url === "string" && raw.url) ||
      `${title}\0${price}`;
    const bestOffer =
      raw.isBestOfferAccepted === true || raw.listingType === "best_offer_accepted";
    const normalized: BenchmarkComp = {
      id: compId("caffein-apify", entry.id, itemIdentity),
      title,
      price,
      currency,
      condition: typeof raw.condition === "string" ? raw.condition : null,
      endedAt: typeof raw.endedAt === "string" ? raw.endedAt : null,
      usableForPricing: false,
      isBestOfferAccepted: bestOffer,
      priceDisclosure: bestOffer
        ? "asking-price-not-accepted-amount"
        : "displayed-sold-price",
    };
    return [normalized];
  });

  const relevant = new Set(
    filterRelevantComps(
      selected.map<EbaySoldComp>((comp) => ({
        url: `https://www.ebay.com/itm/${comp.id}`,
        title: comp.title,
        price: comp.price,
        ...(comp.condition ? { condition: comp.condition } : {}),
        ...(comp.endedAt ? { soldAt: Date.parse(comp.endedAt) } : {}),
      })),
      entry.signal,
    ).map((comp) => comp.url.split("/").at(-1)),
  );

  return selected.map((comp) => ({
    ...comp,
    usableForPricing:
      comp.currency === "USD" &&
      !comp.isBestOfferAccepted &&
      relevant.has(comp.id),
  }));
}

function boundedExistingError(error: unknown): ProviderQueryCapture["boundedError"] {
  const reason = soldFetchFailureReason(error);
  if (reason === "timeout") return "timeout";
  if (reason.startsWith("http-")) return "http-error";
  return "request-failed";
}

export interface RunScrapingBeeQueryOptions {
  entry: BenchmarkCorpusEntry;
  proxyTemplate: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export async function runScrapingBeeQuery(
  options: RunScrapingBeeQueryOptions,
): Promise<ProviderQueryCapture> {
  const started = (options.now ?? Date.now)();
  const target = buildSoldSearchUrl(options.entry.signal);
  if (!target) {
    return {
      provider: "scrapingbee-public-page",
      queryId: options.entry.id,
      status: "error",
      latencyMs: 0,
      attempts: 0,
      retries: 0,
      creditsSpent: 0,
      actualUsdSpent: 0,
      bestOfferPolicy: "excluded-by-parser",
      comps: [],
      boundedError: "request-failed",
    };
  }
  const safeTarget = assertSafeEbayUrl(target).toString();
  const template = assertScrapingBeeProxyTemplate(options.proxyTemplate);
  const requestUrl = buildEbaySoldProxyRequestUrl(template, safeTarget);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? EBAY_SOLD_FETCH_TIMEOUT_MS,
  );
  try {
    const response = await (options.fetchImpl ?? fetch)(requestUrl, {
      headers: {
        "user-agent": EBAY_SOLD_USER_AGENT_DEFAULT,
        "accept-language": "en-US,en;q=0.9",
        accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`eBay sold fetch failed: ${response.status}`);
    const html = await response.text();
    const parsed = parseSoldComps(
      html,
      undefined,
      BENCHMARK_MAX_RESULTS_PER_QUERY,
    );
    const relevantUrls = new Set(
      filterRelevantComps(parsed, options.entry.signal).map((comp) => comp.url),
    );
    const comps = parsed.slice(0, BENCHMARK_MAX_RESULTS_PER_QUERY).map<BenchmarkComp>((comp) => ({
      id: compId("scrapingbee-public-page", options.entry.id, comp.url),
      title: comp.title ?? "",
      price: comp.price,
      currency: "USD",
      condition: comp.condition ?? null,
      endedAt: comp.soldAt != null ? new Date(comp.soldAt).toISOString() : null,
      usableForPricing: relevantUrls.has(comp.url),
      isBestOfferAccepted: false,
      priceDisclosure: "displayed-sold-price",
    }));
    const spbCost = toFinitePositive(response.headers.get("spb-cost")) ?? 0;
    return {
      provider: "scrapingbee-public-page",
      queryId: options.entry.id,
      status: comps.length > 0 ? "success" : "empty",
      latencyMs: Math.max(0, (options.now ?? Date.now)() - started),
      attempts: 1,
      retries: 0,
      creditsSpent: spbCost,
      actualUsdSpent: 0,
      bestOfferPolicy: "excluded-by-parser",
      comps,
    };
  } catch (error) {
    return {
      provider: "scrapingbee-public-page",
      queryId: options.entry.id,
      status: "blocked",
      latencyMs: Math.max(0, (options.now ?? Date.now)() - started),
      attempts: 1,
      retries: 0,
      creditsSpent: 0,
      actualUsdSpent: 0,
      bestOfferPolicy: "excluded-by-parser",
      comps: [],
      boundedError: boundedExistingError(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Validate the exact existing benchmark adapter without echoing its credential. */
export function assertScrapingBeeProxyTemplate(raw: string): string {
  const template = validateEbaySoldProxyTemplate(raw);
  let parsed: URL;
  try {
    parsed = new URL(
      template.replace("{url}", encodeURIComponent("https://www.ebay.com/")),
    );
  } catch {
    throw new Error("The benchmark ScrapingBee template is invalid; no request was made.");
  }
  if (
    parsed.hostname !== "scrapingbee.com" &&
    !parsed.hostname.endsWith(".scrapingbee.com")
  ) {
    throw new Error("Issue #188 requires the configured ScrapingBee adapter; no request was made.");
  }
  return template;
}

function sortedMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

function roundRate(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function usableCompsForQuery(
  query: ProviderQueryCapture,
  labelMap: Map<string, BenchmarkCompLabel>,
): BenchmarkComp[] {
  return query.comps.filter((comp) => {
    if (!comp.usableForPricing) return false;
    const label = labelMap.get(comp.id);
    return label
      ? label.relevant && label.variantCorrect && label.conditionCorrect
      : true;
  });
}

export function summarizeProvider(
  queries: readonly ProviderQueryCapture[],
  labels: readonly BenchmarkCompLabel[],
): ProviderSummary {
  if (queries.length === 0) throw new Error("summarizeProvider requires queries");
  const provider = queries[0].provider;
  const labelMap = new Map(labels.map((label) => [label.compId, label]));
  const compIds = new Set(queries.flatMap((query) => query.comps.map((comp) => comp.id)));
  const providerLabels = [...compIds].flatMap((id) => {
    const label = labelMap.get(id);
    return label ? [label] : [];
  });
  const successful = queries.filter((query) => query.status === "success");
  const usableByQuery = queries.map((query) => usableCompsForQuery(query, labelMap));
  const usableCompCount = usableByQuery.reduce((sum, comps) => sum + comps.length, 0);
  const usablePricingQueryCount = usableByQuery.filter((comps) => comps.length >= 2).length;
  const splitDeltas = usableByQuery.flatMap((comps) => {
    if (comps.length < 4) return [];
    const all = sortedMedian(comps.map((comp) => comp.price))!;
    const odd = sortedMedian(comps.filter((_comp, index) => index % 2 === 0).map((comp) => comp.price))!;
    const even = sortedMedian(comps.filter((_comp, index) => index % 2 === 1).map((comp) => comp.price))!;
    return [Math.abs(odd - even) / all];
  });
  const rangeRatios = usableByQuery.flatMap((comps) => {
    if (comps.length < 2) return [];
    const prices = comps.map((comp) => comp.price).sort((a, b) => a - b);
    const med = sortedMedian(prices)!;
    return [(prices.at(-1)! - prices[0]) / med];
  });
  const actualValues = queries
    .map((query) => query.actualUsdSpent)
    .filter((value): value is number => value != null);
  const actualUsdSpent = actualValues.length === queries.length
    ? roundUsd(actualValues.reduce((sum, value) => sum + value, 0))
    : null;
  const relevantCount = providerLabels.filter((label) => label.relevant).length;
  const variantBad = providerLabels.filter((label) => !label.variantCorrect).length;
  const conditionBad = providerLabels.filter((label) => !label.conditionCorrect).length;

  return {
    provider,
    queryCount: queries.length,
    successfulQueryCoverage: roundRate(successful.length / queries.length),
    emptyResultRate: roundRate(
      queries.filter((query) => query.status === "empty").length / queries.length,
    ),
    blockErrorRate: roundRate(
      queries.filter((query) => query.status === "blocked" || query.status === "error").length /
        queries.length,
    ),
    relevantPrecision: providerLabels.length
      ? roundRate(relevantCount / providerLabels.length)
      : null,
    variantContaminationRate: providerLabels.length
      ? roundRate(variantBad / providerLabels.length)
      : null,
    conditionContaminationRate: providerLabels.length
      ? roundRate(conditionBad / providerLabels.length)
      : null,
    labeledCompCount: providerLabels.length,
    usableCompCount,
    usablePricingQueryCount,
    medianUsableCompsPerSuccessfulQuery: successful.length
      ? sortedMedian(successful.map((query) => usableCompsForQuery(query, labelMap).length))
      : null,
    medianSplitStabilityDelta: splitDeltas.length
      ? roundRate(sortedMedian(splitDeltas)!)
      : null,
    medianRangeWidthRatio: rangeRatios.length
      ? roundRate(sortedMedian(rangeRatios)!)
      : null,
    latencyMs: {
      p50: percentile(queries.map((query) => query.latencyMs), 0.5),
      p95: percentile(queries.map((query) => query.latencyMs), 0.95),
    },
    retries: queries.reduce((sum, query) => sum + query.retries, 0),
    bestOfferRowsObserved: queries.reduce(
      (sum, query) => sum + query.comps.filter((comp) => comp.isBestOfferAccepted).length,
      0,
    ),
    creditsSpent: queries.reduce((sum, query) => sum + (query.creditsSpent ?? 0), 0),
    actualUsdSpent,
    costPerQueryUsd:
      actualUsdSpent == null ? null : roundUsd(actualUsdSpent / queries.length),
    costPerUsablePricingResultUsd:
      actualUsdSpent == null || usablePricingQueryCount === 0
        ? null
        : roundUsd(actualUsdSpent / usablePricingQueryCount),
  };
}

function perQueryRedacted(
  query: ProviderQueryCapture,
  labelMap: Map<string, BenchmarkCompLabel>,
): RedactedBenchmarkArtifact["perQuery"][number] {
  const usable = usableCompsForQuery(query, labelMap);
  const prices = usable.map((comp) => comp.price).sort((a, b) => a - b);
  return {
    provider: query.provider,
    queryId: query.queryId,
    status: query.status,
    compCount: query.comps.length,
    usableCompCount: usable.length,
    labeledCompCount: query.comps.filter((comp) => labelMap.has(comp.id)).length,
    median: sortedMedian(prices),
    range: prices.length ? { min: prices[0], max: prices.at(-1)! } : null,
    latencyMs: query.latencyMs,
    retries: query.retries,
    creditsSpent: query.creditsSpent,
    actualUsdSpent: query.actualUsdSpent,
  };
}

function overlapRate(
  a: { min: number; max: number },
  b: { min: number; max: number },
): number {
  const overlap = Math.max(0, Math.min(a.max, b.max) - Math.max(a.min, b.min));
  const union = Math.max(a.max, b.max) - Math.min(a.min, b.min);
  return union === 0 ? 1 : overlap / union;
}

function maintainability(): RedactedBenchmarkArtifact["maintainability"] {
  return {
    "scrapingbee-public-page": {
      schemaBurden: "Two in-repo Cheerio selector layouts plus relevance/filter fixtures; markup drift is SnapList-owned.",
      blockRetryBehavior: "One proxy-backed request/query; provider retries internally, SnapList declines on block/thin HTML.",
      lockInRisk: "Low adapter lock-in: vendor-neutral URL template and in-repo parser, with higher parser maintenance.",
    },
    "caffein-apify": {
      schemaBurden: "Structured Actor schema mapping; eBay markup maintenance is delegated to a community Actor.",
      blockRetryBehavior: "Actor run status is explicit; internal crawl retries are provider-controlled and opaque to SnapList.",
      lockInRisk: "Moderate Actor/API and pay-per-result lock-in; adapter remains replaceable and output is normalized.",
    },
  };
}

function recommendationFor(
  capture: BenchmarkCapture,
  summaries: ProviderSummary[],
): RedactedBenchmarkArtifact["recommendation"] {
  const existing = summaries.find((summary) => summary.provider === "scrapingbee-public-page");
  const apify = summaries.find((summary) => summary.provider === "caffein-apify");
  const fullyCovered =
    existing?.queryCount === SOLD_COMPS_BENCHMARK_CORPUS.length &&
    apify?.queryCount === SOLD_COMPS_BENCHMARK_CORPUS.length;
  const existingCompCount = capture.queries
    .filter((query) => query.provider === "scrapingbee-public-page")
    .reduce((sum, query) => sum + query.comps.length, 0);
  const apifyCompCount = capture.queries
    .filter((query) => query.provider === "caffein-apify")
    .reduce((sum, query) => sum + query.comps.length, 0);
  const fullyLabeled = Boolean(
    existing &&
      apify &&
      existingCompCount > 0 &&
      apifyCompCount > 0 &&
      existing.labeledCompCount === existingCompCount &&
      apify.labeledCompCount === apifyCompCount,
  );
  const snapshot = capture.apifyPricingSnapshot;
  const modeledCrossover = snapshot
    ? Math.ceil(
        49 /
          (snapshot.resultPriceUpperBoundUsd * BENCHMARK_MAX_RESULTS_PER_QUERY +
            (snapshot.actorStartPriceUsd * snapshot.actorStartUnitsPerRun) /
              APIFY_MAX_KEYWORDS_PER_RUN),
      )
    : null;
  if (!fullyCovered || !fullyLabeled || capture.productResearch.status !== "complete") {
    return {
      status: "operator-pending",
      reason: "A primary/fallback/reject decision requires both 40-query live runs, human comp labels, and the manual Product Research aggregate subset.",
      monthlyCrossoverQueries: modeledCrossover,
    };
  }

  const apifyCostPerSuccess =
    apify!.usablePricingQueryCount > 0 && apify!.actualUsdSpent != null
      ? apify!.actualUsdSpent / apify!.usablePricingQueryCount
      : null;
  // Lowest current ScrapingBee fixed plan is recorded in the report docs. The
  // observed Actor cost determines the query crossover; existing-plan marginal
  // cost remains zero until its included credits are exhausted.
  const monthlyCrossoverQueries = apifyCostPerSuccess
    ? Math.ceil(49 / apifyCostPerSuccess)
    : null;
  const apifyAccuracyBetter =
    (apify!.relevantPrecision ?? 0) >= (existing!.relevantPrecision ?? 0) + 0.03 &&
    apify!.conditionContaminationRate! <= existing!.conditionContaminationRate!;
  const apifyReliabilityBetter =
    apify!.successfulQueryCoverage >= existing!.successfulQueryCoverage &&
    apify!.blockErrorRate <= existing!.blockErrorRate;
  if (apifyAccuracyBetter && apifyReliabilityBetter) {
    return {
      status: "apify-primary",
      reason: "Apify cleared the measured accuracy and reliability bars; keep the existing provider as a kill-switched fallback behind the same normalized adapter/cache budget.",
      monthlyCrossoverQueries,
    };
  }
  if (apify!.successfulQueryCoverage > existing!.successfulQueryCoverage) {
    return {
      status: "apify-fallback",
      reason: "Apify improves coverage but did not clear the accuracy/reliability margin required to replace the existing primary.",
      monthlyCrossoverQueries,
    };
  }
  return {
    status: "reject-apify",
    reason: "Apify did not improve measured accuracy or reliability enough to justify a second paid provider.",
    monthlyCrossoverQueries,
  };
}

export function buildRedactedArtifact(
  capture: BenchmarkCapture,
  labels: readonly BenchmarkCompLabel[],
): RedactedBenchmarkArtifact {
  const labelMap = new Map(labels.map((label) => [label.compId, label]));
  const providers = (["scrapingbee-public-page", "caffein-apify"] as const)
    .map((provider) => capture.queries.filter((query) => query.provider === provider))
    .filter((queries) => queries.length > 0)
    .map((queries) => {
      const summary = summarizeProvider(queries, labels);
      return summary.provider === "scrapingbee-public-page" &&
        capture.scrapingBeeCreditAccounting
        ? {
            ...summary,
            creditsSpent:
              capture.scrapingBeeCreditAccounting.accountDeltaCredits,
          }
        : summary;
    });
  const perQuery = capture.queries.map((query) => perQueryRedacted(query, labelMap));
  const existingById = new Map(
    perQuery
      .filter((query) => query.provider === "scrapingbee-public-page")
      .map((query) => [query.queryId, query]),
  );
  const pairs = perQuery
    .filter((query) => query.provider === "caffein-apify")
    .flatMap((apify) => {
      const existing = existingById.get(apify.queryId);
      return existing?.median != null && apify.median != null && existing.range && apify.range
        ? [{ existing, apify }]
        : [];
    });
  const medianDeltas = pairs.map(({ existing, apify }) =>
    Math.abs(existing.median! - apify.median!) /
    ((existing.median! + apify.median!) / 2),
  );
  const overlaps = pairs.map(({ existing, apify }) =>
    overlapRate(existing.range!, apify.range!),
  );
  return {
    schemaVersion: 1,
    runId: capture.runId,
    mode: capture.mode,
    createdAt: capture.createdAt,
    corpusDigest: capture.corpusDigest,
    queryCount: SOLD_COMPS_BENCHMARK_CORPUS.length,
    maxResultsPerQuery: capture.maxResultsPerQuery,
    apifyHardCeilingUsd: capture.apifyHardCeilingUsd,
    candidate: capture.apifyPricingSnapshot
      ? {
          actorId: capture.apifyPricingSnapshot.actorId,
          actorBuildId: capture.apifyPricingSnapshot.actorBuildId,
          actorBuildNumber: capture.apifyPricingSnapshot.actorBuildNumber,
          actorBuildFinishedAt:
            capture.apifyPricingSnapshot.actorBuildFinishedAt,
          metadataObservedAt: capture.apifyPricingSnapshot.observedAt,
        }
      : null,
    providers,
    perQuery,
    crossProvider: {
      comparableQueryCount: pairs.length,
      medianAbsoluteMedianDeltaRate: medianDeltas.length
        ? roundRate(sortedMedian(medianDeltas)!)
        : null,
      medianRangeOverlapRate: overlaps.length
        ? roundRate(sortedMedian(overlaps)!)
        : null,
    },
    maintainability: maintainability(),
    costAccounting: {
      scrapingBee: capture.scrapingBeeCreditAccounting ?? null,
    },
    productResearch: capture.productResearch,
    recommendation: recommendationFor(capture, providers),
    redaction: {
      rawResponsesPersisted: false,
      sellerFieldsPersisted: false,
      sourceUrlsPersisted: false,
      reviewTitlesPersisted: false,
    },
  };
}

export function corpusDigest(): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(SOLD_COMPS_BENCHMARK_CORPUS))
    .digest("hex")}`;
}

export function pricingSnapshotFromActorMetadata(
  metadata: unknown,
  observedAt = new Date().toISOString(),
): ApifyPricingSnapshot {
  const root = metadata as {
    data?: {
      id?: unknown;
      taggedBuilds?: {
        latest?: {
          buildId?: unknown;
          buildNumber?: unknown;
          finishedAt?: unknown;
        };
      };
      pricingInfos?: Array<{
        startedAt?: string;
        pricingPerEvent?: {
          actorChargeEvents?: Record<string, {
            eventPriceUsd?: number;
            eventTieredPricingUsd?: Record<string, { tieredEventPriceUsd?: number }>;
          }>;
        };
      }>;
    };
  };
  const infos = (root.data?.pricingInfos ?? [])
    .filter((info) => info.startedAt && info.startedAt <= observedAt)
    .sort((a, b) => b.startedAt!.localeCompare(a.startedAt!));
  const current = infos[0];
  const events = current?.pricingPerEvent?.actorChargeEvents;
  const result = events?.["apify-default-dataset-item"];
  const tiered = Object.values(result?.eventTieredPricingUsd ?? {})
    .map((tier) => tier.tieredEventPriceUsd)
    .filter((value): value is number => typeof value === "number");
  const resultPriceUpperBoundUsd = tiered.length
    ? Math.max(...tiered)
    : result?.eventPriceUsd;
  const actorStartPriceUsd = events?.["apify-actor-start"]?.eventPriceUsd;
  const latestBuild = root.data?.taggedBuilds?.latest;
  if (
    root.data?.id !== APIFY_ACTOR_ID ||
    typeof latestBuild?.buildId !== "string" ||
    typeof latestBuild.buildNumber !== "string" ||
    typeof latestBuild.finishedAt !== "string" ||
    !current?.startedAt ||
    typeof resultPriceUpperBoundUsd !== "number" ||
    typeof actorStartPriceUsd !== "number"
  ) {
    throw new Error("Unable to verify current Actor pricing; no paid run was started.");
  }
  return {
    observedAt,
    actorId: APIFY_ACTOR_ID,
    actorBuildId: latestBuild.buildId,
    actorBuildNumber: latestBuild.buildNumber,
    actorBuildFinishedAt: latestBuild.finishedAt,
    pricingStartedAt: current.startedAt,
    resultPriceUpperBoundUsd,
    actorStartPriceUsd,
    actorStartUnitsPerRun: 4,
    source: "live-public-actor-metadata",
  };
}
