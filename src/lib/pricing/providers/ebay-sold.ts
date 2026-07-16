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
import { selectSoldCompEvidence } from "../sold-comp-matcher";

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
 *  - Cache-on-miss / TTL freshness is opt-in on the raw provider; the production
 *    composition root wires the shared cache and age-decay layer (#59).
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
  /** Per-fetch timeout (ms); defaults to `EBAY_SOLD_TIMEOUT_MS` env or 8000. */
  fetchTimeoutMs?: number;
  /** Diagnostic sink; tests/operator smoke may silence structured runtime logs. */
  emitDiagnostic?: (event: string, fields: LogFields) => void;
  // -- Freshness (#59). All OPT-IN: the raw provider stays clock-free and
  //    cache-free (so unit tests are deterministic); `createDefaultPricer` wires
  //    the real clock + shared cache for production. --
  /**
   * TTL cache of sold-comp scrapes keyed by the resolved search URL (= product
   * identity). A hit within the TTL is reused (no fetch); a miss live-fetches and
   * stores. Omitted → always live-fetch (the live page is the source of truth).
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
): string | null {
  const q = identityQuery(signal);
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
    url.searchParams.set("_ipg", String(EBAY_SOLD_RESULTS_PER_PAGE));
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

  return {
    suggested: round2(suggested),
    range: { min: round2(min), max: round2(max) },
    confidence,
    sources,
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
  const timeoutMs = opts.timeoutMs ?? resolveTimeoutMs();
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
export function createEbaySoldPricingProvider(
  options: EbaySoldPricingProviderOptions = {},
): PricingProvider {
  const enabled = options.enabled ?? ebaySoldConfigured();
  const baseUrl = options.baseUrl ?? resolveBaseUrl();
  const maxResults = options.maxResults ?? EBAY_SOLD_MAX_RESULTS;
  const configuredEgress = options.fetchPage
    ? { mode: "injected" as const }
    : resolveEbaySoldEgressConfig();
  const fetchPrimary =
    options.fetchPage ??
    createDefaultFetchPage({
      userAgent: options.userAgent,
      timeoutMs: options.fetchTimeoutMs,
      proxyTemplate:
        configuredEgress.mode === "proxy" ? configuredEgress.template : "",
    });
  const fetchFallback = options.fetchPageFallback;
  // Freshness (#59) — opt-in. `now` activates age-decay; `cache` activates the
  // TTL request cache. Both default OFF in the raw provider (deterministic unit
  // tests); `createDefaultPricer` wires the real clock + shared cache.
  const cache = options.cache;
  const now = options.now;
  const staleDays = options.staleDays ?? resolveStaleDays();
  const halfLifeDays = options.halfLifeDays ?? resolveHalfLifeDays();
  const emitDiagnostic = options.emitDiagnostic ?? logEvent;

  const identifiable = (signal: ItemSignal): boolean =>
    buildSoldSearchUrl(signal, baseUrl) !== null;

  /**
   * Fetch + parse with graceful degradation. The `catch` wraps ONLY the network
   * fetch (parseSoldComps is total), so a block/rate-limit declines but a real
   * bug still surfaces. The Playwright-style fallback is tried when the primary
   * is blocked or returns too few comps.
   */
  async function fetchComps(url: string): Promise<EbaySoldComp[]> {
    // SSRF guard at the PROVIDER boundary so BOTH the default primary fetcher AND
    // an injected Playwright-style fallback are protected — a non-eBay/internal
    // EBAY_SOLD_BASE_URL must never reach EITHER seam (#56 review). Declines on a
    // bad URL rather than throwing, so the router falls through to web search.
    try {
      assertSafeEbayUrl(url);
    } catch {
      return [];
    }
    let comps: EbaySoldComp[] = [];
    try {
      comps = parseSoldComps(await fetchPrimary(url), baseUrl, maxResults);
    } catch (err) {
      // A block/rate-limit/timeout — declines, but is NO LONGER SILENT: without
      // this the tier vanished into a generic "declined" and the real reason (eBay
      // 403s direct server fetches) was invisible until someone dug into the logs.
      emitDiagnostic("pricing.ebay_sold.fetch_blocked", {
        reason: soldFetchFailureReason(err),
        viaProxy: configuredEgress.mode === "proxy",
        hasFallback: fetchFallback != null,
      });
      comps = [];
    }
    if (comps.length < EBAY_SOLD_MIN_COMPS && fetchFallback) {
      try {
        comps = parseSoldComps(await fetchFallback(url), baseUrl, maxResults);
      } catch (err) {
        emitDiagnostic("pricing.ebay_sold.fallback_blocked", {
          reason: soldFetchFailureReason(err),
        });
      }
    }
    if (comps.length < EBAY_SOLD_MIN_COMPS) {
      // Distinguish "blocked/thin" (declining to web search) from "found comps" so
      // the pricing spine is auditable: which tier actually fired, and why not this one.
      emitDiagnostic("pricing.ebay_sold.declined_thin", { compsFound: comps.length });
    }
    return comps;
  }

  return {
    tier: "ebay-sold",
    canHandle: identifiable,
    async price(signal: ItemSignal): Promise<PriceResult | null> {
      if (!enabled) return null; // kill-switch → degrade to web tier
      const url = buildSoldSearchUrl(signal, baseUrl);
      if (!url) return null;

      // Freshness cache (#59): a hit within TTL is reused (no fetch); a miss
      // live-fetches and stores. The live page stays the source of truth. Only a
      // scrape that yielded ≥ MIN raw comps is cached — a 0/1-comp result is almost
      // always a block or placeholder page, and caching it would suppress the retry
      // that the graceful-degradation design depends on. Relevance/freshness are
      // applied per-request AFTER the cache, so the cache holds the raw scrape keyed
      // by the resolved search URL (= product identity); age-decay below re-runs on
      // every read, so a comp that goes stale while cached is still dropped.
      // The cache is an OPTIMIZATION, never the source of truth: a cache (Upstash)
      // outage must DEGRADE — treat a read failure as a miss (live-fetch) and a
      // write failure as a no-op — not propagate, which the router would treat as a
      // hard error and crash the whole listing run. This preserves the provider's
      // "never hard-fails the pricing call; declines to the web tier" contract,
      // mirroring the fail-open rate limiter (#58) and the fetchComps catch (#59 review).
      let comps: EbaySoldComp[] | null = null;
      if (cache) {
        try {
          comps = await cache.get(url);
        } catch (err) {
          emitDiagnostic("pricing.cache.error", {
            op: "get",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (comps == null) {
        comps = await fetchComps(url);
        if (cache && comps.length >= EBAY_SOLD_MIN_COMPS) {
          try {
            await cache.set(url, comps);
          } catch (err) {
            emitDiagnostic("pricing.cache.error", {
              op: "set",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // Relevance gate (#56 review): drop accessories/parts/wrong-model/broken
      // listings eBay returns for the query, so two clustered accessory sales
      // can't price the main item near an accessory price.
      const evidence = selectSoldCompEvidence(comps, signal);
      const relevant = evidence.anchors.map((entry) => entry.comp);
      const evidenceWeights = new Map(
        evidence.anchors.map((entry) => [entry.comp, entry.score]),
      );

      // Age-decay (#59), opt-in via `now`: drop comps with a known stale sale date,
      // then recency-weight the suggested price toward more recent sales.
      const tNow = now?.();
      const fresh =
        tNow != null ? selectFreshComps(relevant, tNow, staleDays) : relevant;
      if (fresh.length < EBAY_SOLD_MIN_COMPS) return null; // too thin → decline
      return synthesizeSoldResult(
        fresh,
        {
          ...(tNow != null ? { now: tNow, halfLifeDays } : {}),
          evidenceWeight: (comp) => evidenceWeights.get(comp) ?? 1,
        },
      );
    },
  };
}
