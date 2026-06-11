import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DEFAULT_DEPRECIATION_FACTOR,
  DEPRECIATION_CONFIDENCE,
  DEPRECIATION_FACTORS,
  MAX_RETAIL_SEARCHES,
  buildRetailQueries,
  createDepreciationPricingProvider,
  type ExtractRetail,
  type RetailFinding,
} from "./depreciation";
import type { SearchClient, SearchResult } from "./web-search";
import { priceResultSchema, type ItemSignal } from "../types";
import { computeConfidence } from "../../confidence/confidence";

/**
 * Tier 4 — the depreciation provider (issue #11). Every test runs fully
 * OFFLINE: the search client and the retail extractor (the LLM call) are
 * injected fakes, matching the repo-wide DI testing pattern.
 *
 * Acceptance criteria covered:
 *  - generic item with a findable RETAIL price → retail × condition factor,
 *    cited, labeled low-confidence (provisional 0.35; composite sub-gate);
 *  - extraction is allowlist-gated (a finding must cite a search-result URL);
 *  - the retail search is hard-capped at MAX_RETAIL_SEARCHES;
 *  - no cited retail anchor → decline (null) so the router falls to llm-only;
 *  - the depreciation composite can NEVER reach the 0.75 autopilot gate.
 */

/** Generic-but-searchable: brand + category, no model → the web tiers decline. */
const GENERIC_SIGNAL: ItemSignal = {
  brand: "Hamilton Beach",
  category: "kitchen",
  condition: "good",
  conditionKnown: true,
};

/** Canned retail search hits (URLs are what the findings must cite). */
function cannedResults(prefix: string): SearchResult[] {
  return [
    {
      url: `https://www.walmart.com/ip/${prefix}-1`,
      title: "Hamilton Beach blender — new",
      snippet: "Price: $100.00",
    },
    {
      url: `https://www.target.com/p/${prefix}-2`,
      title: "Hamilton Beach blender",
      snippet: "$104.00 new",
    },
  ];
}

/** A fake SearchClient that records its queries and serves canned results. */
function fakeSearch(
  resultsByCall: SearchResult[][] = [cannedResults("q1")],
): SearchClient & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async search(query: string) {
      queries.push(query);
      const i = Math.min(queries.length - 1, resultsByCall.length - 1);
      return resultsByCall[i] ?? [];
    },
  };
}

/** A fake extractor that serves the given finding batches, one per call. */
function fakeRetailExtractor(batches: RetailFinding[][]): ExtractRetail {
  let calls = 0;
  return async () => {
    const batch = batches[Math.min(calls, batches.length - 1)] ?? [];
    calls += 1;
    return batch;
  };
}

/** A $100 retail finding citing the canned q1 result URL. */
function retail100(prefix = "q1"): RetailFinding[] {
  return [
    {
      url: `https://www.walmart.com/ip/${prefix}-1`,
      title: "new at Walmart",
      price: 100,
    },
  ];
}

