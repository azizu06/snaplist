/**
 * Reproducible Issue #188 provider benchmark.
 *
 * Safe default: `pnpm benchmark:sold-comps` prints a zero-request plan.
 * Live mode requires BOTH `--live --confirm-live`, validates every credential
 * and cost guard before paid requests, and never persists raw provider bodies,
 * source URLs, seller fields, credentials, or authenticated responses.
 */
import {
  mkdirSync,
  chmodSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APIFY_HARD_CEILING_USD,
  BENCHMARK_MAX_RESULTS_PER_QUERY,
  assertScrapingBeeProxyTemplate,
  buildDryRunPlan,
  buildRedactedArtifact,
  corpusDigest,
  parseBenchmarkArgs,
  runScrapingBeeQuery,
} from "../src/lib/pricing/benchmark/core";
import {
  fetchApifyPricingSnapshot,
  runApifyBenchmark,
  validateApifyAccess,
} from "../src/lib/pricing/benchmark/apify-client";
import {
  PRODUCT_RESEARCH_SUBSET_IDS,
  SOLD_COMPS_BENCHMARK_CORPUS,
} from "../src/lib/pricing/benchmark/corpus";
import { formatBenchmarkReport } from "../src/lib/pricing/benchmark/report";
import {
  buildPrivateReviewRows,
  parseHumanLabelFile,
  parseProductResearchFile,
} from "../src/lib/pricing/benchmark/review";
import type {
  ApifyPricingSnapshot,
  BenchmarkCapture,
  BenchmarkCompLabel,
  ProductResearchStatus,
  ProviderQueryCapture,
  ScrapingBeeCreditAccounting,
} from "../src/lib/pricing/benchmark/types";
import {
  fetchScrapingBeeUsedCredits,
  reconcileScrapingBeeCredits,
} from "../src/lib/pricing/benchmark/scrapingbee-client";

function loadEnvLocal(): void {
  const path = fileURLToPath(new URL("../.env.local", import.meta.url));
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const separator = trimmed.indexOf("=");
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function runId(now = new Date()): string {
  return `issue188-${now.toISOString().replace(/[-:.]/g, "").replace("Z", "Z")}`;
}

function writeJson(path: string, value: unknown, mode?: number): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    ...(mode ? { mode } : {}),
  });
  if (mode) chmodSync(path, mode);
}

function checkedProductResearch(argsPath?: string): ProductResearchStatus {
  if (!argsPath) {
    return { status: "operator-pending", queryIds: PRODUCT_RESEARCH_SUBSET_IDS };
  }
  return parseProductResearchFile(readJson(argsPath), PRODUCT_RESEARCH_SUBSET_IDS);
}

