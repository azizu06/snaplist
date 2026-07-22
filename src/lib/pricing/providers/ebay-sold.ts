import { load } from "cheerio";
import type {
  ItemSignal,
  PriceResult,
  PriceSource,
  PricingProvider,
} from "../types";
import { TIGHT_AGREEMENT_MIN, spreadToAgreement } from "./web-search";
import {
  recencyWeight,
  selectFreshComps,
  weightedMedian,
  SOLD_HALFLIFE_DAYS_DEFAULT,
  SOLD_STALE_DAYS_DEFAULT,
} from "../freshness";
import type { TtlCache } from "../comp-cache";
import { logEvent, type LogFields } from "../../observability";
import {
  buildEbaySoldProxyRequestUrl,
  resolveEbaySoldEgressConfig,
} from "../ebay-sold-egress";
import {
  selectSoldCompEvidence,
  selectVerifiedSoldMatches,
} from "../sold-comp-matcher";

/**
 * Tier "ebay-sold" — a scraper over eBay's PUBLIC sold-listings pages (issue #56).
 *
 * Why this exists (ADR-0001): used-item *sold* prices are the strongest
 * available signal for pricing, but there is no free API for them — eBay's
 * Marketplace Insights is gated, and the open web mostly surfaces *asking*
 * prices. eBay's sold/completed
 * results pages (`LH_Sold=1&LH_Complete=1`) are, however, publicly visible with
 * no login. This provider reads them as real **sold comps** and slots ABOVE the
 * web-search tiers, so a sold-grounded price wins over open-web asking comps.
 *
 * Honest boundaries:
 *  - READ-ONLY price research. We never scrape to post (export packs stay).
 *  - No login is required. IP rate-limits, CAPTCHAs, markup drift, and other
 *    egress failures are EXPECTED, recoverable conditions, so a blocked scrape
 *    DECLINES (returns `null`) and the router falls through to the legal
 *    web-search tier — it never hard-fails the pricing call.
 *  - Invalid proxy configuration is different: it fails validation before any
 *    request. Runtime fetch diagnostics expose only bounded, credential-safe reasons.
 *  - Cache-on-miss / TTL freshness is opt-in on the raw provider. The free
 *    no-proxy default direct path may coordinate through the process-local cache;
 *    configured proxy and injected/wrapped normal fetch paths require a shared
 *    atomic claim. The production composition root wires the selected cache and
 *    age-decay layer (#59).
 *
 * Default egress is direct `fetch`; an optional validated proxy template supports
 * hosted environments. HTML is parsed with `cheerio`. A Playwright-style fallback
 * is modeled as an injectable `fetchPageFallback` seam (tried when the primary
 * is blocked); the concrete headless driver is intentionally NOT bundled yet
 * (heavy browser dep, unvalidated against live blocking). Every network
 * dependency is INJECTED (same DI style as `providers/web-search.ts`), so the
 * contract test runs fully offline against a saved HTML fixture.
 */

// ---------------------------------------------------------------------------
// Injected fetch seam
// ---------------------------------------------------------------------------

/** Fetch a page's raw HTML. Real default: SSRF-guarded `fetch`. Tests inject a fake. */
export type FetchPage = (url: string) => Promise<string>;

/** One sold comparable parsed from the results page. Always a completed sale. */
export interface EbaySoldComp {
  /** Canonical eBay item URL — the checkable citation. */
  url: string;
  /** Listing title. */
  title?: string;
  /** The sold price in the page's currency (USD on the .com base). */
  price: number;
  /**
   * Card condition metadata from eBay's subtitle/SECONDARY_INFO ("Brand New",
   * "Pre-Owned", "Open Box", …). The seller-written title often omits the grade,
   * so this is the authoritative new-vs-used signal when present (#56 review).
   */
  condition?: string;
  /**
   * Completed-sale timestamp (epoch ms) parsed from the card's "Sold &lt;date&gt;"
   * caption, when present. Drives the freshness layer (#59): the recency/age-decay
   * weighting and the staleness cutoff. Absent when the caption date is missing or
   * unparseable — an undated comp is treated as neutral (never expired, full weight).
   */
  soldAt?: number;
}

export interface EbaySoldPricingProviderOptions {
  /** Explicit kill-switch state; defaults to `EBAY_SOLD_ENABLED` env config. */
  enabled?: boolean;
  /** Injected page fetcher; defaults to the SSRF-guarded `fetch` over env config. */
  fetchPage?: FetchPage;
  /** Optional Playwright-style fallback, tried when the primary fetch is blocked/thin. */
  fetchPageFallback?: FetchPage;
  /** Results host; defaults to `EBAY_SOLD_BASE_URL` env or the .com base. */
  baseUrl?: string;
  /** Hard cap on parsed comps per call. */
  maxResults?: number;
  /** Outbound User-Agent; defaults to `EBAY_SOLD_USER_AGENT` env or a desktop UA. */
  userAgent?: string;
  /** Per-fetch timeout (ms), clamped to 15s; defaults to env or 8000. */
  fetchTimeoutMs?: number;
  /** Diagnostic sink; tests/operator smoke may silence structured runtime logs. */
  emitDiagnostic?: (event: string, fields: LogFields) => void;
  // -- Freshness (#59). The clock remains opt-in. `createDefaultPricer` wires the
  //    process-local or shared cache selected by environment. --
  /**
   * TTL cache of sold-comp scrapes keyed by the resolved search URL (= product
   * identity). A hit within the TTL is reused (no fetch); a claimed miss
   * live-fetches and stores. Configured proxy and injected/wrapped normal fetch
   * paths decline when a shared claim is unavailable; the free default direct
   * path may reuse process-local coordination.
   */
  cache?: TtlCache<EbaySoldComp[]>;
  /**
   * Clock for the age-decay layer (injected for deterministic tests). When set,
   * stale comps are dropped and the suggested price is recency-weighted; when
   * omitted, no freshness adjustment is applied (raw median over all comps).
   */
  now?: () => number;
  /** Staleness cutoff in days; defaults to `EBAY_SOLD_STALE_DAYS` env or 180. */
  staleDays?: number;
  /** Recency half-life in days; defaults to `EBAY_SOLD_HALFLIFE_DAYS` env or 45. */
  halfLifeDays?: number;
}

// ---------------------------------------------------------------------------
// Config (env-configurable everything — read lazily, never at import)
// ---------------------------------------------------------------------------

export const EBAY_SOLD_BASE_URL_DEFAULT = "https://www.ebay.com";
/** A desktop UA — eBay serves the classic SRP markup the parser targets to these. */
export const EBAY_SOLD_USER_AGENT_DEFAULT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 SnapList/1.0 (+pricing research)";
/** First public sold-page candidate request for one logical pricing pass. */
export const EBAY_SOLD_RESULTS_PER_PAGE = 10;
/** One optional public sold-page expansion; no request may ask for more. */
export const EBAY_SOLD_MAX_RESULTS = 20;
/** Expand only while canonical matcher evidence remains below this count. */
export const EBAY_SOLD_EXPANSION_THRESHOLD = 3;
/** Fewer than this many sold comps = "nothing useful" → decline. */
export const EBAY_SOLD_MIN_COMPS = 2;

interface EbaySoldRuntimeState {
  inFlight: Map<string, Promise<EbaySoldComp[] | null>>;
}

/** Maximum delay between shared-cache reads while another runtime owns the claim. */
const EBAY_SOLD_HANDOFF_POLL_MAX_MS = 3_200;
/** Bounded time for the winner to store and the loser to observe its result. */
export const EBAY_SOLD_HANDOFF_STORE_READ_ALLOWANCE_MS = 500;
/** Fast bounded polling while a shared mutation response remains ambiguous. */
const EBAY_SOLD_AMBIGUOUS_MUTATION_POLL_MS = 25;
const EBAY_SOLD_COORDINATION_DEADLINE_EXCEEDED = Symbol(
  "ebay-sold-coordination-deadline-exceeded",
);

