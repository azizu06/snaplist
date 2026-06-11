import { z } from "zod";
import type {
  ItemSignal,
  PriceResult,
  PriceSource,
  PricingProvider,
  PricingTier,
} from "../types";

/**
 * Tiers 2 + 3 — the web-search pricing agent (`upc-aided-web` / `branded-web`),
 * issue #10.
 *
 * PRD §"Pricing pipeline": a recognizable branded item is priced from REAL web
 * comps; a decoded UPC is an *identification/query aid* feeding the same agent
 * (never a price oracle — the barcode-tier split, AGENTS.md).
 *
 * The agent is a BOUNDED tool-calling loop:
 *
 *   formulate targeted queries from the identified attributes (brand, model,
 *   UPC, resolved name) → search the web (Tavily primary, Exa secondary) →
 *   extract concrete price comps from the results (LLM, structured output) →
 *   judge coverage/agreement → optionally refine with the next query →
 *   synthesize a cited price range.
 *
 * Hard caps: at most `MAX_SEARCH_ITERATIONS` (3) searches per pricing call,
 * with an early stop as soon as coverage + agreement are good enough. When no
 * useful comps surface the agent DECLINES (returns `null`) so the router falls
 * through to the depreciation / LLM tiers — it never fabricates a number.
 *
 * Confidence honesty: comps are classified `sold` vs `asking`. Only a price
 * grounded in SOLD comps cites `kind: "sold-comp"` sources; an asking-only
 * result cites `kind: "asking-comp"` and reports lower provisional confidence,
 * so the pipeline's tier→confidence mapping (`branded-web` → `web_tight` ONLY
 * with a sold comp, else `web_wide`) down-weights it for autopilot gating.
 *
 * Every network/model dependency is INJECTED (same DI style as
 * `providers/isbn.ts` and `listing/generate.ts`): `SearchClient` for the web
 * search and `ExtractComps` for the model call. Tests run fully offline with
 * fakes; the real defaults read TAVILY_API_KEY / EXA_API_KEY / OPENAI_API_KEY
 * lazily at call time.
 */

// ---------------------------------------------------------------------------
// Injected search seam
// ---------------------------------------------------------------------------

/** One raw web search hit handed to the comp extractor. */
export interface SearchResult {
  /** Canonical URL of the hit — comps must cite one of these. */
  url: string;
  /** Page/listing title. */
  title?: string;
  /** Text snippet/content the search API returned for the hit. */
  snippet?: string;
}

/**
 * The injectable web-search client. Real implementations call the Tavily/Exa
 * HTTP APIs; tests inject a fake. Throwing signals an upstream failure (hard
 * error per the router contract), not a decline.
 */
export interface SearchClient {
  search(query: string): Promise<SearchResult[]>;
}

/** Are any web-search API keys configured? (Read lazily — never at import.) */
export function webSearchConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env.TAVILY_API_KEY?.trim() || env.EXA_API_KEY?.trim());
}

/** Minimal shapes of the two search APIs' responses (defensive — only what we read). */
interface TavilyResponse {
  results?: Array<{ url?: string; title?: string; content?: string }>;
}
interface ExaResponse {
  results?: Array<{ url?: string; title?: string; text?: string }>;
}

const SEARCH_RESULT_LIMIT = 8;

