import { load } from "cheerio";
import type {
  ItemSignal,
  PriceResult,
  PriceSource,
  PricingProvider,
} from "../types";
import { TIGHT_AGREEMENT_MIN, spreadToAgreement } from "./web-search";

/**
 * Tier "ebay-sold" — a scraper over eBay's PUBLIC sold-listings pages (issue #56).
 *
 * Why this exists (ADR-0001): used-item *sold* prices are the ground truth for
 * pricing, but there is no free API for them — eBay's Marketplace Insights is
 * gated, and the open web mostly surfaces *asking* prices. eBay's sold/completed
 * results pages (`LH_Sold=1&LH_Complete=1`) are, however, publicly visible with
 * no login. This provider reads them as real **sold comps** and slots ABOVE the
 * web-search tiers, so a sold-grounded price wins over open-web asking comps.
 *
 * Honest boundaries:
 *  - READ-ONLY price research. We never scrape to post (export packs stay).
 *  - No login → no account risk; the only failure mode is an IP rate-limit /
 *    CAPTCHA. That is an EXPECTED, recoverable condition, so a blocked scrape
 *    DECLINES (returns `null`) and the router falls through to the legal
 *    web-search tier — it never hard-fails the pricing call.
 *  - Cache-on-miss / TTL freshness is a SEPARATE slice (#59); this provider
 *    live-fetches each call.
 *
 * Default path is plain `fetch` + `cheerio` parse. A Playwright-style fallback
 * is modeled as an injectable `fetchPageFallback` seam (tried when the primary
 * is blocked); the concrete headless driver is intentionally NOT bundled yet
 * (heavy browser dep, unvalidated against live blocking) — wiring it is a
 * flagged follow-up alongside #59. Every network dependency is INJECTED (same
 * DI style as `providers/web-search.ts`), so the contract test runs fully
 * offline against a saved HTML fixture.
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
}

export interface EbaySoldPricingProviderOptions {
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
  /** Per-fetch timeout (ms); defaults to `EBAY_SOLD_TIMEOUT_MS` env or 8000. */
  fetchTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Config (env-configurable everything — read lazily, never at import)
// ---------------------------------------------------------------------------

export const EBAY_SOLD_BASE_URL_DEFAULT = "https://www.ebay.com";
/** A desktop UA — eBay serves the classic SRP markup the parser targets to these. */
export const EBAY_SOLD_USER_AGENT_DEFAULT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 SnapList/1.0 (+pricing research)";
/** eBay shows up to this many results per page; one fetch is plenty of comps. */
export const EBAY_SOLD_RESULTS_PER_PAGE = 120;
/** Parse cap — a pathological page can't blow memory / downstream cost. */
export const EBAY_SOLD_MAX_RESULTS = 60;
/** Fewer than this many sold comps = "nothing useful" → decline. */
export const EBAY_SOLD_MIN_COMPS = 2;

/**
 * Per-fetch timeout. A stalled eBay response (connection accepted, body never
 * sent) must ABORT so the provider's catch can decline — otherwise the request
 * hangs until the serverless deadline and the promised graceful fallback never
 * runs (#56 review). Overridable via `EBAY_SOLD_TIMEOUT_MS`.
 */
export const EBAY_SOLD_FETCH_TIMEOUT_MS = 8000;

/** The only host family this provider will ever fetch. */
export const EBAY_ALLOWED_HOST = "ebay.com";

function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.EBAY_SOLD_BASE_URL?.trim() || EBAY_SOLD_BASE_URL_DEFAULT;
}

function resolveUserAgent(env: NodeJS.ProcessEnv = process.env): string {
  return env.EBAY_SOLD_USER_AGENT?.trim() || EBAY_SOLD_USER_AGENT_DEFAULT;
}

function resolveTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.EBAY_SOLD_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : EBAY_SOLD_FETCH_TIMEOUT_MS;
}

/**
 * Is the scraper enabled? On by default; `EBAY_SOLD_ENABLED=false|0|off` is a
 * kill-switch that makes the tier decline (degrade to the web-search tier)
 * without code changes — env-configurable everything (AGENTS.md).
 */
export function ebaySoldConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
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
 * URL otherwise. The default fetcher calls this before EVERY request.
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
function identityQuery(signal: ItemSignal): string | null {
  const brand = signal.brand?.trim();
  const model = signal.model?.trim();
  if (brand && model) return `${brand} ${model}`;
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
): string | null {
  const q = identityQuery(signal);
  if (!q) return null;
  const url = new URL("/sch/i.html", baseUrl);
  url.searchParams.set("_nkw", q);
  url.searchParams.set("LH_Sold", "1");
  url.searchParams.set("LH_Complete", "1");
  url.searchParams.set("_ipg", String(EBAY_SOLD_RESULTS_PER_PAGE));
  return url.toString();
}

/**
 * Parse a price cell into a number. Handles `$178.00`, comma-grouped
 * `$1,299.99`, currency prefixes (`C $99.00`), and variation RANGES
 * (`$120.00 to $150.00` → the midpoint). Returns `null` for empty / non-priced
 * text (`Free`, ``). Pure and total — never throws.
 */