function makeProvider(
  extractBatches: RetailFinding[][] = [retail100()],
  searchClient: SearchClient = fakeSearch(),
  model?: string,
) {
  return createDepreciationPricingProvider({
    searchClient,
    extractRetail: fakeRetailExtractor(extractBatches),
    ...(model ? { model } : {}),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("retail query formulation", () => {
  it("prefers brand+model, then resolvedName, then brand+category", () => {
    expect(
      buildRetailQueries({ brand: "Sony", model: "WH-1000XM4", category: "electronics" })[0],
    ).toContain("Sony WH-1000XM4");
    expect(
      buildRetailQueries({ resolvedName: "Nike Air Max 90", category: "shoes" })[0],
    ).toContain("Nike Air Max 90");
    expect(buildRetailQueries(GENERIC_SIGNAL)[0]).toContain("Hamilton Beach kitchen");
  });

  it("yields no queries for an unidentifiable signal (category-only / bare)", () => {
    expect(buildRetailQueries({ category: "home decor" })).toEqual([]);
    expect(buildRetailQueries({})).toEqual([]);
    expect(buildRetailQueries({ condition: "good", conditionKnown: true })).toEqual([]);
  });

  it("caps the query list at MAX_RETAIL_SEARCHES", () => {
    const queries = buildRetailQueries(GENERIC_SIGNAL);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.length).toBeLessThanOrEqual(MAX_RETAIL_SEARCHES);
  });
});

describe("depreciation pricing (retail × condition factor)", () => {
  it("prices a generic item at retail × the condition factor, with a cited source", async () => {
    const provider = makeProvider();
    const result = await provider.price(GENERIC_SIGNAL);

    expect(result).not.toBeNull();
    expect(priceResultSchema.safeParse(result).success).toBe(true);
    expect(result!.tier).toBe("depreciation");
    // $100 retail × good (0.5) = $50, band ±30%.
    expect(result!.suggested).toBe(50);
    expect(result!.range).toEqual({ min: 35, max: 65 });
    expect(result!.sources).toEqual([
      {
        url: "https://www.walmart.com/ip/q1-1",
        title: "new at Walmart",
        kind: "retail-price",
      },
    ]);
  });

  it("applies the documented factor for each condition grade", async () => {
    for (const [condition, factor] of Object.entries(DEPRECIATION_FACTORS)) {
      const provider = makeProvider();
      const result = await provider.price({ ...GENERIC_SIGNAL, condition });
      // Suggested = the depreciated center for every grade ("new" only has its
      // band TOP clamped to retail; the center stays inside). toBeCloseTo
      // because the provider rounds to cents while 100 × factor may carry
      // float dust (e.g. 100 × 0.55 = 55.00000000000001).
      expect(result!.suggested).toBeCloseTo(100 * factor, 10);
    }
  });

  it("prices an UNKNOWN condition at the good baseline (still an estimate, not a refusal)", async () => {
    const provider = makeProvider();
    const result = await provider.price({
      brand: "Hamilton Beach",
      category: "kitchen",
    });
    expect(result!.suggested).toBe(100 * DEFAULT_DEPRECIATION_FACTOR);
  });

  it("clamps the band top to the cited retail anchor (used never above new)", async () => {
    const provider = makeProvider();
    const result = await provider.price({ ...GENERIC_SIGNAL, condition: "new" });
    // center 80, naive top 80 × 1.3 = 104 > retail 100 → clamped.
    expect(result!.range.max).toBe(100);
    expect(result!.range.min).toBe(56);
    expect(result!.suggested).toBe(80);
  });

  it("anchors on the MEDIAN when several retail findings are cited", async () => {
    const findings: RetailFinding[] = [
      { url: "https://www.walmart.com/ip/q1-1", price: 90 },
      { url: "https://www.target.com/p/q1-2", price: 110 },
    ];
    const provider = makeProvider([findings]);
    const result = await provider.price(GENERIC_SIGNAL);
    // median(90, 110) = 100 → good 0.5 → 50; both findings cited.
    expect(result!.suggested).toBe(50);
    expect(result!.sources).toHaveLength(2);
  });

  it("labels the result with the LOW provisional confidence", async () => {
    const result = await makeProvider().price(GENERIC_SIGNAL);
    expect(result!.confidence).toBe(DEPRECIATION_CONFIDENCE);
    expect(result!.confidence).toBeLessThan(0.5);
  });
});

describe("anti-hallucination (post-hoc URL allowlist)", () => {
  it("drops findings citing URLs outside the search results", async () => {
    const provider = makeProvider([
      [
        { url: "https://made-up.example/nowhere", price: 100 },
        { url: "https://www.walmart.com/ip/q1-1", price: 80 },
      ],
    ]);
    const result = await provider.price(GENERIC_SIGNAL);
    // Only the allowlisted $80 finding survives → anchor 80 → good 0.5 → 40.
    expect(result!.suggested).toBe(40);
    expect(result!.sources).toEqual([
      { url: "https://www.walmart.com/ip/q1-1", title: undefined, kind: "retail-price" },
    ]);
  });

  it("declines when EVERY finding fails the allowlist (never prices off a fabricated URL)", async () => {
    const provider = makeProvider([
      [{ url: "https://made-up.example/nowhere", price: 100 }],
    ]);
    expect(await provider.price(GENERIC_SIGNAL)).toBeNull();
  });
});

describe("bounded search + decline semantics", () => {
  it("declines (null) for an unidentifiable signal without searching", async () => {
    const search = fakeSearch();
    const provider = makeProvider([retail100()], search);
    expect(await provider.price({ category: "home decor" })).toBeNull();
    expect(search.queries).toEqual([]);
  });

  it("canHandle mirrors the identity requirement", () => {
    const provider = makeProvider();
    expect(provider.canHandle!(GENERIC_SIGNAL)).toBe(true);
    expect(provider.canHandle!({ category: "home decor" })).toBe(false);
  });

  it("stops after the FIRST query once a cited retail anchor is found", async () => {
    const search = fakeSearch();
    const provider = makeProvider([retail100()], search);
    await provider.price(GENERIC_SIGNAL);
    expect(search.queries).toHaveLength(1);
  });

  it("retries the second query when the first finds nothing, capped at MAX_RETAIL_SEARCHES", async () => {
    const search = fakeSearch([cannedResults("q1"), cannedResults("q2")]);
    const provider = makeProvider([[], []], search);
    expect(await provider.price(GENERIC_SIGNAL)).toBeNull();
    expect(search.queries).toHaveLength(MAX_RETAIL_SEARCHES);
  });

  it("declines when the search itself returns no results", async () => {
    const search = fakeSearch([[], []]);
    const extract = vi.fn(async () => retail100());
    const provider = createDepreciationPricingProvider({
      searchClient: search,
      extractRetail: extract,
    });
    expect(await provider.price(GENERIC_SIGNAL)).toBeNull();
    // No results → the extractor (a model call) is never spent.
    expect(extract).not.toHaveBeenCalled();
  });

  it("declines WITHOUT searching when the default client would run keyless", async () => {
    vi.stubEnv("TAVILY_API_KEY", "");
    vi.stubEnv("EXA_API_KEY", "");
    const extract = vi.fn(async () => retail100());
    // No searchClient injected → the env-gated default applies.
    const provider = createDepreciationPricingProvider({ extractRetail: extract });
    expect(await provider.price(GENERIC_SIGNAL)).toBeNull();
    expect(extract).not.toHaveBeenCalled();
  });

  it("propagates a thrown search client as a HARD error, not a decline", async () => {
    const provider = createDepreciationPricingProvider({
      searchClient: {
        async search() {
          throw new Error("search API down");
        },
      },
      extractRetail: fakeRetailExtractor([retail100()]),
    });
    await expect(provider.price(GENERIC_SIGNAL)).rejects.toThrow(/search API down/);
  });
});

describe("provenance honesty", () => {
  it("stamps the declared model for a custom extractor", async () => {
    const provider = makeProvider([retail100()], fakeSearch(), "test-retail-model");
    const result = await provider.price(GENERIC_SIGNAL);
    expect(result!.model).toBe("test-retail-model");
  });

  it("claims NO model for a custom extractor without a declared model", async () => {
    const result = await makeProvider().price(GENERIC_SIGNAL);
    // An injected extractor may use a different model — or none — so an
    // undeclared one logs no claim (undefined → pricing_model NULL).
    expect(result!.model).toBeUndefined();
  });
});

describe("autopilot sub-gate by construction", () => {
  it("the depreciation composite maxes out at 0.64 < the 0.75 gate", () => {
    // Even a PERFECTLY identified item with lockstep agreement cannot clear
    // the gate off a depreciation estimate: 0.6·0.4 + 0.25·1 + 0.15·1 = 0.64.
    const best = computeConfidence({
      tier: "depreciation",
      compAgreement: 1,
      identification: {
        brandResolved: true,
        modelResolved: true,
        barcodeDecoded: true,
        categoryUnambiguous: true,
      },
    });
    expect(best.score).toBeCloseTo(0.64, 10);
    expect(best.score).toBeLessThan(0.75);
    expect(best.band).not.toBe("high");
    expect(best.autopilotEligible).toBe(false);
  });
});
