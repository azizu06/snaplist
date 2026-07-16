import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { buildSoldSearchUrl } from "../providers/ebay-sold";
import {
  APIFY_ACTOR_ID,
  APIFY_HARD_CEILING_USD,
  BENCHMARK_MAX_RESULTS_PER_QUERY,
  assertScrapingBeeProxyTemplate,
  buildApifyRunBudget,
  buildDryRunPlan,
  buildRedactedArtifact,
  normalizeApifyItems,
  parseBenchmarkArgs,
  runScrapingBeeQuery,
  summarizeProvider,
} from "./core";
import { SOLD_COMPS_BENCHMARK_CORPUS } from "./corpus";
import type {
  BenchmarkCapture,
  BenchmarkCompLabel,
  BenchmarkTag,
  ProviderQueryCapture,
} from "./types";

const FIXTURE_HTML = readFileSync(
  fileURLToPath(
    new URL("../providers/fixtures/ebay-sold.sample.html", import.meta.url),
  ),
  "utf8",
);

describe("the fixed sold-comps benchmark corpus", () => {
  it("contains exactly 40 unique redacted queries using production-normalized inputs", () => {
    expect(SOLD_COMPS_BENCHMARK_CORPUS).toHaveLength(40);
    expect(new Set(SOLD_COMPS_BENCHMARK_CORPUS.map((entry) => entry.id)).size).toBe(40);
    expect(new Set(SOLD_COMPS_BENCHMARK_CORPUS.map((entry) => entry.query)).size).toBe(40);

    for (const entry of SOLD_COMPS_BENCHMARK_CORPUS) {
      const url = buildSoldSearchUrl(entry.signal);
      expect(url, entry.id).not.toBeNull();
      expect(new URL(url!).searchParams.get("_nkw"), entry.id).toBe(entry.query);
      expect(entry.query).not.toMatch(/@|https?:|seller|token|cookie/i);
    }
  });

  it("spans the hero domain plus condition, variant, accessory, and weak-comp cases", () => {
    const tags = new Set(SOLD_COMPS_BENCHMARK_CORPUS.flatMap((entry) => entry.tags));
    for (const tag of [
      "books-media",
      "electronics",
      "video-games",
      "board-games",
      "lego",
      "sneakers",
      "clothing",
      "branded-gear",
      "used",
      "new",
      "ambiguous-variant",
      "accessory-as-product",
      "weak-no-comp",
    ] satisfies BenchmarkTag[]) {
      expect(tags.has(tag), tag).toBe(true);
    }
  });
});

describe("safe invocation and Apify cost caps", () => {
  it("makes the bare command a zero-request dry run", () => {
    const args = parseBenchmarkArgs([]);
    const plan = buildDryRunPlan(args);

    expect(args.mode).toBe("dry-run");
    expect(plan.externalRequests).toBe(0);
    expect(plan.queryCount).toBe(40);
    expect(plan.maxResultsPerQuery).toBe(BENCHMARK_MAX_RESULTS_PER_QUERY);
    expect(plan.apifyActorId).toBe(APIFY_ACTOR_ID);
  });

  it("requires both explicit live flags and never accepts a cap above USD $5", () => {
    expect(() => parseBenchmarkArgs(["--live"])).toThrow(/--confirm-live/);
    expect(() => parseBenchmarkArgs(["--confirm-live"])).toThrow(/--live/);
    expect(() =>
      parseBenchmarkArgs([
        "--live",
        "--confirm-live",
        "--max-apify-usd",
        "5.01",
      ]),
    ).toThrow(/absolute USD \$5 ceiling/);
  });

  it("preflights all seven Actor batches below the absolute ceiling", () => {
    const budget = buildApifyRunBudget({
      queryCount: 40,
      maxResultsPerQuery: 25,
      maxKeywordsPerRun: 6,
      resultPriceUsd: 0.004,
      actorStartPriceUsd: 0.00005,
      actorStartUnitsPerRun: 4,
      hardCeilingUsd: APIFY_HARD_CEILING_USD,
    });

    expect(budget.batches).toHaveLength(7);
    expect(budget.batches.every((batch) => batch.maxResultsPerQuery === 25)).toBe(true);
    expect(budget.totalMaxChargeUsd).toBeLessThanOrEqual(5);
    expect(budget.projectedUpperBoundUsd).toBeCloseTo(4.0014, 4);
  });

  it("rejects a non-ScrapingBee proxy before the existing-provider benchmark", () => {
    expect(() =>
      assertScrapingBeeProxyTemplate(
        "https://other-proxy.example/fetch?key=secret&url={url}",
      ),
    ).toThrow(/configured ScrapingBee adapter/);
  });
});