export function parsePrice(text: string | undefined): number | null {
  if (!text) return null;
  const groups = text.replace(/,/g, "").match(/\d+(?:\.\d+)?/g);
  if (!groups) return null;
  const values = groups.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (values.length === 0) return null;
  // A range cell ("$120 to $150") → midpoint; a single price → itself.
  return values.length >= 2 ? (values[0] + values[1]) / 2 : values[0];
}

/**
 * Parse the sold-results HTML into comps. Reads eBay's classic SRP card markup
 * (`ul.srp-results > li.s-item` with `.s-item__title`, `.s-item__price`,
 * `a.s-item__link`), skipping the leading "Shop on eBay" placeholder and any
 * card without a parseable price or item link, and deduping by URL. Pure and
 * TOTAL: any malformed page yields `[]`, never a throw — so the provider's fetch
 * `catch` can stay narrow (around the network only) and not mask real bugs.
 *
 * NOTE: eBay's markup can change. The selectors are validated by the saved
 * fixture contract test; live-page validation + a refresh strategy ride with
 * the freshness slice (#59) and the Playwright fallback.
 */
export function parseSoldComps(
  html: string,
  baseUrl: string = EBAY_SOLD_BASE_URL_DEFAULT,
  max: number = EBAY_SOLD_MAX_RESULTS,
): EbaySoldComp[] {
  const $ = load(html);
  const comps: EbaySoldComp[] = [];
  const seen = new Set<string>();

  $("li.s-item").each((_i, el) => {
    if (comps.length >= max) return false; // hit the cap — stop iterating

    const card = $(el);
    const title = card
      .find(".s-item__title")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^New Listing/i, "")
      .trim();
    if (!title || /^shop on ebay$/i.test(title)) return; // placeholder / empty

    const price = parsePrice(card.find(".s-item__price").first().text());
    if (price == null) return;

    const href = card.find("a.s-item__link").first().attr("href");
    if (!href) return;
    let url: string;
    try {
      url = new URL(href, baseUrl).toString();
    } catch {
      return;
    }
    if (seen.has(url)) return;
    seen.add(url);

    comps.push({ url, title, price });
  });

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
 * New/sealed-condition markers. SnapList prices USED goods, so a brand-new sold
 * listing is not a valid comp for a used item and would inflate the median —
 * UNLESS the seller's own item is new/like-new (then new comps are kept). Note
 * "Like New" (a used grade) is intentionally NOT matched here.
 */
const NEW_CONDITION_RE =
  /\b(brand[- ]?new|new sealed|new in box|factory sealed|sealed|bnib|nib|nwt|never used|unopened)\b/i;

function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Does the comp plausibly refer to the SAME product as the signal? When a model
 * is known it MUST appear in the title (normalized, so "WH-1000XM4" matches
 * "WH 1000XM4"). For identity by resolved name / UPC / ISBN we can't token-match
 * the title reliably, so we trust eBay's exact-query result set and rely on the
 * accessory/parts filter alone.
 */
