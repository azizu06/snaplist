import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DEFAULT_PRICING_MODEL,
  MAX_SEARCH_ITERATIONS,
  MIN_USEFUL_COMPS,
  buildSearchQueries,
  resolvePricingModel,
  createBrandedWebPricingProvider,
  createUpcWebPricingProvider,
  type ExtractComps,
  type SearchClient,
  type SearchResult,
  type WebComp,
} from "./web-search";
import { PriceRouter } from "../router";
import { priceResultSchema, type ItemSignal, type PriceResult } from "../types";

/**
 * Tiers 2 + 3 — the web-search pricing agent (issue #10). Every test runs
 * fully OFFLINE: the search client and the comp extractor (the LLM call) are
 * injected fakes, matching the repo-wide DI testing pattern.
 *
 * Acceptance criteria covered:
 *  - branded item → a cited range from (fake) web comps with URLs;
 *  - the loop is hard-capped at MAX_SEARCH_ITERATIONS searches;
 *  - confidence reflects comp agreement, and asking-only results emit ONLY
 *    `asking-comp` sources (never `sold-comp`) so the pipeline maps them to
 *    the down-weighted `web_wide` confidence tier;
 *  - "nothing useful" → decline (null) so the router falls through.
 */

const BRANDED_SIGNAL: ItemSignal = {
  brand: "Sony",
  model: "WH-1000XM4",
  category: "electronics",
  condition: "good",
  conditionKnown: true,
};

const UPC_SIGNAL: ItemSignal = {
  upc: "027242920569",
  resolvedName: "Sony WH-1000XM4 Wireless Headphones",
  category: "electronics",
};