async function liveCapture(
  args: ReturnType<typeof parseBenchmarkArgs>,
): Promise<{
  capture: BenchmarkCapture;
  pricing: ApifyPricingSnapshot | null;
  limitations: string[];
}> {
  const wantsScrapingBee = args.provider === "both" || args.provider === "scrapingbee";
  const wantsApify = args.provider === "both" || args.provider === "apify";
  const proxyTemplate = process.env.EBAY_SOLD_PROXY_TEMPLATE?.trim() ?? "";
  const apifyToken =
    process.env.APIFY_TOKEN?.trim() || process.env.APIFY_API_TOKEN?.trim() || "";

  const missing: string[] = [];
  if (wantsScrapingBee && !proxyTemplate) missing.push("EBAY_SOLD_PROXY_TEMPLATE");
  if (wantsApify && !apifyToken) missing.push("APIFY_TOKEN");
  if (missing.length > 0) {
    throw new Error(
      `Live preflight blocked before provider calls: missing ${missing.join(", ")}.`,
    );
  }
  if (wantsScrapingBee) assertScrapingBeeProxyTemplate(proxyTemplate);

  let pricing: ApifyPricingSnapshot | null = null;
  const limitations: string[] = [];
  try {
    pricing = await fetchApifyPricingSnapshot();
  } catch {
    if (wantsApify) {
      throw new Error("Live preflight could not verify current Actor pricing; no paid run was started.");
    }
    limitations.push("Current public Apify pricing metadata was unavailable; crossover is pending.");
  }

  let creditsBefore: number | null = null;
  if (wantsScrapingBee) {
    try {
      creditsBefore = await fetchScrapingBeeUsedCredits({ proxyTemplate });
    } catch {
      throw new Error(
        "Live preflight could not validate ScrapingBee access or establish usage accounting; no paid request was made.",
      );
    }
  }
  if (wantsApify) {
    await validateApifyAccess({ token: apifyToken });
  }

  const queries: ProviderQueryCapture[] = [];
  let scrapingBeeCreditAccounting: ScrapingBeeCreditAccounting | undefined;
  if (wantsScrapingBee) {
    const scrapingBeeQueries: ProviderQueryCapture[] = [];
    for (const entry of SOLD_COMPS_BENCHMARK_CORPUS) {
      const result = await runScrapingBeeQuery({ entry, proxyTemplate });
      scrapingBeeQueries.push(result);
      process.stderr.write(
        `[scrapingbee] ${entry.id} ${result.status} ${result.comps.length} rows\n`,
      );
    }
    try {
      const creditsAfter = await fetchScrapingBeeUsedCredits({ proxyTemplate });
      const delta = Math.max(0, creditsAfter - creditsBefore!);
      scrapingBeeCreditAccounting = reconcileScrapingBeeCredits(
        scrapingBeeQueries,
        delta,
      );
      queries.push(...scrapingBeeQueries);
    } catch {
      limitations.push("ScrapingBee ending usage total was unavailable; response-header credit costs are reported.");
      queries.push(...scrapingBeeQueries);
    }
  } else {
    limitations.push("Existing ScrapingBee-backed provider was not executed in this run.");
  }

  if (wantsApify) {
    if (!pricing) throw new Error("Verified Actor pricing is required before a paid run.");
    const apify = await runApifyBenchmark({
      entries: SOLD_COMPS_BENCHMARK_CORPUS,
      token: apifyToken,
      maxApifyUsd: args.maxApifyUsd,
      pricingSnapshot: pricing,
    });
    queries.push(...apify.queries);
    process.stderr.write(
      `[apify] ${apify.queries.length} queries, actual run charge ${apify.actualUsdSpent == null ? "unavailable" : `$${apify.actualUsdSpent.toFixed(6)}`} (platform caps $${apify.totalPlatformCapsUsd.toFixed(6)})\n`,
    );
  } else {
    limitations.push(
      apifyToken
        ? "Caffein Apify was not selected for this partial run."
        : "APIFY_TOKEN is absent; the Caffein Actor live run is operator-blocked before any paid call.",
    );
  }

  const createdAt = new Date().toISOString();
  return {
    capture: {
      schemaVersion: 1,
      runId: runId(new Date(createdAt)),
      mode: "live",
      createdAt,
      corpusDigest: corpusDigest(),
      maxResultsPerQuery: BENCHMARK_MAX_RESULTS_PER_QUERY,
      apifyHardCeilingUsd: APIFY_HARD_CEILING_USD,
      queries,
      apifyPricingSnapshot: pricing,
      ...(scrapingBeeCreditAccounting ? { scrapingBeeCreditAccounting } : {}),
      productResearch: checkedProductResearch(args.productResearchPath),
      liveLimitations: limitations,
    },
    pricing,
    limitations,
  };
}

function saveOutputs(
  capture: BenchmarkCapture,
  labels: BenchmarkCompLabel[],
  outputDir: string,
  pricing: ApifyPricingSnapshot | null,
  limitations: string[],
): { resultPath: string; reportPath: string; capturePath: string; labelsPath: string } {
  const absoluteOutput = resolve(outputDir);
  mkdirSync(absoluteOutput, { recursive: true });
  const artifact = buildRedactedArtifact(capture, labels);
  const resultPath = join(absoluteOutput, "results.json");
  const reportPath = join(absoluteOutput, "REPORT.md");
  writeJson(resultPath, artifact);
  writeFileSync(
    reportPath,
    formatBenchmarkReport(artifact, { apifyPricing: pricing, liveLimitations: limitations }),
    "utf8",
  );

  const privateBase = join(tmpdir(), `snaplist-${capture.runId}`);
  const capturePath = `${privateBase}.capture.json`;
  const labelsPath = `${privateBase}.labels.json`;
  writeJson(capturePath, capture, 0o600);
  writeJson(
    labelsPath,
    {
      schemaVersion: 1,
      reviewedByHuman: false,
      instructions:
        "Review every title/condition, edit labels as needed, then set reviewedByHuman=true and rerun with --from-capture plus --labels. Best Offer displayed prices remain unusable regardless of labels.",
      labels: buildPrivateReviewRows(capture).map((row) => ({
        ...row.suggested,
        note: `${row.queryId} ${row.provider}: review '${row.title}' (${row.condition ?? "condition missing"}; ${row.priceDisclosure})`,
      })),
    },
    0o600,
  );
  return { resultPath, reportPath, capturePath, labelsPath };
}

