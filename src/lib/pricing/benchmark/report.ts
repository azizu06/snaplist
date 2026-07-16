import type {
  ApifyPricingSnapshot,
  ProviderSummary,
  RedactedBenchmarkArtifact,
} from "./types";

const SCRAPINGBEE_PUBLIC_MONTHLY_USD = 49;
const SCRAPINGBEE_PUBLIC_MONTHLY_CREDITS = 250_000;
const APIFY_KEYWORDS_PER_RUN = 6;

function pct(value: number | null): string {
  return value == null ? "operator-pending" : `${(value * 100).toFixed(1)}%`;
}

function n(value: number | null): string {
  return value == null ? "operator-pending" : String(value);
}

function usd(value: number | null): string {
  return value == null ? "operator-pending" : `$${value.toFixed(4)}`;
}

function providerName(provider: ProviderSummary["provider"]): string {
  return provider === "caffein-apify" ? "Caffein Apify" : "ScrapingBee public page";
}

function modeledCrossover(snapshot: ApifyPricingSnapshot | null): number | null {
  if (!snapshot) return null;
  const apifyUpperPerQuery =
    snapshot.resultPriceUpperBoundUsd * 25 +
    (snapshot.actorStartPriceUsd * snapshot.actorStartUnitsPerRun) /
      APIFY_KEYWORDS_PER_RUN;
  return Math.ceil(SCRAPINGBEE_PUBLIC_MONTHLY_USD / apifyUpperPerQuery);
}

export interface FormatBenchmarkReportOptions {
  apifyPricing: ApifyPricingSnapshot | null;
  liveLimitations?: string[];
}