/** Canned search hits (URLs are what the comps must cite). */
function cannedResults(prefix: string): SearchResult[] {
  return [
    {
      url: `https://www.ebay.com/itm/${prefix}-1`,
      title: "Sony WH-1000XM4 — SOLD listing",
      snippet: "Sold for $178.00 on Jun 1",
    },
    {
      url: `https://www.ebay.com/itm/${prefix}-2`,
      title: "Sony WH-1000XM4 (Black) — SOLD",
      snippet: "Sold for $185.50",
    },
    {
      url: `https://www.mercari.com/us/item/${prefix}-3`,
      title: "Sony WH-1000XM4 used",
      snippet: "Asking $199.99",
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

/** A fake extractor that serves the given comp batches, one per call. */
function fakeExtractor(batches: WebComp[][]): ExtractComps {
  let calls = 0;
  return async () => {
    const batch = batches[Math.min(calls, batches.length - 1)] ?? [];
    calls += 1;
    return batch;
  };
}

/** Sold comps that cite the canned q1 result URLs and agree tightly. */
function soldComps(prefix = "q1"): WebComp[] {
  return [
    { url: `https://www.ebay.com/itm/${prefix}-1`, title: "SOLD 1", price: 178, kind: "sold" },
    { url: `https://www.ebay.com/itm/${prefix}-2`, title: "SOLD 2", price: 185.5, kind: "sold" },
    { url: `https://www.mercari.com/us/item/${prefix}-3`, title: "asking", price: 199.99, kind: "asking" },
  ];
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("query formulation", () => {
  it("builds branded queries from brand + model and caps them at the iteration limit", () => {
    const queries = buildSearchQueries(BRANDED_SIGNAL, "branded-web");
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.length).toBeLessThanOrEqual(MAX_SEARCH_ITERATIONS);
    expect(queries[0]).toContain("Sony");
    expect(queries[0]).toContain("WH-1000XM4");
  });

  it("uses the UPC as a QUERY AID (in the query text) for the upc-aided tier", () => {
    const queries = buildSearchQueries(UPC_SIGNAL, "upc-aided-web");
    expect(queries[0]).toContain(UPC_SIGNAL.upc!);
    // The UPC-resolved name also seeds the query — identification, not pricing.
    expect(queries[0]).toContain("Sony WH-1000XM4");
  });

  it("returns no queries for an unidentifiable signal", () => {
    expect(buildSearchQueries({}, "branded-web")).toEqual([]);
  });

  it("prefers the resolved product name over a bare brand when no model exists", () => {
    const queries = buildSearchQueries(
      { brand: "Nike", resolvedName: "Nike Air Max 90 Men's Shoes" },
      "branded-web",
    );
    // "Nike used sold price" would be hopelessly broad; the resolved name
    // pins the exact product.
    expect(queries[0]).toContain("Nike Air Max 90");
    // Brand+model stays authoritative when both exist.
    const branded = buildSearchQueries(
      { ...BRANDED_SIGNAL, resolvedName: "Some Other Name" },
      "branded-web",
    );
    expect(branded[0]).toContain("WH-1000XM4");
    expect(branded[0]).not.toContain("Some Other Name");
  });
});

describe("branded-web pricing agent", () => {
  it("declares its tier and only handles branded signals", () => {
    const provider = createBrandedWebPricingProvider({
      searchClient: fakeSearch(),
      extractComps: fakeExtractor([soldComps()]),
    });
    expect(provider.tier).toBe("branded-web");
    expect(provider.canHandle?.(BRANDED_SIGNAL)).toBe(true);
    expect(provider.canHandle?.({ isbn: "9780140328721" })).toBe(false);
    expect(provider.canHandle?.({})).toBe(false);
  });

  it("declines a bare-brand signal: brand with neither model nor resolved name", async () => {
    // "Sony" alone does not identify a product. The broad queries it would
    // produce ("Sony used sold price") can surface two arbitrary same-brand
    // comps that satisfy MIN_USEFUL_COMPS and confidently price an
    // UNIDENTIFIED item — so the tier must decline (router falls through to
    // the estimate tiers) without spending any searches.
    const search = fakeSearch();
    const provider = createBrandedWebPricingProvider({
      searchClient: search,
      extractComps: fakeExtractor([soldComps()]),
    });
    const bareBrand: ItemSignal = { brand: "Sony", category: "electronics" };
    expect(provider.canHandle?.(bareBrand)).toBe(false);
    expect(await provider.price(bareBrand)).toBeNull();
    expect(search.queries.length).toBe(0); // declined before any search spend
    // Whitespace-only identifiers don't count as identification either.
    expect(provider.canHandle?.({ brand: "Sony", model: "  " })).toBe(false);
    expect(provider.canHandle?.({ brand: "Sony", resolvedName: " " })).toBe(false);
  });

  it("handles brand + resolved name (no model), composing with the resolved-name query preference", async () => {
    const search = fakeSearch();
    const provider = createBrandedWebPricingProvider({
      searchClient: search,
      extractComps: fakeExtractor([soldComps()]),
    });
    const signal: ItemSignal = {
      brand: "Nike",
      resolvedName: "Nike Air Max 90 Men's Shoes",
    };
    expect(provider.canHandle?.(signal)).toBe(true);
    const result = await provider.price(signal);
    expect(result).not.toBeNull();
    expect(result!.tier).toBe("branded-web");
    // The resolved name (not the bare brand) shaped the search.
    expect(search.queries[0]).toContain("Nike Air Max 90");
  });

  it("claims pricing-model provenance only when the extractor's model is KNOWN", async () => {
    // A custom extractor may use a different model — or no LLM at all — so
    // env/default resolution must never be claimed for it (#10 review). With
    // an injected extractor and no declared model, the result carries NO
    // model claim (→ pricing_model NULL in the log), even when PRICING_MODEL
    // is set in the environment.
    vi.stubEnv("PRICING_MODEL", "pricing-gpt-env");
    const branded = createBrandedWebPricingProvider({
      searchClient: fakeSearch(),
      extractComps: fakeExtractor([soldComps()]),
    });
    const result = await branded.price(BRANDED_SIGNAL);
    expect(result!.model).toBeUndefined();
    expect(() => priceResultSchema.parse(result)).not.toThrow();

    // An explicitly declared model IS valid provenance for a custom extractor.
    const upc = createUpcWebPricingProvider({
      searchClient: fakeSearch(),
      extractComps: fakeExtractor([soldComps()]),
      model: "pricing-gpt-override",
    });
    const upcResult = await upc.price(UPC_SIGNAL);
    expect(upcResult!.model).toBe("pricing-gpt-override");

    // The env/default resolution path (used by the DEFAULT extractor) still
    // resolves override → env → default.
    expect(resolvePricingModel("explicit")).toBe("explicit");
    expect(resolvePricingModel()).toBe("pricing-gpt-env");
    vi.unstubAllEnvs();
    expect(resolvePricingModel()).toBe(DEFAULT_PRICING_MODEL);
  });

  it("the search budget is shared across the web tiers: no branded re-run after a UPC decline", async () => {
    // A signal with BOTH a UPC and a brand/model is owned by the upc-aided
    // tier (whose query sequence subsumes the branded queries under one
    // budget). When it declines, the branded tier must decline too — never
    // re-spending searches on the identical queries.
    const signal: ItemSignal = { ...BRANDED_SIGNAL, upc: "027242920569" };
    const search = fakeSearch([cannedResults("q1")]);
    const neverEnough = fakeExtractor([[]]); // no usable comps, ever
    const upc = createUpcWebPricingProvider({
      searchClient: search,
      extractComps: neverEnough,
    });
    const branded = createBrandedWebPricingProvider({
      searchClient: search,
      extractComps: neverEnough,
    });

    expect(await upc.price(signal)).toBeNull(); // consumes the full budget
    expect(branded.canHandle?.(signal)).toBe(false); // router skips it
    expect(await branded.price(signal)).toBeNull(); // defensive: declines even if called
    // Total spend for the whole pricing request stays within the single cap.
    expect(search.queries.length).toBeLessThanOrEqual(MAX_SEARCH_ITERATIONS);
    // A UPC-less branded signal is still handled by the branded tier.
    expect(branded.canHandle?.(BRANDED_SIGNAL)).toBe(true);
  });

  it("prices a branded item with a cited range from web comps (URLs from the search results)", async () => {
    const search = fakeSearch();
    const provider = createBrandedWebPricingProvider({
      searchClient: search,
      extractComps: fakeExtractor([soldComps()]),
    });

    const result = await provider.price(BRANDED_SIGNAL);
    expect(result).not.toBeNull();
    expect(() => priceResultSchema.parse(result)).not.toThrow();
    expect(result!.tier).toBe("branded-web");

    // Cited: every source URL traces back to a real search hit.
    const resultUrls = cannedResults("q1").map((r) => r.url);
    expect(result!.sources.length).toBeGreaterThan(0);
    for (const s of result!.sources) {
      expect(resultUrls).toContain(s.url);
    }

    // Sold comps exist (2 ≥ MIN_USEFUL_COMPS) → they are the pricing basis:
    // suggested = median of sold prices, range = sold min..max.
    expect(result!.suggested).toBeCloseTo((178 + 185.5) / 2, 2);
    expect(result!.range.min).toBeCloseTo(178, 2);
    expect(result!.range.max).toBeCloseTo(185.5, 2);
    expect(result!.sources.some((s) => s.kind === "sold-comp")).toBe(true);
  });

  it("stops after ONE search when the first query already yields sufficient agreeing comps", async () => {
    const search = fakeSearch();
    const tightTrio: WebComp[] = [
      { url: "https://www.ebay.com/itm/q1-1", price: 180, kind: "sold" },
      { url: "https://www.ebay.com/itm/q1-2", price: 185, kind: "sold" },
      { url: "https://www.mercari.com/us/item/q1-3", price: 190, kind: "sold" },
    ];
    const provider = createBrandedWebPricingProvider({
      searchClient: search,
      extractComps: fakeExtractor([tightTrio]),
    });
    const result = await provider.price(BRANDED_SIGNAL);
    expect(result).not.toBeNull();
    expect(search.queries.length).toBe(1); // early stop — no wasted iterations
  });

  it("refines ONCE when the first search is thin, accumulating comps across iterations", async () => {
    const search = fakeSearch([cannedResults("q1"), cannedResults("q2")]);
    // First query: a single sold comp (not enough). Second: two more that agree.
    const provider = createBrandedWebPricingProvider({
      searchClient: search,
      extractComps: fakeExtractor([
        [{ url: "https://www.ebay.com/itm/q1-1", price: 178, kind: "sold" }],
        [
          { url: "https://www.ebay.com/itm/q2-1", price: 182, kind: "sold" },
          { url: "https://www.ebay.com/itm/q2-2", price: 186, kind: "sold" },
        ],
      ]),
    });
    const result = await provider.price(BRANDED_SIGNAL);
    expect(result).not.toBeNull();
    expect(search.queries.length).toBe(2); // refined exactly once, then satisfied
    expect(result!.sources.length).toBe(3); // comps accumulated across iterations
  });

  it("is HARD-CAPPED at MAX_SEARCH_ITERATIONS searches even when never satisfied", async () => {
    // The UPC signal formulates the FULL query sequence (UPC-aided + 2 refinements),
    // and the extractor never finds anything — without the cap the agent would keep
    // searching. It must stop at exactly MAX_SEARCH_ITERATIONS and decline.
    const search = fakeSearch([
      cannedResults("q1"),
      cannedResults("q2"),
      cannedResults("q3"),
      cannedResults("q4"),
    ]);
    const provider = createUpcWebPricingProvider({
      searchClient: search,
      extractComps: fakeExtractor([[]]),
    });
    const result = await provider.price(UPC_SIGNAL);
    expect(result).toBeNull(); // nothing useful → decline
    expect(search.queries.length).toBe(MAX_SEARCH_ITERATIONS);
  });

  it("clamps an over-eager maxIterations option to the hard cap (and honors a lower one)", async () => {
    const run = async (maxIterations: number): Promise<number> => {
      const search = fakeSearch([
        cannedResults("q1"),
        cannedResults("q2"),
        cannedResults("q3"),
        cannedResults("q4"),
      ]);
      const provider = createUpcWebPricingProvider({
        searchClient: search,
        extractComps: fakeExtractor([[]]),
        maxIterations,
      });
      await provider.price(UPC_SIGNAL);
      return search.queries.length;
    };
    expect(await run(10)).toBe(MAX_SEARCH_ITERATIONS); // clamped down to the cap
    expect(await run(1)).toBe(1); // a tighter budget is respected
  });

  it("asking-only comps emit ONLY asking-comp sources (never sold-comp) with lower confidence", async () => {
    const askingOnly: WebComp[] = [
      { url: "https://www.ebay.com/itm/q1-1", price: 180, kind: "asking" },
      { url: "https://www.ebay.com/itm/q1-2", price: 185, kind: "asking" },
      { url: "https://www.mercari.com/us/item/q1-3", price: 190, kind: "asking" },
    ];
    const soldEquivalent: WebComp[] = askingOnly.map((c) => ({
      ...c,
      kind: "sold" as const,
    }));

    const priceWith = async (comps: WebComp[]): Promise<PriceResult> => {
      const provider = createBrandedWebPricingProvider({
        searchClient: fakeSearch(),
        extractComps: fakeExtractor([comps]),
      });
      const r = await provider.price(BRANDED_SIGNAL);
      expect(r).not.toBeNull();
      return r!;
    };

    const asking = await priceWith(askingOnly);
    const sold = await priceWith(soldEquivalent);

    // The structural down-weight: no sold-comp kind anywhere → the pipeline's
    // existing branded-web mapping resolves to web_wide, not web_tight.
    expect(asking.sources.every((s) => s.kind === "asking-comp")).toBe(true);
    expect(asking.sources.some((s) => s.kind === "sold-comp")).toBe(false);
    // And the provisional confidence is itself down-weighted vs sold grounding.
    expect(asking.confidence).toBeLessThan(sold.confidence);
  });

  it("a lone sold comp inside a mixed asking-basis set never leaks sold-comp sources", async () => {
    // One sold comp (< MIN_USEFUL_COMPS) + asking comps → the price is
    // synthesized on the MIXED basis at asking-level confidence, so no source
    // may claim "sold-comp" — otherwise the pipeline's branded-web mapping
    // would grant web_tight (autopilot-grade) confidence to an asking result.
    const mixed: WebComp[] = [
      { url: "https://www.ebay.com/itm/q1-1", price: 180, kind: "sold" },
      { url: "https://www.ebay.com/itm/q1-2", price: 185, kind: "asking" },
      { url: "https://www.mercari.com/us/item/q1-3", price: 190, kind: "asking" },
    ];
    const provider = createBrandedWebPricingProvider({
      searchClient: fakeSearch(),
      extractComps: fakeExtractor([mixed]),
    });
    const result = await provider.price(BRANDED_SIGNAL);
    expect(result).not.toBeNull();
    expect(result!.sources.length).toBeGreaterThan(0);
    expect(result!.sources.every((s) => s.kind === "asking-comp")).toBe(true);
    expect(result!.sources.some((s) => s.kind === "sold-comp")).toBe(false);
  });

  it("confidence reflects comp agreement: a tight cluster beats a wide scatter", async () => {
    const tight: WebComp[] = [
      { url: "https://www.ebay.com/itm/q1-1", price: 180, kind: "sold" },
      { url: "https://www.ebay.com/itm/q1-2", price: 185, kind: "sold" },
      { url: "https://www.mercari.com/us/item/q1-3", price: 190, kind: "sold" },
    ];
    const scattered: WebComp[] = [
      { url: "https://www.ebay.com/itm/q1-1", price: 60, kind: "sold" },
      { url: "https://www.ebay.com/itm/q1-2", price: 185, kind: "sold" },
      { url: "https://www.mercari.com/us/item/q1-3", price: 420, kind: "sold" },
    ];
    const priceWith = async (comps: WebComp[]) => {
      const provider = createBrandedWebPricingProvider({
        searchClient: fakeSearch(),
        extractComps: fakeExtractor([comps]),
      });
      return (await provider.price(BRANDED_SIGNAL))!;
    };
    const a = await priceWith(tight);
    const b = await priceWith(scattered);
    expect(a.confidence).toBeGreaterThan(b.confidence);
  });

  it("drops hallucinated comps whose URL is not among the search results", async () => {
    const provider = createBrandedWebPricingProvider({
      searchClient: fakeSearch(),
      extractComps: fakeExtractor([
        [
          // Real citation + a fabricated URL the search never returned.
          { url: "https://www.ebay.com/itm/q1-1", price: 178, kind: "sold" },
          { url: "https://evil.example.com/made-up", price: 9999, kind: "sold" },
        ],
      ]),
    });
    const result = await provider.price(BRANDED_SIGNAL);
    // Only 1 verifiable comp survives (< MIN_USEFUL_COMPS) → decline.
    expect(MIN_USEFUL_COMPS).toBeGreaterThan(1);
    expect(result).toBeNull();
  });

  it("declines (null) when no useful comps are found, so the router falls through", async () => {
    const webProvider = createBrandedWebPricingProvider({
      searchClient: fakeSearch(),
      extractComps: fakeExtractor([[]]),
    });
    const fallback = {
      tier: "llm-only" as const,
      price: async () => ({
        suggested: 50,
        range: { min: 30, max: 70 },
        confidence: 0.2,
        sources: [],
        tier: "llm-only" as const,
      }),
    };
    const router = new PriceRouter([webProvider, fallback]);
    const result = await router.price(BRANDED_SIGNAL);
    expect(result.tier).toBe("llm-only"); // fell through past the web tier
  });

  it("declines instead of hard-failing when no search keys are configured (default client)", async () => {
    vi.stubEnv("TAVILY_API_KEY", "");
    vi.stubEnv("EXA_API_KEY", "");
    // No injected client → the provider must notice the keyless environment
    // and decline without any network call.
    const provider = createBrandedWebPricingProvider({
      extractComps: fakeExtractor([soldComps()]),
    });
    const result = await provider.price(BRANDED_SIGNAL);
    expect(result).toBeNull();
  });

  it("propagates a search-client failure as a thrown error (hard error, not a decline)", async () => {
    const provider = createBrandedWebPricingProvider({
      searchClient: {
        search: async () => {
          throw new Error("search upstream 503");
        },
      },
      extractComps: fakeExtractor([soldComps()]),
    });
    await expect(provider.price(BRANDED_SIGNAL)).rejects.toThrow(/503/);
  });
});

describe("upc-aided-web pricing agent", () => {
  it("declares its tier and only handles UPC-bearing signals", () => {
    const provider = createUpcWebPricingProvider({
      searchClient: fakeSearch(),
      extractComps: fakeExtractor([soldComps()]),
    });
    expect(provider.tier).toBe("upc-aided-web");
    expect(provider.canHandle?.(UPC_SIGNAL)).toBe(true);
    expect(provider.canHandle?.(BRANDED_SIGNAL)).toBe(false);
  });

  it("prices via web comps with the UPC riding in the query as an identification aid", async () => {
    const search = fakeSearch();
    const provider = createUpcWebPricingProvider({
      searchClient: search,
      extractComps: fakeExtractor([soldComps()]),
    });
    const result = await provider.price(UPC_SIGNAL);

    expect(result).not.toBeNull();
    expect(result!.tier).toBe("upc-aided-web");
    expect(() => priceResultSchema.parse(result)).not.toThrow();
    // The UPC shaped the SEARCH, not the price: it appears in the query…
    expect(search.queries[0]).toContain(UPC_SIGNAL.upc!);
    // …while the price comes from the cited web comps (sold basis median).
    expect(result!.suggested).toBeCloseTo((178 + 185.5) / 2, 2);
    expect(result!.sources.every((s) => s.url.startsWith("https://"))).toBe(true);
  });
});

describe("web tiers wired into the PriceRouter", () => {
  const fallback = {
    tier: "llm-only" as const,
    price: async () => ({
      suggested: 5,
      range: { min: 1, max: 10 },
      confidence: 0.1,
      sources: [],
      tier: "llm-only" as const,
    }),
  };

  it("routes a UPC+brand signal to the upc-aided tier first (PRD priority order)", async () => {
    const upc = createUpcWebPricingProvider({
      searchClient: fakeSearch(),
      extractComps: fakeExtractor([soldComps()]),
    });
    const branded = createBrandedWebPricingProvider({
      searchClient: fakeSearch(),
      extractComps: fakeExtractor([soldComps()]),
    });
    const router = new PriceRouter([upc, branded, fallback]);
    const result = await router.price({ ...BRANDED_SIGNAL, upc: "027242920569" });
    expect(result.tier).toBe("upc-aided-web");
  });

  it("falls through upc-aided → estimate tiers (NOT a branded re-run) when the UPC search finds nothing useful", async () => {
    // The UPC tier's query sequence already includes the branded refinements
    // under its single budget. When even that finds nothing, re-running the
    // identical branded queries would double the search spend for the same
    // evidence — so the router skips branded and lands on the estimate tier.
    const search = fakeSearch();
    const upc = createUpcWebPricingProvider({
      searchClient: search,
      extractComps: fakeExtractor([[]]), // full web route: nothing useful
    });
    const branded = createBrandedWebPricingProvider({
      searchClient: search,
      extractComps: fakeExtractor([soldComps()]),
    });
    const router = new PriceRouter([upc, branded, fallback]);
    const result = await router.price({ ...BRANDED_SIGNAL, upc: "027242920569" });
    expect(result.tier).toBe("llm-only");
    expect(search.queries.length).toBeLessThanOrEqual(MAX_SEARCH_ITERATIONS);
  });
});