describe("provider-neutral normalization", () => {
  const entry = SOLD_COMPS_BENCHMARK_CORPUS[0];

  it("strips seller fields and excludes Best Offer asking prices from usable evidence", () => {
    const items = normalizeApifyItems(
      entry,
      [
        {
          itemId: "123",
          keyword: entry.query,
          url: "https://www.ebay.com/itm/123",
          title: `${entry.query} used`,
          soldPrice: "125.00",
          soldCurrency: "USD",
          condition: "Pre-Owned",
          endedAt: "2026-07-01T00:00:00.000Z",
          isBestOfferAccepted: false,
          sellerUsername: "must-not-survive",
        },
        {
          itemId: "456",
          keyword: entry.query,
          url: "https://www.ebay.com/itm/456",
          title: `${entry.query} used Best Offer Accepted`,
          soldPrice: "150.00",
          soldCurrency: "USD",
          condition: "Pre-Owned",
          endedAt: "2026-07-02T00:00:00.000Z",
          listingType: "best_offer_accepted",
          isBestOfferAccepted: true,
          sellerFeedbackScore: 9001,
        },
      ],
    );

    expect(items).toHaveLength(2);
    expect(items[0].usableForPricing).toBe(true);
    expect(items[0].priceDisclosure).toBe("displayed-sold-price");
    expect(items[1].usableForPricing).toBe(false);
    expect(items[1].priceDisclosure).toBe(
      "asking-price-not-accepted-amount",
    );
    expect(JSON.stringify(items)).not.toContain("must-not-survive");
    expect(JSON.stringify(items)).not.toContain("sellerFeedbackScore");
  });

  it("runs the current HTML parser/filter with the same 25-result ceiling", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(FIXTURE_HTML, {
        status: 200,
        headers: { "spb-cost": "10" },
      }),
    ) as unknown as typeof fetch;

    const capture = await runScrapingBeeQuery({
      entry: SOLD_COMPS_BENCHMARK_CORPUS.find((item) => item.id === "Q09")!,
      proxyTemplate: "https://app.scrapingbee.com/api/v1?api_key=secret&url={url}",
      fetchImpl,
      now: () => 1234,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(capture.provider).toBe("scrapingbee-public-page");
    expect(capture.creditsSpent).toBe(10);
    expect(capture.comps.length).toBeLessThanOrEqual(25);
    expect(capture.comps).toHaveLength(7);
    expect(capture.comps.filter((comp) => comp.usableForPricing)).toHaveLength(5);
    expect(capture.comps.some((comp) => !comp.usableForPricing)).toBe(true);
    expect(capture.bestOfferPolicy).toBe("excluded-by-parser");
    expect(JSON.stringify(capture)).not.toContain("secret");
    expect(JSON.stringify(capture)).not.toContain("<html");
  });
});

describe("human labels, metrics, and redacted output", () => {
  const queryCapture = (
    provider: ProviderQueryCapture["provider"],
  ): ProviderQueryCapture => ({
    provider,
    queryId: "Q01",
    status: "success",
    latencyMs: 100,
    attempts: 1,
    retries: 0,
    creditsSpent: provider === "scrapingbee-public-page" ? 10 : null,
    actualUsdSpent: provider === "caffein-apify" ? 0.08 : 0,
    bestOfferPolicy:
      provider === "caffein-apify"
        ? "labeled-and-excluded"
        : "excluded-by-parser",
    comps: [
      {
        id: `${provider}-one`,
        title: "private review title one",
        price: 100,
        currency: "USD",
        condition: "Pre-Owned",
        endedAt: "2026-07-01T00:00:00.000Z",
        usableForPricing: true,
        isBestOfferAccepted: false,
        priceDisclosure: "displayed-sold-price",
      },
      {
        id: `${provider}-two`,
        title: "private review title two",
        price: 110,
        currency: "USD",
        condition: "Brand New",
        endedAt: "2026-07-02T00:00:00.000Z",
        usableForPricing: true,
        isBestOfferAccepted: false,
        priceDisclosure: "displayed-sold-price",
      },
    ],
  });

  const capture: BenchmarkCapture = {
    schemaVersion: 1,
    runId: "test-run",
    mode: "live",
    createdAt: "2026-07-16T00:00:00.000Z",
    corpusDigest: "sha256:test",
    maxResultsPerQuery: 25,
    apifyHardCeilingUsd: 5,
    queries: [
      queryCapture("scrapingbee-public-page"),
      queryCapture("caffein-apify"),
    ],
    apifyPricingSnapshot: null,
    productResearch: { status: "operator-pending", queryIds: ["Q01"] },
  };

  const labels: BenchmarkCompLabel[] = [
    {
      compId: "scrapingbee-public-page-one",
      relevant: true,
      variantCorrect: true,
      conditionCorrect: true,
    },
    {
      compId: "scrapingbee-public-page-two",
      relevant: false,
      variantCorrect: false,
      conditionCorrect: false,
    },
    {
      compId: "caffein-apify-one",
      relevant: true,
      variantCorrect: true,
      conditionCorrect: true,
    },
    {
      compId: "caffein-apify-two",
      relevant: true,
      variantCorrect: true,
      conditionCorrect: false,
    },
  ];

  it("computes relevance and contamination from explicit human labels", () => {
    const existing = summarizeProvider(
      capture.queries.filter((query) => query.provider === "scrapingbee-public-page"),
      labels,
    );
    const apify = summarizeProvider(
      capture.queries.filter((query) => query.provider === "caffein-apify"),
      labels,
    );

    expect(existing.relevantPrecision).toBe(0.5);
    expect(existing.variantContaminationRate).toBe(0.5);
    expect(existing.conditionContaminationRate).toBe(0.5);
    expect(apify.relevantPrecision).toBe(1);
    expect(apify.conditionContaminationRate).toBe(0.5);
  });

  it("removes titles, URLs, seller data, tokens, and raw responses from the saved artifact", () => {
    const artifact = buildRedactedArtifact(capture, labels);
    const serialized = JSON.stringify(artifact);

    expect(serialized).not.toContain("private review title");
    expect(serialized).not.toContain("ebay.com/itm");
    expect(serialized).not.toContain("sellerUsername");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("<html");
    expect(artifact.redaction.rawResponsesPersisted).toBe(false);
    expect(artifact.redaction.sellerFieldsPersisted).toBe(false);
    expect(artifact.recommendation.status).toBe("operator-pending");
  });
});