export function matchesIdentity(title: string, signal: ItemSignal): boolean {
  const model = signal.model?.trim();
  if (signal.brand?.trim() && model) {
    return normalizeToken(title).includes(normalizeToken(model));
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

/** Is the seller's OWN item new/like-new (so new-condition comps are valid)? */
function sellerItemIsNew(signal: ItemSignal): boolean {
  return (signal.condition?.toLowerCase() ?? "").includes("new");
}

/**
 * Is the comp an accessory/part rather than the item itself? True when an
 * accessory term is in the title AND that term is NOT part of the item's own
 * identity — so a seller actually selling a "Controller"/"Dock" keeps those comps,
 * while a controller sale leaking into a console search is dropped.
 */
export function isAccessoryOrParts(title: string, signal: ItemSignal): boolean {
  const m = ACCESSORY_OR_PARTS_RE.exec(title);
  if (!m) return false;
  return !identityText(signal).includes(m[1].toLowerCase());
}

/**
 * Keep only comps that (a) match the item identity, (b) aren't accessories/parts,
 * and (c) aren't new/sealed when the seller's item is used (#56 review: new sold
 * listings would otherwise inflate a used item's median past the autopilot gate).
 */
export function filterRelevantComps(
  comps: readonly EbaySoldComp[],
  signal: ItemSignal,
): EbaySoldComp[] {
  const keepNew = sellerItemIsNew(signal);
  return comps.filter((c) => {
    const title = c.title ?? "";
    if (!matchesIdentity(title, signal)) return false;
    if (isAccessoryOrParts(title, signal)) return false;
    if (!keepNew && NEW_CONDITION_RE.test(title)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Synthesis — the cited, sold-grounded PriceResult
// ---------------------------------------------------------------------------

/**
 * Base trust for an eBay-sold price. These are VERIFIED completed sales on the
 * marketplace itself — stronger than LLM-extracted open-web comps (web-search's
 * 0.65 sold base) but kept below a structured ISBN lookup. The provisional value
 * is a sane floor; the canonical autopilot-gating confidence is recomputed by
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
 * Synthesize the cited `PriceResult` from sold comps. Suggested = median; range
 * = min..max band; comp agreement = `1 - relativeSpread` (the SAME mapping the
 * web tier uses, so the confidence composite reads tightness identically across
 * tiers). Every source is a `sold-comp` (these are completed sales), and no
 * `model` is claimed — the tier is deterministic, no LLM involved.
 */
export function synthesizeSoldResult(comps: readonly EbaySoldComp[]): PriceResult {
  if (comps.length === 0) {
    throw new Error("synthesizeSoldResult requires at least one comp");
  }
  const prices = comps.map((c) => c.price).sort((a, b) => a - b);
  const suggested = median(prices);
  const min = prices[0];
  const max = prices[prices.length - 1];
  const spread = prices.length > 1 && suggested > 0 ? (max - min) / suggested : 0;
  const agreement = spreadToAgreement(spread);

  const confidence = Math.min(
    EBAY_SOLD_MAX_CONFIDENCE,
    EBAY_SOLD_BASE_CONFIDENCE +
      (agreement >= TIGHT_AGREEMENT_MIN ? EBAY_SOLD_AGREEMENT_BONUS : 0) +
      (comps.length >= EBAY_SOLD_COVERAGE_THRESHOLD ? EBAY_SOLD_COVERAGE_BONUS : 0),
  );

  const sources: PriceSource[] = comps.map((c) => ({
    url: c.url,
    title: c.title,
    kind: "sold-comp",
  }));

  return {
    suggested: round2(suggested),
    range: { min: round2(min), max: round2(max) },
    confidence,
    sources,
    tier: "ebay-sold",
    // The judged tightness rides downstream so a scattered sold set cannot ride
    // the sold-comp label into the autopilot-grade confidence band.
    compAgreement: agreement,
  };
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/**
 * The real default fetcher: SSRF-guarded `fetch`, no off-host redirects, and a
 * bounded timeout so a stalled response aborts (→ the provider declines) instead
 * of hanging until the serverless deadline. `fetchImpl` is injectable so the
 * timeout + SSRF behavior are unit-testable without a live network.
 */
export function createDefaultFetchPage(
  opts: { userAgent?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): FetchPage {
  const userAgent = opts.userAgent ?? resolveUserAgent();
  const timeoutMs = opts.timeoutMs ?? resolveTimeoutMs();
  const doFetch = opts.fetchImpl ?? fetch;
  return async (rawUrl) => {
    const safe = assertSafeEbayUrl(rawUrl); // validate BEFORE any request
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(safe, {
        headers: {
          "user-agent": userAgent,
          "accept-language": "en-US,en;q=0.9",
          accept: "text/html,application/xhtml+xml",
        },
        // Never follow an off-host redirect (SSRF). eBay returns 200 directly for
        // a sold-results query; a redirect (e.g. a consent interstitial) is
        // treated as "blocked" → the provider declines to the next tier.
        redirect: "error",
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
 * router falls through to the web-search / estimate tiers.
 */
export function createEbaySoldPricingProvider(
  options: EbaySoldPricingProviderOptions = {},
): PricingProvider {
  const baseUrl = options.baseUrl ?? resolveBaseUrl();
  const maxResults = options.maxResults ?? EBAY_SOLD_MAX_RESULTS;
  const fetchPrimary =
    options.fetchPage ??
    createDefaultFetchPage({
      userAgent: options.userAgent,
      timeoutMs: options.fetchTimeoutMs,
    });
  const fetchFallback = options.fetchPageFallback;

  const identifiable = (signal: ItemSignal): boolean =>
    buildSoldSearchUrl(signal, baseUrl) !== null;

  /**
   * Fetch + parse with graceful degradation. The `catch` wraps ONLY the network
   * fetch (parseSoldComps is total), so a block/rate-limit declines but a real
   * bug still surfaces. The Playwright-style fallback is tried when the primary
   * is blocked or returns too few comps.
   */
  async function fetchComps(url: string): Promise<EbaySoldComp[]> {
    let comps: EbaySoldComp[] = [];
    try {
      comps = parseSoldComps(await fetchPrimary(url), baseUrl, maxResults);
    } catch {
      comps = [];
    }
    if (comps.length < EBAY_SOLD_MIN_COMPS && fetchFallback) {
      try {
        comps = parseSoldComps(await fetchFallback(url), baseUrl, maxResults);
      } catch {
        // Fallback also blocked → decline below.
      }
    }
    return comps;
  }

  return {
    tier: "ebay-sold",
    canHandle: identifiable,
    async price(signal: ItemSignal): Promise<PriceResult | null> {
      if (!ebaySoldConfigured()) return null; // kill-switch → degrade to web tier
      const url = buildSoldSearchUrl(signal, baseUrl);
      if (!url) return null;
      const comps = await fetchComps(url);
      // Relevance gate (#56 review): drop accessories/parts/wrong-model/broken
      // listings eBay returns for the query, so two clustered accessory sales
      // can't price the main item near an accessory price.
      const relevant = filterRelevantComps(comps, signal);
      if (relevant.length < EBAY_SOLD_MIN_COMPS) return null; // too thin → decline
      return synthesizeSoldResult(relevant);
    },
  };
}