export function formatBenchmarkReport(
  artifact: RedactedBenchmarkArtifact,
  options: FormatBenchmarkReportOptions,
): string {
  const providers = new Map(artifact.providers.map((provider) => [provider.provider, provider]));
  const existing = providers.get("scrapingbee-public-page");
  const apify = providers.get("caffein-apify");
  const fullyRun = existing?.queryCount === 40 && apify?.queryCount === 40;
  const fullyLabeled = Boolean(
    existing?.labeledCompCount && apify?.labeledCompCount,
  );
  const liveComplete =
    fullyRun && fullyLabeled && artifact.productResearch.status === "complete";
  const crossover =
    artifact.recommendation.monthlyCrossoverQueries ??
    modeledCrossover(options.apifyPricing);
  const limitations = options.liveLimitations ?? [];

  const lines = [
    "# Sold-comps provider benchmark — Issue #188",
    "",
    `Run: \`${artifact.runId}\` · ${artifact.createdAt}`,
    "",
    `- Harness status: complete`,
    `- Live benchmark status: ${liveComplete ? "complete" : "incomplete"}`,
    `- Recommendation status: \`${artifact.recommendation.status}\``,
    `- Candidate: ${artifact.candidate ? `Caffein Actor \`${artifact.candidate.actorId}\` pinned to build \`${artifact.candidate.actorBuildNumber}\` (\`${artifact.candidate.actorBuildId}\`)` : "public Actor metadata unavailable"}`,
    `- Corpus: ${artifact.queryCount} fixed public-product queries, capped at ${artifact.maxResultsPerQuery} rows/query`,
    `- Apify safety: absolute $${artifact.apifyHardCeilingUsd.toFixed(2)} ceiling plus per-run platform caps`,
    "",
    "## Measured results",
    "",
    "| Provider | Coverage | Empty | Block/error | Relevant precision | Variant contamination | Condition contamination | Usable pricing queries | p50 / p95 latency | Retries | Spend |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...artifact.providers.map((provider) =>
      `| ${providerName(provider.provider)} | ${pct(provider.successfulQueryCoverage)} | ${pct(provider.emptyResultRate)} | ${pct(provider.blockErrorRate)} | ${pct(provider.relevantPrecision)} | ${pct(provider.variantContaminationRate)} | ${pct(provider.conditionContaminationRate)} | ${provider.usablePricingQueryCount}/${provider.queryCount} | ${n(provider.latencyMs.p50)} / ${n(provider.latencyMs.p95)} ms | ${provider.retries} | ${usd(provider.actualUsdSpent)}${provider.creditsSpent ? ` + ${provider.creditsSpent} credits` : ""} |`,
    ),
    "",
    `Cross-provider comparable queries: ${artifact.crossProvider.comparableQueryCount}; median price delta: ${pct(artifact.crossProvider.medianAbsoluteMedianDeltaRate)}; median range overlap: ${pct(artifact.crossProvider.medianRangeOverlapRate)}.`,
    "",
    "Median stability is the deterministic odd/even split-median delta; range stability is the observed range width divided by the median. These are reported per provider and never substitute for human relevance labels.",
    "",
    "## Best Offer handling",
    "",
    "The public eBay page does not disclose the accepted offer amount. The displayed value is an asking price, not the accepted transaction amount. The existing parser excludes Best Offer Accepted cards before pricing. The Apify adapter preserves the row only for audit, labels its displayed value as `asking-price-not-accepted-amount`, and excludes it from every median, range, precision-backed usable count, and recommendation calculation.",
    "",
    "## Cost and crossover",
    "",
    `- ScrapingBee fixed reference: $${SCRAPINGBEE_PUBLIC_MONTHLY_USD}/month for ${SCRAPINGBEE_PUBLIC_MONTHLY_CREDITS.toLocaleString()} included credits on the lowest public plan. Marginal cash cost stays $0 while included credits remain; \`SPB-cost\` is exact when a response arrives and the isolated account-usage delta is authoritative when the client aborts.`,
    ...(artifact.costAccounting.scrapingBee
      ? [`- ScrapingBee credit evidence: ${artifact.costAccounting.scrapingBee.accountDeltaCredits} account-delta credits; ${artifact.costAccounting.scrapingBee.responseHeaderCredits} response-header credits; ${artifact.costAccounting.scrapingBee.unattributedCredits} charged credits intentionally left unassigned to individual timed-out queries.`]
      : []),
    `- ScrapingBee allocated reference cost in this run: ${existing ? usd((existing.creditsSpent * SCRAPINGBEE_PUBLIC_MONTHLY_USD) / SCRAPINGBEE_PUBLIC_MONTHLY_CREDITS) : "operator-pending"}. This is allocation math, not an additional charge.`,
    ...(artifact.providers.map((provider) => {
      const creditsPerQuery = provider.queryCount > 0
        ? provider.creditsSpent / provider.queryCount
        : 0;
      const creditsPerUsable = provider.usablePricingQueryCount > 0
        ? provider.creditsSpent / provider.usablePricingQueryCount
        : null;
      return `- ${providerName(provider.provider)} marginal result: ${usd(provider.costPerQueryUsd)}/query and ${usd(provider.costPerUsablePricingResultUsd)}/usable pricing query${provider.creditsSpent ? `; ${creditsPerQuery.toFixed(2)} credits/query and ${creditsPerUsable?.toFixed(2) ?? "operator-pending"} credits/usable pricing query` : ""}.`;
    })),
    options.apifyPricing
      ? `- Apify live public price snapshot: up to $${options.apifyPricing.resultPriceUpperBoundUsd.toFixed(4)}/result plus $${options.apifyPricing.actorStartPriceUsd.toFixed(5)} per GB-start event, observed ${options.apifyPricing.observedAt}.`
      : "- Apify price snapshot: unavailable; a paid run is blocked until live public pricing can be preflighted.",
    crossover
      ? `- Fixed-cost crossover model: ~${crossover} queries/month at the 25-result Apify upper bound versus the $49 ScrapingBee subscription. If ScrapingBee is already paid for other traffic, its marginal crossover does not occur until included credits are exhausted.`
      : "- Fixed-cost crossover: operator-pending until the current Actor price and live usable-result cost are known.",
    "",
    "Sources: [Caffein Actor](https://apify.com/caffein.dev/ebay-sold-listings), [Apify maximum run charge](https://docs.apify.com/api/v2/act-run-sync-get-dataset-items-get), [ScrapingBee pricing](https://www.scrapingbee.com/pricing/), [ScrapingBee credit costs](https://help.scrapingbee.com/en/article/credit-system-explained-1h2ackp/).",
    "",
    "## Maintainability and provider risk",
    "",
    ...(["scrapingbee-public-page", "caffein-apify"] as const).flatMap((provider) => {
      const assessment = artifact.maintainability[provider];
      return [
        `### ${providerName(provider)}`,
        "",
        `- Schema/parser burden: ${assessment.schemaBurden}`,
        `- Block/retry behavior: ${assessment.blockRetryBehavior}`,
        `- Lock-in: ${assessment.lockInRisk}`,
        "",
      ];
    }),
    "## Product Research reference",
    "",
    artifact.productResearch.status === "complete"
      ? `Manual aggregate review completed for: ${artifact.productResearch.queryIds.join(", ")}. The redacted result retains ${artifact.productResearch.rows?.length ?? 0} aggregate reference rows for direct per-query median/range comparison. No Seller Hub session was automated or extracted.`
      : `Status: operator-pending for exact query IDs ${artifact.productResearch.queryIds.join(", ")}. The checked-in template requires only manually transcribed aggregate count/median/range; no authenticated response or seller data is collected.`,
    "",
    "## Recommendation",
    "",
    `**${artifact.recommendation.status}.** ${artifact.recommendation.reason}`,
    "",
    "A production follow-up, if later approved, must preserve the provider-neutral adapter, existing TTL cache and freshness decay, a global budget counter, per-run cost caps, an environment kill switch, graceful fallback, and redacted diagnostics. This evaluation does not change production routing.",
  ];

  if (limitations.length > 0) {
    lines.push("", "## Live-access limitations", "");
    for (const limitation of limitations) lines.push(`- ${limitation}`);
  }
  lines.push("");
  return lines.join("\n");
}
