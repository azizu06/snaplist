import { z } from "zod";
import type {
  ItemSignal,
  PriceResult,
  PriceSource,
  PricingProvider,
  PricingTier,
} from "../types";
import { resolveLanguageModel, resolveModelId } from "../../llm";

/**
 * Tiers 3 + 4 — the web-search pricing agent (`upc-aided-web` / `branded-web`),
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
 * with a sold comp, else `web_wide`) down-weights it for publish eligibility.
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

/**
 * Hard cap on each result's snippet text. Exa's `contents.text` returns FULL
 * page text (a long page or PDF can be hundreds of KB), and up to
 * SEARCH_RESULT_LIMIT results feed the extraction prompt on each of up to
 * MAX_SEARCH_ITERATIONS iterations — unbounded, a single upload could blow
 * the model context window (and the token bill). Comps are short price lines;
 * this is plenty of signal per result.
 */
const SNIPPET_MAX_CHARS = 1500;

/** Exported for the depreciation tier's retail extractor — same budget rationale. */
export function truncateSnippet(text: string | undefined): string | undefined {
  if (text == null || text.length <= SNIPPET_MAX_CHARS) return text;
  return text.slice(0, SNIPPET_MAX_CHARS);
}

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
    .map((r) => ({ url: r.url, title: r.title, snippet: truncateSnippet(r.content) }));
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
      // Ask Exa for BOUNDED text up front (full page text can be hundreds of
      // KB); the map below re-truncates defensively either way.
      contents: { text: { maxCharacters: SNIPPET_MAX_CHARS } },
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
    .map((r) => ({ url: r.url, title: r.title, snippet: truncateSnippet(r.text) }));
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

/**
 * A concrete price comp the extractor pulled out of the search results — the
 * INTERNAL shape every consumer downstream (judge, synthesis, `PriceSource`)
 * reads. A comp whose page carried no usable title simply has no `title`, which
 * is what `PriceSource.title` (also optional) expects.
 */
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

/**
 * The MODEL-FACING comp shape (issue #696) — the permissive half of the same
 * permissive/strict split `listing/schema.ts` uses, and the schema actually
 * handed to `generateObject`.
 *
 * `title` may NOT be `.optional()` here: `generateObject` compiles this to JSON
 * Schema, and OpenAI structured outputs in strict mode reject any object whose
 * `properties` carry a key absent from `required` — the request 400s before a
 * single token, taking the whole web-search pricing tier (and with it every item
 * whose pricing falls through to it) down. So the KEY is always required and the
 * model says "this result had no title" in the VALUE, as `null`.
 *
 * `webCompFromRaw` performs the deterministic repair back to the internal shape,
 * exactly as `itemSpecificsFromPairs` does for the listing role.
 */
export const rawWebCompSchema = z.object({
  url: z.string().min(1),
  /** Page/listing title, or `null` when the result carries none. */
  title: z.string().nullable(),
  price: z.number().positive(),
  kind: z.enum(["sold", "asking"]),
});

export type RawWebComp = z.infer<typeof rawWebCompSchema>;

/**
 * The exact object `generateObject` is given for the `pricingAgent` role — and
 * therefore the artifact the role-contract guard must walk. Exported so
 * `llm/contracts.ts` names THIS schema rather than reconstructing an
 * equivalent-looking one that could silently drift from it.
 */
export const webCompListSchema = z.object({ comps: z.array(rawWebCompSchema) });

/**
 * Deterministic normalization from the model-facing comp to the internal one:
 * a `null` (or blank/whitespace) title means "no title", so the key is dropped
 * rather than carried through as an empty string that would surface as an empty
 * source label in the seller-visible evidence list.
 */
export function webCompFromRaw(raw: RawWebComp): WebComp {
  const title = raw.title?.trim();
  return {
    url: raw.url,
    price: raw.price,
    kind: raw.kind,
    ...(title ? { title } : {}),
  };
}

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

/**
 * Resolve the pricing model id (override → `PRICING_MODEL` env → default).
 * Read lazily at call time, never at import — same rule as the search keys.
 * This is the single resolution used BOTH by the default extractor and for the
 * `PriceResult.model` provenance, so the logged model can never drift from the
 * one that actually extracted the comps.
 */
export function resolvePricingModel(model?: string): string {
  return resolveModelId("pricingAgent", { modelId: model });
}

const EXTRACT_SYSTEM_PROMPT =
  "You extract comparable resale prices for a SPECIFIC second-hand item from web " +
  "search results. Return only comps that clearly refer to the same product " +
  "(matching brand/model/UPC). For each comp give the USD price, the source URL " +
  "(it MUST be one of the provided result URLs, verbatim), and whether it is a " +
  "completed/sold sale ('sold') or an active asking-price listing ('asking'). " +
  "Give the result's title, or null when it has none — never invent one. " +
  "Skip retail/new prices, accessories, parts-only listings, and anything you " +
  "cannot tie to a concrete dollar amount. Return an empty list when nothing fits.";

/**
 * Build the real comp extractor: a lazy wrapper around the AI SDK's
 * `generateObject` with the `webCompListSchema`. Imported lazily (matching
 * `extract.ts` / `generate.ts`) so the SDK never loads on the offline test path.
 */