async function settleBeforeCoordinationDeadline<T>(
  startOperation: (signal: AbortSignal) => Promise<T>,
  deadline: number,
  cancellationSignal?: AbortSignal,
): Promise<T | typeof EBAY_SOLD_COORDINATION_DEADLINE_EXCEEDED> {
  const remainingMs = deadline - Date.now();
  if (remainingMs < 0) return EBAY_SOLD_COORDINATION_DEADLINE_EXCEEDED;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([
      startOperation(controller.signal),
      new Promise<typeof EBAY_SOLD_COORDINATION_DEADLINE_EXCEEDED>((resolve) => {
        timer = setTimeout(
          () => {
            // Win the race with the fail-soft sentinel before abort listeners
            // reject the underlying cache request.
            resolve(EBAY_SOLD_COORDINATION_DEADLINE_EXCEEDED);
            controller.abort();
          },
          remainingMs,
        );
      }),
      new Promise<typeof EBAY_SOLD_COORDINATION_DEADLINE_EXCEEDED>((resolve) => {
        cancel = () => {
          resolve(EBAY_SOLD_COORDINATION_DEADLINE_EXCEEDED);
          controller.abort();
        };
        if (cancellationSignal?.aborted) cancel();
        else cancellationSignal?.addEventListener("abort", cancel, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) cancellationSignal?.removeEventListener("abort", cancel);
  }
}

async function delayBeforeCoordinationDeadline(
  delayMs: number,
  deadline: number,
  cancellationSignal: AbortSignal,
): Promise<boolean> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0 || cancellationSignal.aborted) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await new Promise<boolean>((resolve) => {
      timer = setTimeout(
        () => resolve(true),
        Math.min(delayMs, remainingMs),
      );
      cancel = () => resolve(false);
      cancellationSignal.addEventListener("abort", cancel, { once: true });
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) cancellationSignal.removeEventListener("abort", cancel);
  }
}

async function observeCommittedMutation<T>(
  observe: (signal: AbortSignal) => Promise<T | null>,
  accepts: (value: T) => boolean,
  deadline: number,
  cancellationSignal: AbortSignal,
): Promise<T | typeof EBAY_SOLD_COORDINATION_DEADLINE_EXCEEDED> {
  // Let an immediate authoritative mutation response win without spending a
  // reconciliation read. A stalled response crosses this event-loop boundary.
  if (!(await delayBeforeCoordinationDeadline(0, deadline, cancellationSignal))) {
    return EBAY_SOLD_COORDINATION_DEADLINE_EXCEEDED;
  }
  let delayMs = EBAY_SOLD_AMBIGUOUS_MUTATION_POLL_MS;
  while (!cancellationSignal.aborted) {
    try {
      const observed = await settleBeforeCoordinationDeadline(
        observe,
        deadline,
        cancellationSignal,
      );
      if (observed === EBAY_SOLD_COORDINATION_DEADLINE_EXCEEDED) return observed;
      if (observed != null && accepts(observed)) return observed;
    } catch {
      // An observation failure does not override a mutation response that may
      // still settle successfully within the same deadline. Stop issuing reads
      // on an unavailable cache and let that response or the deadline decide.
      await delayBeforeCoordinationDeadline(
        Number.MAX_SAFE_INTEGER,
        deadline,
        cancellationSignal,
      );
      return EBAY_SOLD_COORDINATION_DEADLINE_EXCEEDED;
    }
    if (
      !(await delayBeforeCoordinationDeadline(
        delayMs,
        deadline,
        cancellationSignal,
      ))
    ) {
      break;
    }
    delayMs = Math.min(delayMs * 2, EBAY_SOLD_HANDOFF_POLL_MAX_MS);
  }
  return EBAY_SOLD_COORDINATION_DEADLINE_EXCEEDED;
}

type ReconciledMutation<MutationResult, Observed> =
  | { kind: "mutation"; value: MutationResult }
  | { kind: "observed"; value: Observed };

async function settleMutationWithObservation<MutationResult, Observed>(
  mutate: (signal: AbortSignal) => Promise<MutationResult>,
  observe: (signal: AbortSignal) => Promise<Observed | null>,
  accepts: (value: Observed) => boolean,
  deadline: number,
  observeAfterMutationRejection = false,
): Promise<
  | ReconciledMutation<MutationResult, Observed>
  | typeof EBAY_SOLD_COORDINATION_DEADLINE_EXCEEDED
> {
  const cancellation = new AbortController();
  type Outcome =
    | ReconciledMutation<MutationResult, Observed>
    | typeof EBAY_SOLD_COORDINATION_DEADLINE_EXCEEDED;
  try {
    const mutationResponse: Promise<Outcome> = settleBeforeCoordinationDeadline(
      mutate,
      deadline,
      cancellation.signal,
    ).then(
      (value): Outcome =>
        value === EBAY_SOLD_COORDINATION_DEADLINE_EXCEEDED
          ? EBAY_SOLD_COORDINATION_DEADLINE_EXCEEDED
          : { kind: "mutation", value: value as MutationResult },
    );
    const mutationOutcome = observeAfterMutationRejection
      ? mutationResponse.catch(
          // A rejected claim response is ambiguous: its owner token may already
          // be durable. Keep the bounded observation in the race instead of
          // letting this rejection win and cancel it.
          () => new Promise<never>(() => undefined),
        )
      : mutationResponse;
    const observationOutcome: Promise<Outcome> = observeCommittedMutation(
      observe,
      accepts,
      deadline,
      cancellation.signal,
    ).then(
      (value): Outcome =>
        value === EBAY_SOLD_COORDINATION_DEADLINE_EXCEEDED
          ? EBAY_SOLD_COORDINATION_DEADLINE_EXCEEDED
          : { kind: "observed", value: value as Observed },
    );
    const outcome = await Promise.race([mutationOutcome, observationOutcome]);
    return outcome;
  } finally {
    cancellation.abort();
  }
}

/** Request-scoped providers share one cache object at the composition root. */
const EBAY_SOLD_RUNTIME_STATE_BY_CACHE = new WeakMap<
  TtlCache<EbaySoldComp[]>,
  EbaySoldRuntimeState
>();

function runtimeStateFor(
  cache: TtlCache<EbaySoldComp[]> | undefined,
): EbaySoldRuntimeState {
  if (!cache) return { inFlight: new Map() };
  let state = EBAY_SOLD_RUNTIME_STATE_BY_CACHE.get(cache);
  if (!state) {
    state = { inFlight: new Map() };
    EBAY_SOLD_RUNTIME_STATE_BY_CACHE.set(cache, state);
  }
  return state;
}

/**
 * Per-fetch timeout. A stalled eBay response (connection accepted, body never
 * sent) must ABORT so the provider's catch can decline — otherwise the request
 * hangs until the serverless deadline and the promised graceful fallback never
 * runs (#56 review). Overridable via `EBAY_SOLD_TIMEOUT_MS`.
 */
export const EBAY_SOLD_FETCH_TIMEOUT_MS = 8000;
/** Operator config cannot extend a public sold-page request without bound. */
export const EBAY_SOLD_FETCH_TIMEOUT_MAX_MS = 15_000;

/** The only host family this provider will ever fetch. */
export const EBAY_ALLOWED_HOST = "ebay.com";

function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.EBAY_SOLD_BASE_URL?.trim() || EBAY_SOLD_BASE_URL_DEFAULT;
}

function resolveUserAgent(env: NodeJS.ProcessEnv = process.env): string {
  return env.EBAY_SOLD_USER_AGENT?.trim() || EBAY_SOLD_USER_AGENT_DEFAULT;
}

function boundedTimeoutMs(value: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.min(value, EBAY_SOLD_FETCH_TIMEOUT_MAX_MS)
    : EBAY_SOLD_FETCH_TIMEOUT_MS;
}

function resolveTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return boundedTimeoutMs(Number(env.EBAY_SOLD_TIMEOUT_MS));
}

/** Freshness TTL/cutoff/half-life — env-tunable (#59); each falls back to its default. */
export const EBAY_SOLD_CACHE_TTL_HOURS_DEFAULT = 72; // ~3 days: "reuse for a few days"

function posNum(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveSoldCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return posNum(env.EBAY_SOLD_CACHE_TTL_HOURS, EBAY_SOLD_CACHE_TTL_HOURS_DEFAULT) * 3_600_000;
}

function resolveStaleDays(env: NodeJS.ProcessEnv = process.env): number {
  return posNum(env.EBAY_SOLD_STALE_DAYS, SOLD_STALE_DAYS_DEFAULT);
}

function resolveHalfLifeDays(env: NodeJS.ProcessEnv = process.env): number {
  return posNum(env.EBAY_SOLD_HALFLIFE_DAYS, SOLD_HALFLIFE_DAYS_DEFAULT);
}

/**
 * Is the scraper enabled? On by default; `EBAY_SOLD_ENABLED=false|0|off` is a
 * kill-switch that makes the tier decline (degrade to the web-search tier)
 * without code changes — env-configurable everything (AGENTS.md).
 */
export function ebaySoldConfigured(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const v = env.EBAY_SOLD_ENABLED?.trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "off";
}