async function tavilySearch(
  apiKey: string,
  query: string,
): Promise<SearchResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, max_results: SEARCH_RESULT_LIMIT }),
  });
  if (!res.ok) {
    throw new Error(`Tavily search failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as TavilyResponse;
  return (body.results ?? [])
    .filter((r): r is { url: string; title?: string; content?: string } =>
      typeof r.url === "string" && r.url.length > 0,
    )
    .map((r) => ({ url: r.url, title: r.title, snippet: r.content }));
}

async function exaSearch(
  apiKey: string,
  query: string,
): Promise<SearchResult[]> {
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      query,
      numResults: SEARCH_RESULT_LIMIT,
      contents: { text: true },
    }),
  });
  if (!res.ok) {
    throw new Error(`Exa search failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as ExaResponse;
  return (body.results ?? [])
    .filter((r): r is { url: string; title?: string; text?: string } =>
      typeof r.url === "string" && r.url.length > 0,
    )
    .map((r) => ({ url: r.url, title: r.title, snippet: r.text }));
}

/**
 * The default `SearchClient`: Tavily primary (TAVILY_API_KEY), Exa secondary
 * (EXA_API_KEY). Keys are read LAZILY at search time, never at import/build.
 * A Tavily failure falls back to Exa when both are configured; with neither
 * key the client throws — the provider guards with `webSearchConfigured` and
 * declines instead, so a keyless deployment degrades to the lower tiers.
 */
export function createDefaultSearchClient(): SearchClient {
  return {
    async search(query: string): Promise<SearchResult[]> {
      const tavilyKey = process.env.TAVILY_API_KEY?.trim();
      const exaKey = process.env.EXA_API_KEY?.trim();
      if (!tavilyKey && !exaKey) {
        throw new Error(
          "Web-search pricing needs TAVILY_API_KEY or EXA_API_KEY",
        );
      }
      if (tavilyKey) {
        try {
          return await tavilySearch(tavilyKey, query);
        } catch (err) {
          if (!exaKey) throw err;
          // Tavily down → secondary provider keeps the tier alive.
        }
      }
      return exaSearch(exaKey!, query);
    },
  };
}

// ---------------------------------------------------------------------------
// Injected comp-extraction seam (the LLM call)
// ---------------------------------------------------------------------------

/** A concrete price comp the extractor pulled out of the search results. */
export const webCompSchema = z.object({
  /** Must be one of the search-result URLs (enforced post-hoc — anti-hallucination). */
  url: z.string().min(1),
  title: z.string().optional(),
  /** The comp's USD price. */
  price: z.number().positive(),
  /** SOLD (completed sale) vs ASKING (active listing) — drives confidence. */
  kind: z.enum(["sold", "asking"]),
});

export type WebComp = z.infer<typeof webCompSchema>;

const webCompListSchema = z.object({ comps: z.array(webCompSchema) });

/**
 * The injectable model call: given the item identity, the query, and the raw
 * search results, return the concrete price comps found (possibly none). The
 * real default drives `generateObject` (like `listing/generate.ts`); tests
 * pass a fake. Throwing is an upstream failure, not a decline.
 */
export type ExtractComps = (args: {
  signal: ItemSignal;
  query: string;
  results: SearchResult[];
}) => Promise<WebComp[]>;

/**
 * Current strong text model for comp extraction (overridable via
 * `PRICING_MODEL` — AGENTS.md "env-configurable everything").
 */
export const DEFAULT_PRICING_MODEL = "gpt-5.5";

const EXTRACT_SYSTEM_PROMPT =
  "You extract comparable resale prices for a SPECIFIC second-hand item from web " +
  "search results. Return only comps that clearly refer to the same product " +
  "(matching brand/model/UPC). For each comp give the USD price, the source URL " +
  "(it MUST be one of the provided result URLs, verbatim), and whether it is a " +
  "completed/sold sale ('sold') or an active asking-price listing ('asking'). " +
  "Skip retail/new prices, accessories, parts-only listings, and anything you " +
  "cannot tie to a concrete dollar amount. Return an empty list when nothing fits.";

/**
 * Build the real comp extractor: a lazy wrapper around the AI SDK's
 * `generateObject` with the `webCompListSchema`. Imported lazily (matching
 * `extract.ts` / `generate.ts`) so the SDK never loads on the offline test path.
 */
export function createOpenAICompExtractor(
  apiKey: string | undefined = process.env.OPENAI_API_KEY,
  model?: string,
): ExtractComps {
  return async ({ signal, query, results }) => {
    const [{ generateObject }, { createOpenAI }] = await Promise.all([
      import("ai"),
      import("@ai-sdk/openai"),
    ]);
    const openai = createOpenAI(apiKey ? { apiKey } : {});
    const modelId =
      model?.trim() ||
      process.env.PRICING_MODEL?.trim() ||
      DEFAULT_PRICING_MODEL;

    const identity = JSON.stringify(
      {
        brand: signal.brand,
        model: signal.model,
        upc: signal.upc,
        category: signal.category,
        condition: signal.condition,
        resolvedName: signal.resolvedName,
      },
      null,
      2,
    );
    const hits = results
      .map(
        (r, i) =>
          `Result ${i + 1}:\nurl: ${r.url}\ntitle: ${r.title ?? ""}\nsnippet: ${r.snippet ?? ""}`,
      )
      .join("\n\n");

    const { object } = await generateObject({
      model: openai.chat(modelId),
      schema: webCompListSchema,
      system: EXTRACT_SYSTEM_PROMPT,
      prompt: `Item identity:\n${identity}\n\nSearch query: ${query}\n\nSearch results:\n${hits}`,
    });
    return object.comps;
  };
}

// ---------------------------------------------------------------------------
// Query formulation — deterministic, from the identified attributes
// ---------------------------------------------------------------------------

/**
 * Formulate the targeted query sequence for a signal. Query 1 is the primary
 * identification; later entries are the bounded refinements the agent may try
 * when coverage/agreement is judged insufficient. For the UPC-aided tier the
 * UPC rides IN the queries as an identification aid — the prices still come
 * from the extracted web comps, never from the barcode itself.
 */
export function buildSearchQueries(
  signal: ItemSignal,
  tier: Extract<PricingTier, "upc-aided-web" | "branded-web">,
): string[] {
  const branded = [signal.brand, signal.model].filter(Boolean).join(" ").trim();
  const resolved = signal.resolvedName?.trim() ?? "";
  // Brand+model is the most precise identity. Without a model, a resolved
  // product name ("Nike Air Max 90 Men's Shoes") identifies the item far
  // better than a bare brand ("Nike"), so prefer it when available.
  const fullyBranded = signal.brand && signal.model ? branded : "";
  const name = fullyBranded || resolved || branded;
  const category = signal.category?.trim();

  const queries: string[] = [];
  if (tier === "upc-aided-web" && signal.upc) {
    // UPC as the identification/query aid: pin the exact product first.
    queries.push(
      [`UPC ${signal.upc.trim()}`, name, "used price"]
        .filter(Boolean)
        .join(" "),
    );
  }
  if (name) {
    queries.push(`${name} used sold price`);
    queries.push(
      [name, category, "resale listing price"].filter(Boolean).join(" "),
    );
  }
  // Dedupe while preserving order, and never exceed the iteration cap.
  return [...new Set(queries)].slice(0, MAX_SEARCH_ITERATIONS);
}

// ---------------------------------------------------------------------------
// Judge + synthesis — deterministic over the extracted comps
// ---------------------------------------------------------------------------

/** Hard cap on web searches per pricing call (issue #10: "~2–3 iterations"). */
export const MAX_SEARCH_ITERATIONS = 3;

/** Fewer than this many usable comps = "nothing useful" → decline. */
export const MIN_USEFUL_COMPS = 2;

/** Early-stop coverage: this many comps with tight agreement ends the loop. */
const SUFFICIENT_COMPS = 3;

/** Relative spread ((max−min)/median) at or under this counts as tight agreement. */
const TIGHT_SPREAD = 0.5;

function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface CompJudgement {
  /** The comps the price is actually based on (sold preferred when plentiful). */
  basis: WebComp[];
  /** Did the basis come from sold comps? */
  soldBasis: boolean;
  /** Relative spread of the basis prices — the comp-agreement signal. */
  spread: number;
}

/**
 * Judge the accumulated comps: prefer SOLD comps as the pricing basis when at
 * least `MIN_USEFUL_COMPS` of them exist (sold sales are the ground truth);
 * otherwise fall back to everything found. Agreement = relative price spread.
 */
function judgeComps(comps: readonly WebComp[]): CompJudgement {
  const sold = comps.filter((c) => c.kind === "sold");
  const soldBasis = sold.length >= MIN_USEFUL_COMPS;
  const basis = soldBasis ? sold : [...comps];
  const prices = basis.map((c) => c.price).sort((a, b) => a - b);
  const mid = prices.length > 0 ? median(prices) : 0;
  const spread =
    prices.length > 1 && mid > 0
      ? (prices[prices.length - 1] - prices[0]) / mid
      : 0;
  return { basis, soldBasis, spread };
}

/** Is coverage + agreement good enough to stop searching early? */
function sufficient(j: CompJudgement): boolean {
  return j.basis.length >= SUFFICIENT_COMPS && j.spread <= TIGHT_SPREAD;
}

/**
 * Synthesize the cited `PriceResult` from the judged comps. Suggested = median
 * of the basis prices; range = the basis min..max band. Provisional confidence
 * is honest about evidence quality: sold-comp grounding scores well above
 * asking-only, and tight agreement above scatter — the asking-only down-weight
 * also flows structurally through `sources[].kind` (only sold comps emit
 * `"sold-comp"`, which is what the pipeline's web_tight mapping requires).
 */
function synthesize(
  comps: readonly WebComp[],
  tier: Extract<PricingTier, "upc-aided-web" | "branded-web">,
): PriceResult {
  const j = judgeComps(comps);
  const prices = j.basis.map((c) => c.price).sort((a, b) => a - b);
  const suggested = median(prices);
  const min = prices[0];
  const max = prices[prices.length - 1];

  // Sold comps ground the price → meaningfully higher trust than asking-only.
  // Agreement (tight spread) and coverage (4+ comps) add smaller bumps.
  const base = j.soldBasis ? 0.65 : 0.4;
  const agreementBonus = j.spread <= TIGHT_SPREAD ? 0.1 : 0;
  const coverageBonus = j.basis.length >= 4 ? 0.05 : 0;
  const confidence = Math.min(0.85, base + agreementBonus + coverageBonus);

  const sources: PriceSource[] = j.basis.map((c) => ({
    url: c.url,
    title: c.title,
    // The load-bearing kind vocabulary: "sold-comp" may only appear when the
    // synthesized price is actually sold-grounded (j.soldBasis — and then the
    // basis is sold comps only). A lone sold entry inside a mixed asking-basis
    // set must NOT leak "sold-comp", or the pipeline's web_tight mapping would
    // grant autopilot-grade confidence to an asking-priced result.
    kind: j.soldBasis ? "sold-comp" : "asking-comp",
  }));

  return {
    suggested: round2(suggested),
    range: { min: round2(min), max: round2(max) },
    confidence,
    sources,
    tier,
  };
}

// ---------------------------------------------------------------------------
// The bounded agent loop + provider factories
// ---------------------------------------------------------------------------

export interface WebSearchPricingProviderOptions {
  /** Injected search client; defaults to Tavily-primary / Exa-secondary over env keys. */
  searchClient?: SearchClient;
  /** Injected comp extraction (the model call); defaults to the real `generateObject` wrapper. */
  extractComps?: ExtractComps;
  /** Search-iteration cap; clamped to [1, MAX_SEARCH_ITERATIONS]. */
  maxIterations?: number;
  /** Model id override forwarded to the default extractor (else `PRICING_MODEL` env). */
  model?: string;
}

interface ResolvedDeps {
  searchClient: SearchClient;
  extractComps: ExtractComps;
  maxIterations: number;
  /** When true (default deps from env), decline instead of searching keyless. */
  requireEnvKeys: boolean;
}

function resolveDeps(options: WebSearchPricingProviderOptions): ResolvedDeps {
  return {
    searchClient: options.searchClient ?? createDefaultSearchClient(),
    extractComps:
      options.extractComps ??
      createOpenAICompExtractor(undefined, options.model),
    maxIterations: Math.max(
      1,
      Math.min(options.maxIterations ?? MAX_SEARCH_ITERATIONS, MAX_SEARCH_ITERATIONS),
    ),
    // Only the DEFAULT client depends on env keys; an injected client is
    // self-sufficient and must not be gated on the environment.
    requireEnvKeys: options.searchClient == null,
  };
}

/**
 * The agent core shared by both web tiers: bounded query → search → extract →
 * judge loop, then synthesis or decline.
 */
async function priceViaWebAgent(
  tier: Extract<PricingTier, "upc-aided-web" | "branded-web">,
  signal: ItemSignal,
  deps: ResolvedDeps,
): Promise<PriceResult | null> {
  // Keyless deployment → this tier is simply unavailable; degrade gracefully
  // to the lower tiers instead of hard-failing the whole pricing call.
  if (deps.requireEnvKeys && !webSearchConfigured()) return null;

  const queries = buildSearchQueries(signal, tier);
  if (queries.length === 0) return null; // Nothing identifiable to search for.

  const comps: WebComp[] = [];
  const seenUrls = new Set<string>();
  let iterations = 0;

  for (const query of queries) {
    if (iterations >= deps.maxIterations) break; // The hard cap.
    iterations += 1;

    const results = await deps.searchClient.search(query);
    if (results.length > 0) {
      const extracted = await deps.extractComps({ signal, query, results });
      const allowedUrls = new Set(results.map((r) => r.url));
      for (const comp of extracted) {
        // Anti-hallucination: a comp must cite one of THIS search's result
        // URLs, carry a positive price, and not duplicate an earlier comp.
        if (!allowedUrls.has(comp.url)) continue;
        if (!(comp.price > 0)) continue;
        if (seenUrls.has(comp.url)) continue;
        seenUrls.add(comp.url);
        comps.push(comp);
      }
    }

    // Judge coverage/agreement: stop early when good enough; otherwise the
    // loop refines with the next targeted query (bounded by the cap).
    if (sufficient(judgeComps(comps))) break;
  }

  // "Nothing useful" → decline so the router falls through to lower tiers.
  if (comps.length < MIN_USEFUL_COMPS) return null;

  return synthesize(comps, tier);
}

/**
 * Tier 2 — `upc-aided-web`: a decoded UPC feeds the web-search agent as an
 * identification/query aid. Requires a UPC on the signal.
 */
export function createUpcWebPricingProvider(
  options: WebSearchPricingProviderOptions = {},
): PricingProvider {
  const deps = resolveDeps(options);
  return {
    tier: "upc-aided-web",
    canHandle(signal: ItemSignal): boolean {
      return typeof signal.upc === "string" && signal.upc.trim().length > 0;
    },
    async price(signal: ItemSignal): Promise<PriceResult | null> {
      if (!signal.upc?.trim()) return null;
      return priceViaWebAgent("upc-aided-web", signal, deps);
    },
  };
}

/**
 * Tier 3 — `branded-web`: a recognizable branded item priced from real web
 * comps. Requires at least a brand on the signal — and NO UPC: a UPC-bearing
 * signal is owned by the upc-aided tier, whose query sequence already contains
 * these branded queries as refinements under the SAME iteration budget. If the
 * UPC tier declined, re-running the identical branded queries here would only
 * double the search/extraction spend (up to 5 calls for one pricing request)
 * for the same evidence, so this tier declines too and the router falls
 * through to the estimate tiers.
 */
export function createBrandedWebPricingProvider(
  options: WebSearchPricingProviderOptions = {},
): PricingProvider {
  const deps = resolveDeps(options);
  const ownedByUpcTier = (signal: ItemSignal): boolean =>
    typeof signal.upc === "string" && signal.upc.trim().length > 0;
  return {
    tier: "branded-web",
    canHandle(signal: ItemSignal): boolean {
      return (
        typeof signal.brand === "string" &&
        signal.brand.trim().length > 0 &&
        !ownedByUpcTier(signal)
      );
    },
    async price(signal: ItemSignal): Promise<PriceResult | null> {
      if (!signal.brand?.trim() || ownedByUpcTier(signal)) return null;
      return priceViaWebAgent("branded-web", signal, deps);
    },
  };
}