export function createOpenAICompExtractor(
  apiKey: string | undefined = undefined,
  model?: string,
): ExtractComps {
  return async ({ signal, query, results }) => {
    const { generateObject } = await import("ai");
    const llmModel = await resolveLanguageModel("pricingAgent", {
      modelId: model,
      apiKey,
    });

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
    // Re-truncate at the prompt boundary too: injected SearchClients bypass
    // the default providers' caps, and the context window is THIS call's
    // budget to protect.
    const hits = results
      .map(
        (r, i) =>
          `Result ${i + 1}:\nurl: ${r.url}\ntitle: ${r.title ?? ""}\nsnippet: ${truncateSnippet(r.snippet) ?? ""}`,
      )
      .join("\n\n");

    const { object } = await generateObject({
      model: llmModel,
      schema: webCompListSchema,
      system: EXTRACT_SYSTEM_PROMPT,
      prompt: `Item identity:\n${identity}\n\nSearch query: ${query}\n\nSearch results:\n${hits}`,
    });
    // Deterministic repair back to the internal comp shape: `title: null` (the
    // only way strict mode lets the model say "no title") becomes an absent key.
    return object.comps.map(webCompFromRaw);
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
  // Top specs narrow the query so comps cluster on the SAME configuration (a
  // "Helios 300" ships as i5/i7, 1660Ti/RTX — without specs the comps span configs
  // and comp-agreement collapses). Cap at 3: more over-narrows and the search returns
  // nothing; the broad queries below stay as a fallback so coverage is never lost.
  const specsHint = (signal.specs ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");

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
    // Narrowed-by-specs query FIRST (same brand+model AND key specs → comps on the
    // same configuration), then the broader queries as a coverage fallback.
    if (specsHint) {
      queries.push(`${name} ${specsHint} used sold price`);
    }
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

/**
 * Map a judged relative spread onto the 0–1 comp-agreement scale the
 * confidence composite consumes: `agreement = clamp01(1 - spread)`. Lockstep
 * comps (spread 0) → 1; spread at TIGHT_SPREAD (0.5) → 0.5; anything spread
 * ≥ 1 → 0. By construction `agreement >= TIGHT_AGREEMENT_MIN` is exactly the
 * provider's own tight-agreement judgement (`spread <= TIGHT_SPREAD`), so the
 * pipeline's web_tight gate and this provider can never disagree.
 */
export const TIGHT_AGREEMENT_MIN = 1 - TIGHT_SPREAD;

export function spreadToAgreement(spread: number): number {
  return Math.min(1, Math.max(0, 1 - spread));
}

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

/**
 * Is coverage + agreement good enough to stop searching early? Only a
 * SOLD-grounded basis may end the search: a tight asking-only cluster is
 * weaker evidence than sold comps a later refinement (e.g. the UPC path's
 * explicit "sold price" query) could still surface within the same iteration
 * budget, so asking-only clusters exhaust the remaining refinements instead
 * of locking in the weaker basis.
 */
function sufficient(j: CompJudgement): boolean {
  return j.soldBasis && j.basis.length >= SUFFICIENT_COMPS && j.spread <= TIGHT_SPREAD;
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
  model: string | undefined,
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
    // grant ready-to-publish confidence to an asking-priced result.
    kind: j.soldBasis ? "sold-comp" : "asking-comp",
  }));

  return {
    suggested: round2(suggested),
    range: { min: round2(min), max: round2(max) },
    confidence,
    sources,
    tier,
    // The judged tightness rides downstream: the confidence composite must
    // see a scattered sold set as scattered, not as a fixed-trust constant.
    compAgreement: spreadToAgreement(j.spread),
    // Provenance: stamped only when the extractor's model is actually KNOWN —
    // the default extractor's resolved id, or an explicit options.model for an
    // injected extractor. An injected extractor without a declared model logs
    // no claim (undefined → pricing_model NULL) rather than a wrong one.
    ...(model ? { model } : {}),
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
  /** Raw model override; resolved lazily (env read at price time) for provenance. */
  model?: string;
  /** Was a custom extractor injected? Then options.model is the ONLY valid provenance. */
  customExtractor: boolean;
}

function resolveDeps(options: WebSearchPricingProviderOptions): ResolvedDeps {
  return {
    model: options.model,
    customExtractor: options.extractComps != null,
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

  // Provenance honesty: a custom extractor may use a different model — or no
  // LLM at all — so only its explicitly declared options.model may be claimed.
  // The env/default resolution applies solely to the default extractor.
  const provenance = deps.customExtractor
    ? deps.model?.trim() || undefined
    : resolvePricingModel(deps.model);
  return synthesize(comps, tier, provenance);
}

/**
 * Tier 3 — `upc-aided-web`: a decoded UPC feeds the web-search agent as an
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
 * Tier 4 — `branded-web`: a recognizable branded item priced from real web
 * comps. Requires a brand AND a model or resolved product name — a bare brand
 * ("Sony" alone) does not identify a product, and its hopelessly broad queries
 * ("Sony used sold price") can surface two arbitrary same-brand comps that
 * satisfy MIN_USEFUL_COMPS and confidently price an UNIDENTIFIED item. With
 * only a brand the tier declines so the router falls through to the estimate
 * tiers. Also requires NO UPC: a UPC-bearing
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
  // Brand alone is NOT an identified product: require a model or a resolved
  // product name alongside it (these compose with the query preference —
  // brand+model first, else the resolved name).
  const identified = (signal: ItemSignal): boolean =>
    Boolean(signal.brand?.trim()) &&
    Boolean(signal.model?.trim() || signal.resolvedName?.trim());
  return {
    tier: "branded-web",
    canHandle(signal: ItemSignal): boolean {
      return identified(signal) && !ownedByUpcTier(signal);
    },
    async price(signal: ItemSignal): Promise<PriceResult | null> {
      if (!identified(signal) || ownedByUpcTier(signal)) return null;
      return priceViaWebAgent("branded-web", signal, deps);
    },
  };
}