// ---------------------------------------------------------------------------
// SSRF hardening — the constructed URL is validated before any request
// ---------------------------------------------------------------------------

/** Host must be exactly `ebay.com` or a `*.ebay.com` subdomain (dot-boundary). */
export function isAllowedEbayHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === EBAY_ALLOWED_HOST || h.endsWith(`.${EBAY_ALLOWED_HOST}`);
}

/**
 * True when the host is something we must NEVER fetch: an internal/loopback
 * name, OR any IP literal at all. eBay is only ever reached by DNS name, so a
 * raw IP (public or private) is rejected outright — that closes the obvious
 * SSRF surface (a baseUrl pointed at `127.0.0.1`, `169.254.169.254`, etc.)
 * even before the host-allowlist runs.
 */
export function isPrivateOrInternalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!h) return true;
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal")
  ) {
    return true;
  }
  if (h.includes(":")) return true; // any IPv6 literal
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return true; // any IPv4 literal
  return false;
}

/**
 * Validate a URL is safe to fetch: https, no userinfo, an allowed eBay host,
 * and not an internal/IP address. Throws on any violation; returns the parsed
 * URL otherwise. The provider calls this for every eBay target before direct or
 * proxy egress; a configured proxy host is trusted operator configuration.
 */
export function assertSafeEbayUrl(rawUrl: string): URL {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`Unsafe eBay URL (unparseable): ${rawUrl}`);
  }
  if (u.protocol !== "https:") {
    throw new Error(`Unsafe eBay URL (must be https): ${rawUrl}`);
  }
  if (u.username || u.password) {
    throw new Error("Unsafe eBay URL (embedded credentials not allowed)");
  }
  const host = u.hostname.toLowerCase();
  if (!isAllowedEbayHost(host)) {
    throw new Error(`Unsafe eBay URL (host not allowed): ${host}`);
  }
  if (isPrivateOrInternalHost(host)) {
    throw new Error(`Unsafe eBay URL (internal/IP address): ${host}`);
  }
  return u;
}

/**
 * Normalize one untrusted sold-listing URL through the canonical eBay item
 * boundary. Only HTTPS ebay.com hosts with an `/itm/` identity survive; query
 * and fragment data are not evidence and are removed from the citation.
 */