function migrateLegacyScrapingBeeAccounting(
  capture: BenchmarkCapture,
): BenchmarkCapture {
  if (capture.scrapingBeeCreditAccounting) return capture;
  const scrapingBee = capture.queries.filter(
    (query) => query.provider === "scrapingbee-public-page",
  );
  const legacyAccountDelta = scrapingBee.reduce(
    (sum, query) => sum + (query.creditsSpent ?? 0),
    0,
  );
  if (!scrapingBee.some((query) => (query.creditsSpent ?? 0) > 25)) {
    return capture;
  }
  const queries = capture.queries.map((query) =>
    query.provider === "scrapingbee-public-page" &&
    (query.creditsSpent ?? 0) > 25
      ? { ...query, creditsSpent: 0 }
      : query,
  );
  return {
    ...capture,
    queries,
    scrapingBeeCreditAccounting: reconcileScrapingBeeCredits(
      queries.filter((query) => query.provider === "scrapingbee-public-page"),
      legacyAccountDelta,
    ),
  };
}

async function main(): Promise<void> {
  loadEnvLocal();
  const args = parseBenchmarkArgs(process.argv.slice(2));
  if (args.mode === "dry-run" && !args.capturePath) {
    console.log(JSON.stringify(buildDryRunPlan(args), null, 2));
    return;
  }

  let capture: BenchmarkCapture;
  let pricing: ApifyPricingSnapshot | null;
  let limitations: string[] = [];
  if (args.capturePath) {
    capture = migrateLegacyScrapingBeeAccounting(
      readJson(args.capturePath) as BenchmarkCapture,
    );
    if (args.productResearchPath) {
      capture = {
        ...capture,
        productResearch: checkedProductResearch(args.productResearchPath),
      };
    }
    pricing = capture.apifyPricingSnapshot;
    limitations = [...(capture.liveLimitations ?? [])];
    if (capture.productResearch.status !== "complete") {
      limitations.push("Product Research aggregate remains operator-pending.");
    }
  } else {
    const live = await liveCapture(args);
    capture = live.capture;
    pricing = live.pricing;
    limitations = live.limitations;
  }

  const labels = args.labelsPath
    ? parseHumanLabelFile(readJson(args.labelsPath))
    : [];
  const paths = saveOutputs(
    capture,
    labels,
    args.outputDir,
    pricing,
    limitations,
  );
  const apifySpent = capture.queries
    .filter((query) => query.provider === "caffein-apify")
    .map((query) => query.actualUsdSpent)
    .filter((value): value is number => value != null)
    .reduce((sum, value) => sum + value, 0);
  const scrapingBeeCredits = capture.scrapingBeeCreditAccounting
    ?.accountDeltaCredits ?? capture.queries
      .filter((query) => query.provider === "scrapingbee-public-page")
      .reduce((sum, query) => sum + (query.creditsSpent ?? 0), 0);
  console.log(
    JSON.stringify(
      {
        runId: capture.runId,
        resultPath: paths.resultPath,
        reportPath: paths.reportPath,
        privateCapturePath: paths.capturePath,
        privateHumanLabelsPath: paths.labelsPath,
        apifyActualUsdSpent: apifySpent,
        scrapingBeeCreditsSpent: scrapingBeeCredits,
        recommendationStatus: buildRedactedArtifact(capture, labels).recommendation.status,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Benchmark failed";
  // All provider/network errors are reduced before this boundary. Never print
  // raw response bodies, URLs with credentials, or arbitrary upstream text.
  console.error(
    /missing|preflight|requires|ceiling|APIFY_TOKEN|EBAY_SOLD_PROXY_TEMPLATE|Human labels|Product Research/i.test(
      message,
    )
      ? message
      : "Sold-comps benchmark failed with a redacted error.",
  );
  process.exitCode = 1;
});