export function canonicalEbayItemUrl(
  value: unknown,
): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = assertSafeEbayUrl(value.trim());
    if (!url.pathname.toLowerCase().startsWith("/itm/")) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeEbaySoldCompUrls(
  comps: readonly EbaySoldComp[],
): EbaySoldComp[] {
  const seen = new Set<string>();
  const normalized: EbaySoldComp[] = [];
  for (const comp of comps) {
    const url = canonicalEbayItemUrl(comp.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    normalized.push({ ...comp, url });
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Query formulation + parsing — deterministic, pure, total
// ---------------------------------------------------------------------------

/**
 * The search query identifying the item: brand+model is the most precise; a
 * resolved product name is next; a bare UPC is a fine exact key; and an ISBN is
 * a fine exact key for a book the structured ISBN tier identified but couldn't
 * price (it declines → the book reaches this tier; #56 review). A bare brand
 * ("Sony") is NOT a product — its sold search returns arbitrary same-brand
 * items, the same false precision the branded-web tier refuses — so it yields
 * no query (→ the provider declines).
 */
export function buildSoldSearchQuery(signal: ItemSignal): string | null {
  const brand = signal.brand?.trim();
  const model = signal.model?.trim();
  if (brand && model) {
    // Brand+model alone spans EVERY configuration a multi-config product ships in
    // (a laptop sold as i5/i7, 1660Ti/RTX). The sold tier runs ABOVE web search, so
    // a brand+model-only sold query would price mixed configs and the "Sharpen" flow
    // — which feeds the seller's confirmed specs in as `signal.specs` — would be
    // ignored at this tier (Codex P2). Fold a bounded specs hint into the query so
    // sold comps cluster on the SAME configuration. Cap at 3, exactly as the
    // web-search tier does (`buildSearchQueries`): more over-narrows eBay's keyword
    // match. If the narrowed query then returns < MIN comps the provider declines to
    // the web-search tier (which itself narrows-then-broadens), so coverage is never
    // lost — only the wrong-config sold comps are.
    const specsHint = (signal.specs ?? [])
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(" ");
    return specsHint ? `${brand} ${model} ${specsHint}` : `${brand} ${model}`;
  }
  const resolved = signal.resolvedName?.trim();
  if (resolved) return resolved;
  const upc = signal.upc?.trim();
  if (upc) return upc;
  const isbn = signal.isbn?.trim();
  if (isbn) return isbn;
  return null;
}

/**
 * Build the sold/completed results URL for a signal, or `null` when the item is
 * not identifiable. The `LH_Sold=1&LH_Complete=1` flags are what make the page
 * show real SOLD comps instead of active asking listings.
 */
export function buildSoldSearchUrl(
  signal: ItemSignal,
  baseUrl: string = resolveBaseUrl(),
  resultsPerPage: number = EBAY_SOLD_RESULTS_PER_PAGE,
): string | null {
  const q = buildSoldSearchQuery(signal);
  if (!q) return null;
  // A malformed EBAY_SOLD_BASE_URL (e.g. "www.ebay.com" with no scheme) makes the
  // URL constructor throw. This runs inside the router's `canHandle` precheck —
  // OUTSIDE the guarded fetch path — so a throw would abort the entire pricing
  // pipeline instead of declining as documented. Keep it TOTAL: a bad base URL →
  // decline (null), and the router falls through to the web-search tier (#56 review).
  try {
    const url = new URL("/sch/i.html", baseUrl);
    url.searchParams.set("_nkw", q);
    url.searchParams.set("LH_Sold", "1");
    url.searchParams.set("LH_Complete", "1");
    url.searchParams.set("_ipg", String(resultsPerPage));
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Non-USD currency detection. Rather than enumerate foreign codes (whack-a-mole:
 * ILS, RUB, THB, ₪, ₺ … always escape a finite list), REQUIRE an unambiguous USD
 * amount and reject everything else (#56 review):
 *  - any currency SYMBOL that isn't `$` (the Unicode `\p{Sc}` class — £ € ¥ ₪ ₺
 *    ₹ ₩ ฿ … — tested after stripping `$`);
 *  - any 3-letter ISO currency code other than `USD` (EUR, GBP, ILS, RUB, THB …);
 *  - a letter-prefixed dollar (`C $`, `AU $`) EXCEPT `US $` (which IS USD).
 */
const NON_DOLLAR_SYMBOL_RE = /\p{Sc}/u;
const FOREIGN_ISO_CODE_RE = /\b(?!USD\b)[A-Z]{3}\b/;
const FOREIGN_DOLLAR_RE = /\b(?!US\b)[A-Z]{1,3}\s*\$/;

/**
 * Parse a single USD sold price into a number. Handles `$178.00` and comma-grouped
 * `$1,299.99`. Returns `null` for empty / non-priced text (`Free`, ``), for any
 * amount that is not unambiguously USD (`C $99.00`, `£99.00`, `EUR 99,00`, `ILS
 * 500`), AND for a variation RANGE (`$120.00 to $150.00`): a range is a multi-
 * variation listing — different variants, not one unit that sold at the midpoint —
 * so inventing `$135` would contaminate the median (#56 review). Pure and total.
 */
export function parsePrice(text: string | undefined): number | null {
  if (!text) return null;
  if (
    NON_DOLLAR_SYMBOL_RE.test(text.replace(/\$/g, "")) ||
    FOREIGN_ISO_CODE_RE.test(text) ||
    FOREIGN_DOLLAR_RE.test(text)
  ) {
    return null;
  }
  // Require an explicit USD marker so a bare number ("500.00") isn't assumed USD.
  if (!/\$/.test(text) && !/\bUSD\b/.test(text)) return null;
  const groups = text.replace(/,/g, "").match(/\d+(?:\.\d+)?/g);
  if (!groups) return null;
  const values = groups.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (values.length === 0) return null;
  // A multi-number cell is a variation RANGE ("$120 to $150") — different variants,
  // not one sold unit. Decline rather than fabricate a midpoint comp (#56 review).
  if (values.length > 1) return null;
  return values[0];
}

/**
 * Parse the sold-results HTML into comps. Reads eBay's classic SRP card markup
 * (`ul.srp-results > li.s-item` with `.s-item__title`, `.s-item__price`,
 * `a.s-item__link`), and is SCOPED to verified sold cards two ways (#56 review):
 *   (1) only `li.s-item` INSIDE `.srp-results` — eBay reuses `li.s-item` for
 *       sponsored / "results matching fewer words" / recommendation carousels
 *       that live OUTSIDE the results list; and
 *   (2) each card must carry a `Sold` caption (`.s-item__caption`) — on an
 *       LH_Sold page every completed sale shows one; an active/sponsored card
 *       injected INTO the list does not, so its ASKING price is never labeled a
 *       sold comp.
 * Also skips the leading "Shop on eBay" placeholder and any card without a
 * parseable price or item link, and dedupes by URL. Pure and TOTAL: any
 * malformed page yields `[]`, never a throw — so the provider's fetch `catch`
 * can stay narrow (around the network only) and not mask real bugs.
 *
 * NOTE: this parses the classic `srp-results > s-item` layout (the saved fixture).
 * eBay also serves a MODERN `li.s-card` layout to some clients; adding that
 * selector set + a CAPTURED modern fixture is live-validation work tracked to the
 * freshness slice (#59) — writing it blind (guessed class names, untested against
 * real markup) would be dead code. Until #59 lands, the provider declines
 * gracefully (→ web tier) on markup it doesn't recognize, never a wrong price.
 */
/**
 * Parse a sold card's caption ("Sold&nbsp;Jun 3, 2026") to an epoch-ms timestamp,
 * or undefined when the date is absent/unparseable. Pure and total — a bad date
 * yields undefined (the comp is kept and treated as neutral by the freshness
 * layer), never a throw. `&nbsp;` decodes to ` `, so both that and a regular
 * space are accepted as separators.
 */
export function parseSoldDate(captionText: string | undefined): number | undefined {
  if (!captionText) return undefined;
  const m = captionText.match(
    /sold\b[\s ]+([A-Za-z]{3,9}\.?[\s ]+\d{1,2},?[\s ]+\d{4})/i,
  );
  if (!m) return undefined;
  const normalized = m[1].replace(/[\s ]+/g, " ").trim();
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Field selectors for ONE eBay SRP layout. eBay serves two interchangeably: the
 * CLASSIC `.srp-results > li.s-item` and the MODERN `.su-card-container` /
 * `li.s-card` (#59). The fields read are identical; only the class names differ,
 * so the per-card extraction is shared and only the selector set varies.
 */
interface CardSelectors {
  /** The card container (the `.each` root). */
  card: string;
  title: string;
  price: string;
  caption: string;
  link: string;
  /** Condition grade span(s); the first non-empty wins. */
  condition: string;
}

/** Classic layout. `card` is SCOPED to `.srp-results` so sponsored/"matching
 * fewer words" carousels that reuse `li.s-item` outside the results list are
 * never harvested (#56 review). */
const CLASSIC_SELECTORS: CardSelectors = {
  card: ".srp-results li.s-item",
  title: ".s-item__title",
  price: ".s-item__price",
  caption: ".s-item__caption",
  link: "a.s-item__link",
  condition: ".s-item__subtitle, .SECONDARY_INFO",
};

/** Modern layout. `li.s-card` is NOT scoped to a verified results container, so
 * the mandatory "Sold" caption check below is what excludes sponsored/active
 * cards (they carry no completed-sale caption) — the same defense the classic
 * path applies as its second gate. */
const MODERN_SELECTORS: CardSelectors = {
  card: "li.s-card",
  title: ".s-card__title",
  price: ".s-card__price",
  caption: ".s-card__caption",
  link: "a.s-card__link",
  condition: ".s-card__subtitle",
};

export function parseSoldComps(
  html: string,
  baseUrl: string = EBAY_SOLD_BASE_URL_DEFAULT,
  max: number = EBAY_SOLD_MAX_RESULTS,
): EbaySoldComp[] {
  const $ = load(html);
  const comps: EbaySoldComp[] = [];
  const seen = new Set<string>();

  /** Harvest every valid sold comp for one layout. Returns true if the parse cap
   * was hit (so the caller can stop without scanning the other layout). */
  const harvest = (sel: CardSelectors): boolean => {
    let capped = false;
    $(sel.card).each((_i, el) => {
      if (comps.length >= max) {
        capped = true;
        return false; // hit the cap — stop iterating
      }

      const card = $(el);
      const title = card
        .find(sel.title)
        .first()
        .text()
        .replace(/\s+/g, " ")
        .trim()
        // Classic prefixes a "New Listing" badge; the modern card appends an
        // "Opens in a new window or tab" a11y suffix (glued straight onto the
        // title text, no space). Strip both — neither belongs in the title, and a
        // leftover "a NEW window" would wrongly trip the new-condition filter and
        // drop every comp (#59). `.*$` so the "or tab" tail goes too.
        .replace(/^New Listing/i, "")
        .replace(/\s*Opens in a new window.*$/i, "")
        .trim();
      if (!title || /^shop on ebay$/i.test(title)) return; // placeholder / empty

      // Require the "Sold" caption — an active/sponsored card (no completed-sale
      // caption) must never be counted as a sold comp. The same caption carries
      // the sale DATE used by the freshness layer (#59).
      const captionText = card.find(sel.caption).text();
      if (!/\bsold\b/i.test(captionText)) return;

      // Skip Best-Offer-accepted cards: the public card can show the LIST price, not
      // the accepted transaction amount (the true amount is gated in Product
      // Research), so its price is unreliable as a sold comp (#56 review). Honest
      // ceiling: open-web sold pages can't always reveal the real offer price.
      if (/best\s*offer\s*accepted/i.test(card.text())) return;

      const price = parsePrice(card.find(sel.price).first().text());
      if (price == null) return;

      const href = card.find(sel.link).first().attr("href");
      if (!href) return;
      let url: string;
      try {
        url = new URL(href, baseUrl).toString();
      } catch {
        return;
      }
      if (seen.has(url)) return;
      seen.add(url);

      // Card condition metadata (eBay's subtitle / SECONDARY_INFO span) — the
      // authoritative grade even when the title omits it (#56 review).
      const condition =
        card.find(sel.condition).first().text().replace(/\s+/g, " ").trim() ||
        undefined;

      const soldAt = parseSoldDate(captionText);

      comps.push({
        url,
        title,
        price,
        ...(condition ? { condition } : {}),
        ...(soldAt != null ? { soldAt } : {}),
      });
    });
    return capped;
  };

  // A real SRP is ONE layout or the other; harvest the classic first, then the
  // modern (the absent layout yields nothing), deduping by URL across both so the
  // parser is layout-agnostic. If the classic harvest already hit the cap, skip
  // the modern scan — we're full.
  if (!harvest(CLASSIC_SELECTORS)) harvest(MODERN_SELECTORS);

  return comps;
}

// ---------------------------------------------------------------------------
// Relevance filtering — drop accessories / parts / wrong-model noise (#56 review)
// ---------------------------------------------------------------------------

/**
 * Titles that mark a listing as an accessory, a part, a broken/for-parts unit, or
 * a multi-unit lot — NOT the sellable item. Pricing the main item off these would
 * be badly wrong (a $20 ear-pad or $15 case sale must never anchor a $180
 * headphone price; two clustered accessory sales would otherwise fire the sold
 * tier). Precision over recall is deliberate. Covers common hero-domain
 * accessories/item-only qualifiers (case, dock, controller, empty box, …); an
 * accessory term is IGNORED when it is part of the item's OWN identity (see
 * `isAccessoryOrParts`), so a seller actually selling a "DualSense Controller"
 * keeps controller comps. The set is gold-set-tuned (#60/#61).
 */
const ACCESSORY_OR_PARTS_RE =
  /\b(ear ?pads?|earpads?|cushions?|replacement|spare|for parts|parts only|not working|broken|faulty|as[- ]?is|repair|cable|cord|charger|adapter|bundle|lot of|case|cover|pouch|sleeve|skin|sticker|decal|strap|grip|stand|mount|holder|dock|screen protector|protector|empty box|box only|manual only|disc only|game only|controller|accessor(?:y|ies))\b/i;

/**
 * New/sealed-condition markers, INCLUDING the standalone "NEW". SnapList prices
 * USED goods, so a new sold listing is not a valid comp for a used item and
 * inflates the median when used by the legacy boolean helpers below.
 * Group 1 captures a leading "like " so `isNewConditionComp` SKIPS "Like New" (a
 * used grade). Identity uses of "new" (e.g. brand "New Balance") are handled by
 * STRIPPING the identity phrases from the title before scanning, not by a substring
 * skip — so a genuine standalone "NEW" elsewhere is still caught. No `g` flag —
 * callers build a global copy for `matchAll`, avoiding shared `lastIndex` state.
 */
const NEW_CONDITION_RE =
  /\b(like[ -])?(brand[- ]?new|new sealed|new in box|factory sealed|sealed|bnib|nib|nwt|never used|unopened|new)\b/i;

/**
 * Multi-unit / lot markers: a sold listing for MORE THAN ONE unit (2-pack, set of
 * 2, 4 pcs) whose price is a multiple of the single-item price. Two clustered
 * multi-unit sales would otherwise pass agreement and clear the publish-eligibility gate at
 * 2–3× the true price (#56 review). The accessory filter already covers "bundle"
 * and "lot of"; this adds the unambiguous remaining forms. "2x" and "pair of" are
 * deliberately EXCLUDED as ambiguous — "10x zoom" is a feature and a single "pair
 * of" shoes/headphones is ONE item — so nuanced quantity parsing rides with the
 * gold-set eval (#61). Precision over recall.
 */
const MULTI_UNIT_RE =
  /\b(\d+\s*[- ]?pack|pack of \d+|set of \d+|\d+\s*pcs?|\d+\s*pieces?)\b/i;

/** Is the comp a multi-unit lot rather than a single item? Pure and total. */
export function isMultiUnitLot(title: string): boolean {
  return MULTI_UNIT_RE.test(title);
}

/**
 * Match the model at TOKEN BOUNDARIES, separator-insensitively. The model is split
 * into alphanumeric tokens that may be rejoined by spaces / hyphens / underscores
 * in the title (so "WH-1000XM4" still matches "WH 1000XM4"), but the whole match
 * must NOT be flanked by further alphanumerics — so a model that is a PREFIX of a
 * longer token is rejected: signal model "574" must not match "New Balance 5740"
 * (#56 review: a whole-title `.includes()` accepted the wrong variant). A model
 * with no alphanumeric tokens is unmatchable, so we trust eBay's exact query.
 */
function modelMatchesTitle(title: string, model: string): boolean {
  const tokens = model.match(/[A-Za-z0-9]+/g);
  if (!tokens || tokens.length === 0) return true;
  // The token-boundary match alone still accepts a longer VARIANT, because the
  // separating whitespace satisfies the trailing boundary: "iPhone 14 Pro" would
  // match "iPhone 14 Pro Max", "PlayStation 5" → "PlayStation 5 Slim". Reject when
  // a known product-tier suffix the signal didn't ask for follows the match (their
  // resale values differ materially). A tight, well-known suffix set stops the
  // common, costly confusions; exhaustive variant disambiguation is gold-set work
  // (#61), and a false reject only declines to the web tier (#56 review).
  const pattern =
    "(?<![A-Za-z0-9])" +
    tokens.join("[\\s\\-_]*") +
    "(?![A-Za-z0-9])" +
    "(?!\\s+(?:max|plus|pro|ultra|mini|se|slim|lite|air|xl|xs|xr)\\b)";
  return new RegExp(pattern, "i").test(title);
}

/**
 * Does the comp plausibly refer to the SAME product as the signal? When a model
 * is known it MUST appear in the title at a token boundary (separator-insensitive,
 * so "WH-1000XM4" matches "WH 1000XM4"). For identity by resolved name / UPC /
 * ISBN we can't token-match the title reliably, so we trust eBay's exact-query
 * result set and rely on the accessory/parts filter alone.
 */
export function matchesIdentity(title: string, signal: ItemSignal): boolean {
  const model = signal.model?.trim();
  if (signal.brand?.trim() && model) {
    return modelMatchesTitle(title, model);
  }
  return true;
}

/** The seller's item identity as a lowercase string, for the accessory carve-out. */
function identityText(signal: ItemSignal): string {
  return [signal.brand, signal.model, signal.resolvedName, signal.category]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * The title with the item's identity PHRASES (brand / model / resolvedName) removed,
 * so condition scanning can't be fooled by an identity that contains a condition
 * word — a "New Balance" brand must not mask a genuine standalone "NEW" elsewhere
 * in the title (#56 review). Each phrase is matched literally, case-insensitively.
 */
function stripIdentity(title: string, signal: ItemSignal): string {
  let out = title;
  for (const phrase of [signal.brand, signal.model, signal.resolvedName]) {
    const p = phrase?.trim();
    if (!p) continue;
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "gi"), " ");
  }
  return out;
}

/**
 * Is the comp an accessory/part rather than the item itself? True when ANY
 * accessory term in the title is NOT part of the item's own identity. Checking
 * EVERY match (not just the first) is essential: "DualSense Controller Case" for
 * a DualSense controller matches "Controller" (in identity) AND "Case" (not) —
 * the case marker must still reject it (#56 review).
 */
export function isAccessoryOrParts(title: string, signal: ItemSignal): boolean {
  const idText = identityText(signal);
  const re = new RegExp(ACCESSORY_OR_PARTS_RE.source, "gi");
  for (const m of title.matchAll(re)) {
    if (!idText.includes(m[1].toLowerCase())) return true;
  }
  return false;
}

/** Does the text carry a NEW/sealed marker (skipping the "Like New" used grade)? */
function hasNewMarker(text: string): boolean {
  const re = new RegExp(NEW_CONDITION_RE.source, "gi");
  for (const m of text.matchAll(re)) {
    if (m[1]) continue; // leading "like " → used grade, not a new marker
    return true;
  }
  return false;
}

/**
 * Is the comp a NEW/sealed listing? Prefers the eBay CONDITION METADATA when
 * present — the seller-written title often omits the grade, so a brand-new sale
 * with a plain title ("Sony WH-1000XM4 Headphones") would otherwise be kept as a
 * used comp (#56 review). Falls back to the identity-stripped TITLE for cards
 * without metadata, so a brand that contains "new" (e.g. "New Balance") can't
 * mask a genuine standalone "NEW" elsewhere. "Open Box" counts as not-used.
 */
export function isNewConditionComp(
  title: string,
  signal: ItemSignal,
  conditionText?: string,
): boolean {
  const cond = conditionText?.toLowerCase() ?? "";
  if (cond && (/\bopen box\b/.test(cond) || hasNewMarker(cond))) return true;
  return hasNewMarker(stripIdentity(title, signal));
}

/**
 * Keep only comps that (a) match the item identity, (b) aren't accessories/parts,
 * (c) aren't multi-unit lots, and (d) aren't new/sealed when the seller's item is
 * used (#56 review: accessory, multi-unit, and new sold listings would otherwise
 * skew a used item's median past the publish-eligibility gate).
 */
export function filterRelevantComps(
  comps: readonly EbaySoldComp[],
  signal: ItemSignal,
): EbaySoldComp[] {
  return selectSoldCompEvidence(comps, signal).anchors.map((entry) => entry.comp);
}

// ---------------------------------------------------------------------------
// Synthesis — the cited, sold-grounded PriceResult
// ---------------------------------------------------------------------------

/**
 * Base trust for an eBay-sold price. These are VERIFIED completed sales on the
 * marketplace itself — stronger than LLM-extracted open-web comps (web-search's
 * 0.65 sold base) but kept below a structured ISBN lookup. The provisional value
 * is a sane floor; the canonical publish-eligibility confidence is recomputed by
 * the pipeline composite, and #60 calibrates the sold tier against the gold set.
 */
export const EBAY_SOLD_BASE_CONFIDENCE = 0.7;
export const EBAY_SOLD_MAX_CONFIDENCE = 0.85;
const EBAY_SOLD_AGREEMENT_BONUS = 0.1;
const EBAY_SOLD_COVERAGE_BONUS = 0.05;
const EBAY_SOLD_COVERAGE_THRESHOLD = 4;

function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Below this many comps, MAD-based outlier detection is unreliable (the median +
 * MAD are themselves too noisy), so we don't trim — on 2–3 comps a divergent
 * price could be the real market, not noise, and dropping it would manufacture a
 * false-tight cluster. Honest default: keep all and let the wide spread land the
 * item sub-gate (web_wide), where a human reviews it.
 */
const MIN_COMPS_FOR_OUTLIER_TRIM = 4;

/**
 * Iglewicz–Hoaglin modified z-score cutoff. |0.6745·(x−median)/MAD| > 3.5 marks a
 * point an outlier. MAD (median absolute deviation) has a ~50% breakdown point, so
 * a lone spike cannot inflate the center the way it inflates a range or an IQR
 * hinge (the masking that lets a tail outlier hide inside Tukey fences).
 */
const MAD_OUTLIER_Z = 3.5;
const MAD_Z_CONST = 0.6745;

/**
 * The core must retain at least this FRACTION of the comps. Trimming a large
 * minority is not "removing noise" — e.g. 2 of 5 sales at $510 are real market
 * signal (a different variant/condition), not an error, and silently dropping
 * them to report a tight $180 would be over-confident. So we cap the trim at ~1/3
 * of the set; if more than that look extreme, the set is genuinely dispersed —
 * keep all and let the honest wide spread land it sub-gate (web_wide) for review.
 */
const MIN_CORE_FRACTION = 2 / 3;

/**
 * The robust CORE of a sold-comp set: the inliers after MAD-based outlier removal
 * (#1 confidence lever). Pure and total — the primary unit-test target.
 *
 * Why this matters: comp agreement is `1 − (max−min)/median`, a RANGE measure with
 * a near-zero breakdown point — a single wrong-model / "for parts" / sealed-unit
 * sale that slips `filterRelevantComps` collapses agreement and forces a genuinely
 * tight used cluster down to the sub-gate `web_wide` tier. Trimming the isolated
 * spike lets the defensible core earn the `sold` tier it deserves.
 *
 * Honest by construction: MAD only removes ISOLATED tail spikes. A uniformly
 * scattered set has a large MAD (no point is many MADs from the median → nothing
 * trimmed), and a bimodal set's median sits between the clusters so every point is
 * a similar distance out (again nothing trimmed). So real dispersion is preserved —
 * only noise is removed. Below `MIN_COMPS_FOR_OUTLIER_TRIM`, or when MAD is 0
 * (>half identical), or when a trim would drop below `MIN_CORE_COMPS`, keep all.
 */
export function coreComps(
  comps: readonly EbaySoldComp[],
): EbaySoldComp[] {
  if (comps.length < MIN_COMPS_FOR_OUTLIER_TRIM) return [...comps];
  const sorted = comps.map((c) => c.price).sort((a, b) => a - b);
  const med = median(sorted);
  const mad = median(sorted.map((p) => Math.abs(p - med)).sort((a, b) => a - b));
  // MAD 0 means more than half the comps share a price — already maximally tight.
  // The modified z-score is then ±∞ for any other point, which would wrongly drop
  // legitimately-near comps, so keep all.
  if (mad === 0) return [...comps];
  const kept = comps.filter(
    (c) => Math.abs((MAD_Z_CONST * (c.price - med)) / mad) <= MAD_OUTLIER_Z,
  );
  if (kept.length < Math.ceil(comps.length * MIN_CORE_FRACTION)) return [...comps];
  return kept;
}

/** Freshness inputs for synthesis (#59). Omit to disable age-decay (raw median). */
export interface SoldSynthesisOptions {
  /** Reference "now" (epoch ms). When set, the suggested price is recency-weighted. */
  now?: number;
  /** Recency half-life in days; defaults to the freshness module default. */
  halfLifeDays?: number;
  /** Optional relevance/condition weight from the provider-neutral matcher. */
  evidenceWeight?: (comp: EbaySoldComp) => number;
}

/**
 * Synthesize the cited `PriceResult` from sold comps. Suggested = median (or, when
 * `opts.now` is given, the RECENCY-WEIGHTED median so newer sales count more — #59);
 * range = the observed min..max band; comp agreement = `1 - relativeSpread` (the
 * SAME mapping the web tier uses, so the confidence composite reads tightness
 * identically across tiers). Every source is a `sold-comp` (completed sales), and no
 * `model` is claimed — the tier is deterministic, no LLM involved.
 *
 * Age-decay touches ONLY the point estimate: the band and agreement describe the
 * observed spread of the (already staleness-filtered) comps, so a tight cluster
 * stays tight whether or not weighting is on. With no `now`, or when all comps are
 * undated (equal weights), the weighted median is exactly the plain median.
 */
export function synthesizeSoldResult(
  comps: readonly EbaySoldComp[],
  opts: SoldSynthesisOptions = {},
): PriceResult {
  if (comps.length === 0) {
    throw new Error("synthesizeSoldResult requires at least one comp");
  }
  // Price/range/agreement/citations all describe the robust CORE (#1): a lone
  // "for parts" / sealed-unit / wrong-model spike that slipped the relevance
  // filter must not collapse agreement nor widen the band, and is not cited as
  // evidence backing the suggested price.
  const core = coreComps(comps);
  const prices = core.map((c) => c.price).sort((a, b) => a - b);
  const suggested =
    opts.now != null || opts.evidenceWeight
      ? weightedMedian(
          core.map((c) => c.price),
          core.map((c) =>
            (opts.evidenceWeight?.(c) ?? 1) *
            (opts.now != null
              ? recencyWeight(c.soldAt, opts.now, opts.halfLifeDays)
              : 1),
          ),
        )
      : median(prices);
  const min = prices[0];
  const max = prices[prices.length - 1];
  const spread = prices.length > 1 && suggested > 0 ? (max - min) / suggested : 0;
  const agreement = spreadToAgreement(spread);

  const confidence = Math.min(
    EBAY_SOLD_MAX_CONFIDENCE,
    EBAY_SOLD_BASE_CONFIDENCE +
      (agreement >= TIGHT_AGREEMENT_MIN ? EBAY_SOLD_AGREEMENT_BONUS : 0) +
      (core.length >= EBAY_SOLD_COVERAGE_THRESHOLD ? EBAY_SOLD_COVERAGE_BONUS : 0),
  );

  const sources: PriceSource[] = core.map((c) => ({
    url: c.url,
    title: c.title,
    kind: "sold-comp",
  }));
  const evidence = core.map((c) => ({
    id: c.url,
    sourceUrl: c.url,
    ...(c.title ? { title: c.title } : {}),
    price: round2(c.price),
    currency: "USD",
    ...(c.condition ? { condition: c.condition } : {}),
    ...(c.soldAt != null ? { soldAt: c.soldAt } : {}),
    kind: "sold-comparable" as const,
    priceDisclosure: "displayed-sold-price" as const,
  }));

  return {
    suggested: round2(suggested),
    range: { min: round2(min), max: round2(max) },
    confidence,
    sources,
    evidence,
    tier: "ebay-sold",
    // The judged tightness rides downstream so a scattered sold set cannot ride
    // the sold-comp label into the ready-to-publish confidence band.
    compAgreement: agreement,
  };
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/**
 * Reduce an upstream fetch failure to a bounded, credential-safe reason for
 * logs. Native/proxy errors can include the full request URL, and proxy URLs may
 * contain an operator credential; never forward arbitrary error text.
 */
export function soldFetchFailureReason(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "timeout";
  const message = error instanceof Error ? error.message : String(error);
  const status = message.match(/^eBay sold fetch failed:\s*(\d{3})\b/);
  return status ? `http-${status[1]}` : "request-failed";
}

/**
 * The real default fetcher: validates the eBay target, rejects redirects on the
 * direct path, optionally routes through validated proxy configuration, and
 * applies a bounded timeout so a stalled response aborts (→ provider decline)
 * instead of hanging until the serverless deadline. `fetchImpl` is injectable
 * so timeout, egress, and SSRF behavior are unit-testable without a live network.
 */
export function createDefaultFetchPage(
  opts: {
    userAgent?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    /** Optional validated HTTPS template; missing/blank preserves direct fetch. */
    proxyTemplate?: string;
  } = {},
): FetchPage {
  const userAgent = opts.userAgent ?? resolveUserAgent();
  const timeoutMs = boundedTimeoutMs(opts.timeoutMs ?? resolveTimeoutMs());
  const doFetch = opts.fetchImpl ?? fetch;
  const egress = resolveEbaySoldEgressConfig(
    opts.proxyTemplate === undefined
      ? process.env
      : { EBAY_SOLD_PROXY_TEMPLATE: opts.proxyTemplate },
  );
  return async (rawUrl) => {
    const safe = assertSafeEbayUrl(rawUrl); // validate the eBay TARGET before any request
    // When proxy egress is configured, route the request through it. Hosted direct
    // fetches can be blocked; the optional operator-selected provider offers an
    // alternate path. The eBay URL is SSRF-validated above; the proxy endpoint is
    // trusted operator config. Unset → fetch eBay directly (unchanged behavior).
    const usingProxy = egress.mode === "proxy";
    const requestUrl: string | URL = usingProxy
      ? buildEbaySoldProxyRequestUrl(egress.template, safe.toString())
      : safe;
    const followRedirect = usingProxy; // proxies may 30x to the rendered page
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(requestUrl, {
        headers: {
          "user-agent": userAgent,
          "accept-language": "en-US,en;q=0.9",
          accept: "text/html,application/xhtml+xml",
        },
        // Direct eBay path: never follow an off-host redirect (SSRF) — a redirect
        // (e.g. a consent interstitial) means "blocked" → decline to the next tier.
        // Proxy path: the proxy is trusted, and some return the page via a redirect.
        redirect: followRedirect ? "follow" : "error",
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`eBay sold fetch failed: ${res.status} ${res.statusText}`);
      }
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Tier "ebay-sold": price an identifiable item from real eBay sold comps. Slots
 * ABOVE the web-search tiers in the router (sold beats asking). Declines (null)
 * — never throws — when disabled, unidentifiable, blocked, or too thin, so the
 * router falls through to the web-search / estimate tiers. Invalid operator
 * proxy configuration instead throws during provider creation, before egress.
 */
type EbaySoldRetrievalAuthority = "normal" | "operator-smoke-one-request";

function createEbaySoldPricingProviderInternal(
  options: EbaySoldPricingProviderOptions = {},
  authority: EbaySoldRetrievalAuthority,
): PricingProvider {
  const enabled = options.enabled ?? ebaySoldConfigured();
  const baseUrl = options.baseUrl ?? resolveBaseUrl();
  const maxResults = options.maxResults ?? EBAY_SOLD_MAX_RESULTS;
  const operatorSmokeOneRequest = authority === "operator-smoke-one-request";
  const allowExpansion = !operatorSmokeOneRequest;
  const effectiveFetchTimeoutMs = boundedTimeoutMs(
    options.fetchTimeoutMs ?? resolveTimeoutMs(),
  );
  const configuredEgress = options.fetchPage
    ? { mode: "injected" as const }
    : resolveEbaySoldEgressConfig();
  const fetchPrimary =
    options.fetchPage ??
    createDefaultFetchPage({
      userAgent: options.userAgent,
      timeoutMs: effectiveFetchTimeoutMs,
      proxyTemplate:
        configuredEgress.mode === "proxy" ? configuredEgress.template : "",
    });
  const fetchFallback = operatorSmokeOneRequest
    ? undefined
    : options.fetchPageFallback;
  // Freshness (#59): `now` activates age-decay. The raw provider accepts an
  // injected shared cache for deterministic tests; `createDefaultPricer` wires
  // the real clock + cache in normal composition.
  const cache = options.cache;
  const inFlight = runtimeStateFor(cache).inFlight;
  const claimSharedRetrieval =
    cache?.scope === "shared" && typeof cache.claim === "function"
      ? cache.claim.bind(cache)
      : null;
  const getSharedClaimOwner =
    cache?.scope === "shared" && typeof cache.getClaimOwner === "function"
      ? cache.getClaimOwner.bind(cache)
      : null;
  const requiresSharedFence =
    !operatorSmokeOneRequest &&
    (configuredEgress.mode !== "direct" || fetchFallback !== undefined);
  const maximumRequestCount = allowExpansion ? 2 : 1;
  const handoffWaitMs =
    effectiveFetchTimeoutMs * maximumRequestCount +
    EBAY_SOLD_HANDOFF_STORE_READ_ALLOWANCE_MS;
  const now = options.now;
  const staleDays = options.staleDays ?? resolveStaleDays();
  const halfLifeDays = options.halfLifeDays ?? resolveHalfLifeDays();
  const emitDiagnostic = options.emitDiagnostic ?? logEvent;
  const normalizeBoundedCandidates = (
    comps: readonly EbaySoldComp[],
  ): EbaySoldComp[] =>
    normalizeEbaySoldCompUrls(comps).slice(0, EBAY_SOLD_MAX_RESULTS);

  const identifiable = (signal: ItemSignal): boolean =>
    buildSoldSearchUrl(signal, baseUrl) !== null;

  async function fetchWithinEffectiveTimeout(
    fetchPage: FetchPage,
    url: string,
    coordinationDeadline: number,
  ): Promise<string> {
    const remainingMs = coordinationDeadline - Date.now();
    if (remainingMs <= 0) {
      throw new DOMException("aborted", "AbortError");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fetchPage(url),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new DOMException("aborted", "AbortError")),
            Math.min(effectiveFetchTimeoutMs, remainingMs),
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function cacheKey(url: string, signal: ItemSignal): string {
    return JSON.stringify({
      url,
      retrievalPolicy: "initial-10-expand-20-v1",
      matcherSignal: {
        isbn: signal.isbn?.trim() ?? "",
        upc: signal.upc?.trim() ?? "",
        brand: signal.brand?.trim() ?? "",
        model: signal.model?.trim() ?? "",
        category: signal.category?.trim() ?? "",
        conditionKnown: signal.conditionKnown === true,
        condition: signal.condition?.trim() ?? "",
        resolvedName: signal.resolvedName?.trim() ?? "",
        specs: signal.specs?.map((spec) => spec.trim()) ?? [],
      },
    });
  }

  async function waitForClaimWinner(
    key: string,
    deadline: number,
  ): Promise<EbaySoldComp[] | null> {
    if (!cache) return null;
    let delayMs = 0;
    while (true) {
      if (delayMs > 0) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        // Do not let exponential backoff consume the entire handoff window.
        // Waking halfway through the remaining budget leaves a bounded cache
        // observation that can see evidence stored during the final interval.
        await new Promise<void>((resolve) =>
          setTimeout(
            resolve,
            Math.min(delayMs, Math.max(1, Math.floor(remainingMs / 2))),
          ),
        );
      }
      try {
        const handedOff = await settleBeforeCoordinationDeadline(
          (signal) => cache.get(key, signal),
          deadline,
        );
        if (handedOff === EBAY_SOLD_COORDINATION_DEADLINE_EXCEEDED) break;
        if (handedOff != null) return handedOff;
      } catch {
        emitDiagnostic("pricing.ebay_sold.cost_fence_unavailable", {
          reason: "handoff-read-failed",
        });
        return null;
      }
      if (Date.now() >= deadline) break;
      delayMs =
        delayMs === 0
          ? 50
          : Math.min(delayMs * 2, EBAY_SOLD_HANDOFF_POLL_MAX_MS);
    }
    emitDiagnostic("pricing.ebay_sold.cost_fence_unavailable", {
      reason: "handoff-timeout",
    });
    return null;
  }

  /**
   * Fetch + parse with graceful degradation. The `catch` wraps ONLY the network
   * fetch (parseSoldComps is total), so a block/rate-limit declines but a real
   * bug still surfaces. The Playwright-style fallback is tried when the primary
   * is blocked or returns too few comps.
   */
  async function fetchComps(
    url: string,
    fetchPage: FetchPage,
    parseLimit: number,
    blockedEvent: "pricing.ebay_sold.fetch_blocked" | "pricing.ebay_sold.fallback_blocked",
    coordinationDeadline: number,
  ): Promise<{ comps: EbaySoldComp[]; failed: boolean }> {
    // SSRF guard at the PROVIDER boundary so BOTH the default primary fetcher AND
    // an injected Playwright-style fallback are protected — a non-eBay/internal
    // EBAY_SOLD_BASE_URL must never reach EITHER seam (#56 review). Declines on a
    // bad URL rather than throwing, so the router falls through to web search.
    try {
      assertSafeEbayUrl(url);
    } catch {
      return { comps: [], failed: true };
    }
    try {
      return {
        comps: parseSoldComps(
          await fetchWithinEffectiveTimeout(
            fetchPage,
            url,
            coordinationDeadline,
          ),
          baseUrl,
          parseLimit,
        ),
        failed: false,
      };
    } catch (err) {
      // A block/rate-limit/timeout — declines, but is NO LONGER SILENT: without
      // this the tier vanished into a generic "declined" and the real reason (eBay
      // 403s direct server fetches) was invisible until someone dug into the logs.
      emitDiagnostic(blockedEvent, {
        reason: soldFetchFailureReason(err),
        ...(blockedEvent === "pricing.ebay_sold.fetch_blocked"
          ? {
              viaProxy: configuredEgress.mode === "proxy",
              hasFallback: fetchFallback != null,
            }
          : {}),
      });
      return { comps: [], failed: true };
    }
  }

  async function retrieveBoundedComps(
    signal: ItemSignal,
    initialUrl: string,
    coordinationDeadline: number,
  ): Promise<EbaySoldComp[]> {
    const initial = await fetchComps(
      initialUrl,
      fetchPrimary,
      Math.min(maxResults, EBAY_SOLD_RESULTS_PER_PAGE),
      "pricing.ebay_sold.fetch_blocked",
      coordinationDeadline,
    );
    let combined = normalizeBoundedCandidates(initial.comps);

    if (initial.failed) {
      if (fetchFallback) {
        const fallback = await fetchComps(
          initialUrl,
          fetchFallback,
          Math.min(maxResults, EBAY_SOLD_RESULTS_PER_PAGE),
          "pricing.ebay_sold.fallback_blocked",
          coordinationDeadline,
        );
        if (!fallback.failed) combined = normalizeBoundedCandidates(fallback.comps);
      }
    } else {
      const evidence = selectSoldCompEvidence(combined, signal);
      if (
        allowExpansion &&
        evidence.anchors.length < EBAY_SOLD_EXPANSION_THRESHOLD
      ) {
        const expandedUrl = buildSoldSearchUrl(signal, baseUrl, EBAY_SOLD_MAX_RESULTS);
        if (expandedUrl) {
          const expanded = await fetchComps(
            expandedUrl,
            fetchFallback ?? fetchPrimary,
            Math.min(maxResults, EBAY_SOLD_MAX_RESULTS),
            fetchFallback
              ? "pricing.ebay_sold.fallback_blocked"
              : "pricing.ebay_sold.fetch_blocked",
            coordinationDeadline,
          );
          if (!expanded.failed) {
            combined = normalizeBoundedCandidates([...expanded.comps, ...combined]);
          }
        }
      }
    }

    if (combined.length < EBAY_SOLD_MIN_COMPS) {
      emitDiagnostic("pricing.ebay_sold.declined_thin", { compsFound: combined.length });
    }
    return combined;
  }

  return {
    tier: "ebay-sold",
    canHandle: identifiable,
    async price(signal: ItemSignal): Promise<PriceResult | null> {
      if (!enabled) return null; // kill-switch → degrade to web tier
      const url = buildSoldSearchUrl(signal, baseUrl);
      if (!url) return null;
      const key = cacheKey(url, signal);
      const coordinationDeadline = Date.now() + handoffWaitMs;

      // Freshness cache (#59): a hit within TTL is reused (no fetch); a miss
      // live-fetches and stores. The live page stays the source of truth. Completed
      // terminal and sparse outcomes are cached too: retry/redelivery of the same
      // logical pricing pass must not start a third public retrieval. Relevance/freshness are
      // applied per-request AFTER the cache, so the cache holds the raw scrape keyed
      // by product identity plus the matcher-sensitive signal that controls expansion;
      // age-decay below re-runs on
      // every read, so a comp that goes stale while cached is still dropped.
      // The cache is an OPTIMIZATION, never pricing authority. The free no-proxy
      // default direct path may coordinate within one process. Configured proxy
      // and injected/instrumented normal fetchers require the existing atomic
      // shared claim so separate runtimes cannot multiply a potentially billable
      // bounded pass; an unavailable fence declines before egress. The separately
      // named operator smoke factory retains its one-request authority. Neither
      // path propagates cache failure into the listing pipeline.
      let comps: EbaySoldComp[] | null = null;
      if (cache) {
        try {
          const cached = await settleBeforeCoordinationDeadline(
            (signal) => cache.get(key, signal),
            coordinationDeadline,
          );
          if (cached === EBAY_SOLD_COORDINATION_DEADLINE_EXCEEDED) {
            emitDiagnostic("pricing.ebay_sold.cost_fence_unavailable", {
              reason: "initial-read-timeout",
            });
            return null;
          }
          comps = cached;
        } catch (err) {
          emitDiagnostic("pricing.cache.error", {
            op: "get",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (comps == null) {
        const existing = inFlight.get(key);
        if (existing) {
          const localResult = await settleBeforeCoordinationDeadline(
            () => existing,
            coordinationDeadline,
          );
          comps =
            localResult === EBAY_SOLD_COORDINATION_DEADLINE_EXCEEDED
              ? null
              : localResult;
        } else {
          const pending = (async () => {
            if (
              requiresSharedFence &&
              (!claimSharedRetrieval || !getSharedClaimOwner)
            ) {
              emitDiagnostic("pricing.ebay_sold.cost_fence_unavailable", {
                reason: "shared-cache-required",
              });
              return null;
            }
            if (requiresSharedFence && cache?.scope === "shared") {
              let claimed: boolean;
              const claimOwnerToken = globalThis.crypto.randomUUID();
              try {
                const claimResult = await settleMutationWithObservation(
                  (signal) =>
                    claimSharedRetrieval!(key, signal, claimOwnerToken),
                  (signal) => getSharedClaimOwner!(key, signal),
                  (owner) => owner === claimOwnerToken,
                  coordinationDeadline,
                  true,
                );
                if (
                  claimResult === EBAY_SOLD_COORDINATION_DEADLINE_EXCEEDED
                ) {
                  emitDiagnostic("pricing.ebay_sold.cost_fence_unavailable", {
                    reason: "shared-claim-timeout",
                  });
                  return null;
                } else if (
                  typeof claimResult === "object" &&
                  claimResult.kind === "observed"
                ) {
                  claimed = true;
                } else if (
                  typeof claimResult === "object" &&
                  claimResult.kind === "mutation"
                ) {
                  claimed = claimResult.value;
                } else {
                  claimed = claimResult;
                }
              } catch {
                emitDiagnostic("pricing.ebay_sold.cost_fence_unavailable", {
                  reason: "shared-claim-failed",
                });
                return null;
              }
              if (!claimed) {
                return waitForClaimWinner(key, coordinationDeadline);
              }
            }
            const retrieved = await retrieveBoundedComps(
              signal,
              url,
              coordinationDeadline,
            );
            if (cache) {
              try {
                const storeResult = await settleMutationWithObservation(
                  (signal) => cache.set(key, retrieved, signal),
                  (signal) => cache.get(key, signal),
                  () => true,
                  coordinationDeadline,
                );
                if (
                  storeResult === EBAY_SOLD_COORDINATION_DEADLINE_EXCEEDED
                ) {
                  emitDiagnostic("pricing.ebay_sold.cost_fence_unavailable", {
                    reason: "winner-store-timeout",
                  });
                  return null;
                }
                if (storeResult.kind === "observed") {
                  return storeResult.value;
                }
              } catch (err) {
                emitDiagnostic("pricing.cache.error", {
                  op: "set",
                  error: err instanceof Error ? err.message : String(err),
                });
                return null;
              }
            }
            return retrieved;
          })().finally(() => {
            inFlight.delete(key);
          });
          inFlight.set(key, pending);
          comps = await pending;
        }
      }
      if (comps == null) return null;

      // Relevance gate (#56 review): drop accessories/parts/wrong-model/broken
      // listings eBay returns for the query, so two clustered accessory sales
      // can't price the main item near an accessory price.
      const normalizedComps = normalizeBoundedCandidates(comps);
      const evidence = selectSoldCompEvidence(normalizedComps, signal);
      const relevant = evidence.anchors.map((entry) => entry.comp);
      // Age-decay (#59), opt-in via `now`: drop comps with a known stale sale date,
      // then recency-weight the suggested price toward more recent sales.
      const tNow = now?.();
      const fresh =
        tNow != null ? selectFreshComps(relevant, tNow, staleDays) : relevant;
      const freshSet = new Set(fresh);
      const retained = selectVerifiedSoldMatches(
        evidence.anchors.filter(({ comp }) => freshSet.has(comp)),
      );
      if (retained.length < EBAY_SOLD_MIN_COMPS) return null; // too thin → decline
      const evidenceWeights = new Map(
        retained.map((entry) => [entry.comp, entry.score]),
      );
      return synthesizeSoldResult(
        retained.map(({ comp }) => comp),
        {
          ...(tNow != null ? { now: tNow, halfLifeDays } : {}),
          evidenceWeight: (comp) => evidenceWeights.get(comp) ?? 1,
        },
      );
    },
  };
}

export function createEbaySoldPricingProvider(
  options: EbaySoldPricingProviderOptions = {},
): PricingProvider {
  return createEbaySoldPricingProviderInternal(options, "normal");
}

/**
 * Narrow operator-authorized smoke mode. This is deliberately a separate,
 * explicit factory so normal provider construction cannot accidentally bypass
 * the shared cost fence. It always suppresses the optional expansion.
 */
export function createOneRequestEbaySoldPricingProviderForOperatorSmoke(
  options: EbaySoldPricingProviderOptions = {},
): PricingProvider {
  return createEbaySoldPricingProviderInternal(
    options,
    "operator-smoke-one-request",
  );
}
