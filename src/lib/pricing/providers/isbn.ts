import type {
  ItemSignal,
  PriceResult,
  PriceSource,
  PricingProvider,
} from "../types";
import {
  canonicalizeCondition,
  isPricedItemCondition,
  type PricedItemCondition,
} from "../../items/condition";

/**
 * Tier 1 — the ISBN `PricingProvider` (`isbn-lookup`).
 *
 * PRD §"Pricing pipeline": "ISBN present → true structured lookup
 * (Open Library + Google Books, free). Highest confidence." AGENTS.md
 * §"Barcode tier split": ISBN is a *true structured lookup*, never a guess.
 *
 * For an ISBN-bearing signal we resolve the canonical edition/metadata from
 * BOTH free APIs and synthesize a defensible **used-book** price band, citing
 * both API records as `sources[]`. This is the highest-confidence tier; a clean
 * single-edition hit reports high confidence. When neither API yields a usable
 * priced match we DECLINE (return `null`) so the router falls through — we never
 * fabricate a number with empty sources.
 *
 * The HTTP client is INJECTED (`fetchJson`) — same dependency-injection + lazy
 * style as `src/lib/rag/embedding.ts` — so tests run fully offline against canned
 * Open Library / Google Books payloads, and the default uses the platform `fetch`.
 */

// ---------------------------------------------------------------------------
// Injected HTTP seam
// ---------------------------------------------------------------------------

/**
 * Fetch a JSON document by URL. Returns the parsed body, or `null` when the
 * resource is absent (e.g. Open Library 404 for an unknown ISBN). Throwing
 * signals a genuine upstream failure (network/5xx) — NOT a decline — matching
 * the router contract (a thrown `price` is a hard error).
 */
export type FetchJson = (url: string) => Promise<unknown | null>;

/**
 * Optional sold-comp lookup for the SAME signal (#2 confidence lever). Returns an
 * eBay-sold `PriceResult` (real completed sales) or `null` when none are found /
 * the scraper is unconfigured or blocked. Injected by the wiring layer
 * (`createDefaultPricer`) from the same eBay-sold provider used as the standalone
 * tier — so a book is priced from REAL used sales, and the result, by citing a
 * `sold-comp` source, earns the top `isbn` (0.95) confidence tier instead of the
 * retail-derived `depreciation` floor (see `confidence/from-price.ts` → `hasSoldComp`).
 * Left undefined the provider keeps its pure catalog-only behavior (offline tests).
 */
export type SoldLookup = (signal: ItemSignal) => Promise<PriceResult | null>;

/**
 * Default `fetchJson` over the platform `fetch`. A 404 (missing record) maps to
 * `null` so the provider can treat it as "no match here"; other non-2xx
 * responses throw as upstream failures.
 */
const defaultFetchJson: FetchJson = async (url) => {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`ISBN lookup failed: ${res.status} ${res.statusText} (${url})`);
  }
  return (await res.json()) as unknown;
};

// ---------------------------------------------------------------------------
// Used-price heuristic (documented, honest, cited)
// ---------------------------------------------------------------------------

/**
 * Used-book pricing heuristic.
 *
 * We do NOT have true sold comps for the ISBN tier (eBay Marketplace Insights is
 * gated; Open Library / Google Books expose *list/retail* prices, not resale).
 * So we anchor on the discovered list/retail price and apply an honest, fixed
 * depreciation: a typical good-condition used trade paperback sells for roughly
 * HALF of its current retail. We center the suggestion at that fraction and
 * quote a band around it. The band's TOP never exceeds retail (a used copy
 * should not be listed above a new one).
 *
 * `USED_PRICE_FRACTION` is the center (good-condition) multiplier; the band
 * spans ±`BAND_SPREAD` around it. A condition signal nudges the center via
 * `CONDITION_FACTORS` (better condition → closer to retail). All of this is
 * exported/visible so the suggestion is auditable, and every result still cites
 * the underlying API records.
 */
export const USED_PRICE_FRACTION = 0.5;

/** Half-width of the band as a fraction of the center (±25%). */
const BAND_SPREAD = 0.25;

/**
 * Condition → multiplier on the used center. "good" is the baseline (1.0); a
 * like-new copy prices nearer retail, a poor copy well below. Unknown/absent
 * condition falls back to the baseline.
 */
const CONDITION_FACTORS = {
  new: 1.4,
  "like-new": 1.25,
  "very-good": 1.1,
  good: 1.0,
  acceptable: 0.85,
  fair: 0.8,
  poor: 0.6,
} satisfies Record<PricedItemCondition, number>;

function conditionFactor(condition?: string): number {
  if (!condition) return 1;
  const key = canonicalizeCondition(condition);
  return isPricedItemCondition(key) ? CONDITION_FACTORS[key] : 1;
}

// ---------------------------------------------------------------------------
// API endpoints
// ---------------------------------------------------------------------------

// The ISBN arrives from vision/barcode extraction and is only trimmed, never
// charset-validated, so encode it before interpolation. The host is fixed (not
// an SSRF vector), but a stray `&`/`?`/`#`/space in a misread code would
// otherwise corrupt the path or inject a query param into the lookup. A valid
// ISBN (digits, `X`, hyphens — all URL-unreserved) is unchanged by this.
function openLibraryUrl(isbn: string): string {
  return `https://openlibrary.org/isbn/${encodeURIComponent(isbn)}.json`;
}

function googleBooksUrl(isbn: string): string {
  return `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}`;
}

// ---------------------------------------------------------------------------
// Minimal shapes of the API responses we read (defensive — only what we use)
// ---------------------------------------------------------------------------

interface OpenLibraryEdition {
  title?: string;
  key?: string; // e.g. "/books/OL7353617M"
}

interface GoogleMoney {
  amount?: number;
  currencyCode?: string;
}

interface GoogleVolume {
  id?: string;
  volumeInfo?: {
    title?: string;
    infoLink?: string;
  };
  saleInfo?: {
    saleability?: string;
    listPrice?: GoogleMoney;
    retailPrice?: GoogleMoney;
  };
}

interface GoogleBooksResponse {
  totalItems?: number;
  items?: GoogleVolume[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// ---------------------------------------------------------------------------
// Lookup helpers — resolve metadata + any list/retail price, build a citation
// ---------------------------------------------------------------------------

interface ResolvedHit {
  /** Cited source records (one per API that yielded a usable record). */
  sources: PriceSource[];
  /** Best human-readable title we resolved (for the suggestion + citations). */
  title?: string;
  /** A list/retail anchor price in USD, if any API exposed one. */
  anchorPrice?: number;
  /** Whether exactly one canonical edition matched (clean hit → high confidence). */
  cleanHit: boolean;
}

/** Resolve the Open Library edition record into a citation + title. */
function readOpenLibrary(
  isbn: string,
  body: unknown | null,
): { source?: PriceSource; title?: string } {
  if (!isObject(body)) return {};
  const edition = body as OpenLibraryEdition;
  const title = typeof edition.title === "string" ? edition.title : undefined;
  // Prefer the canonical work key as the citation URL; fall back to the ISBN page.
  const url =
    typeof edition.key === "string"
      ? `https://openlibrary.org${edition.key}`
      : openLibraryUrl(isbn).replace(/\.json$/, "");
  return {
    title,
    source: {
      url,
      title: title ?? `Open Library record for ISBN ${isbn}`,
      kind: "isbn-lookup",
    },
  };
}

/** Resolve the Google Books volume into a citation + title + price anchor. */
function readGoogleBooks(
  isbn: string,
  body: unknown | null,
): {
  source?: PriceSource;
  title?: string;
  anchorPrice?: number;
  matched: boolean;
} {
  if (!isObject(body)) return { matched: false };
  const resp = body as GoogleBooksResponse;
  const items = Array.isArray(resp.items) ? resp.items : [];
  if (items.length === 0) return { matched: false };

  const volume = items[0];
  const info = volume.volumeInfo ?? {};
  const sale = volume.saleInfo ?? {};
  const title = typeof info.title === "string" ? info.title : undefined;

  // Prefer retail (actual sale price), then list price. Only USD anchors are used
  // so we never mix currencies into a USD band.
  const retail =
    sale.retailPrice?.currencyCode === "USD" ? sale.retailPrice?.amount : undefined;
  const list =
    sale.listPrice?.currencyCode === "USD" ? sale.listPrice?.amount : undefined;
  const anchorPrice =
    typeof retail === "number" && retail > 0
      ? retail
      : typeof list === "number" && list > 0
        ? list
        : undefined;

  const url =
    typeof info.infoLink === "string" && info.infoLink.length > 0
      ? info.infoLink
      : `https://books.google.com/books?q=isbn:${isbn}`;

  return {
    matched: true,
    title,
    anchorPrice,
    source: {
      url,
      title: title ?? `Google Books record for ISBN ${isbn}`,
      kind: "isbn-lookup",
    },
  };
}

/** Run both lookups (in parallel) and fold them into a single resolved hit. */
async function resolveHit(
  isbn: string,
  fetchJson: FetchJson,
): Promise<ResolvedHit | null> {
  const [olBody, gbBody] = await Promise.all([
    fetchJson(openLibraryUrl(isbn)),
    fetchJson(googleBooksUrl(isbn)),
  ]);

  const ol = readOpenLibrary(isbn, olBody);
  const gb = readGoogleBooks(isbn, gbBody);

  const sources: PriceSource[] = [];
  if (ol.source) sources.push(ol.source);
  if (gb.source) sources.push(gb.source);

  // No identification from either API → no usable match.
  if (sources.length === 0) return null;

  const title = gb.title ?? ol.title;
  // A "clean hit" = both APIs identified the same edition (strongest signal).
  const cleanHit = Boolean(ol.source) && gb.matched;

  return {
    sources,
    title,
    anchorPrice: gb.anchorPrice,
    cleanHit,
  };
}

// ---------------------------------------------------------------------------
// Price synthesis
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Build the `PriceResult` from a resolved hit + its anchor price. Returns `null`
 * if there is no price anchor to defend (we never invent a number) — the caller
 * then declines.
 */
function buildResult(hit: ResolvedHit, signal: ItemSignal): PriceResult | null {
  if (typeof hit.anchorPrice !== "number" || hit.anchorPrice <= 0) {
    // Identified the book but found no defensible price → decline rather than guess.
    return null;
  }

  const retail = hit.anchorPrice;
  const center = retail * USED_PRICE_FRACTION * conditionFactor(signal.condition);

  let min = center * (1 - BAND_SPREAD);
  let max = center * (1 + BAND_SPREAD);

  // A used copy should never be quoted above retail; clamp the band's top.
  if (max > retail) max = retail;
  if (min > max) min = max;

  // Center the suggestion within the (possibly clamped) band.
  const suggested = Math.min(Math.max(center, min), max);

  /**
   * Confidence: this is the highest-confidence tier. A clean single-edition hit
   * corroborated by BOTH APIs is reported high (0.9); a one-API match is still a
   * real structured lookup but slightly lower (0.8). The canonical confidence
   * composite recomputes downstream from signals — this is the tier's honest
   * provisional value.
   */
  const confidence = hit.cleanHit ? 0.9 : 0.8;

  return {
    suggested: round2(suggested),
    range: { min: round2(min), max: round2(max) },
    confidence,
    sources: hit.sources,
    tier: "isbn-lookup",
  };
}

/** Does a (sold) PriceResult cite at least one real completed-sale comp? */
function hasSoldComp(result: PriceResult): boolean {
  return result.sources.some((s) => s.kind === "sold-comp");
}

/**
 * Combine the structured ISBN identity with real eBay sold comps: price from the
 * SOLD result (real used sales beat retail × 0.5), keep the `isbn-lookup` tier, and
 * cite BOTH the catalog identity records and the sold comps. The merged sold-comp
 * source is what lets the pipeline bridge restore the top `isbn` confidence tier;
 * `compAgreement` rides along so a scattered sold set is still reflected honestly.
 * The provisional `confidence` is the higher of the sold result's and the tier's
 * own clean-hit value (the canonical composite recomputes downstream regardless).
 */
function buildSoldGroundedResult(
  hit: ResolvedHit,
  sold: PriceResult,
): PriceResult {
  return {
    suggested: sold.suggested,
    range: sold.range,
    confidence: Math.max(sold.confidence, hit.cleanHit ? 0.9 : 0.8),
    sources: [...hit.sources, ...sold.sources],
    tier: "isbn-lookup",
    ...(sold.compAgreement != null ? { compAgreement: sold.compAgreement } : {}),
    ...(sold.evidenceWindowDays != null
      ? { evidenceWindowDays: sold.evidenceWindowDays }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export interface IsbnPricingProviderOptions {
  /** Injected JSON fetcher; defaults to the platform `fetch`. */
  fetchJson?: FetchJson;
  /**
   * Optional sold-comp lookup (#2). When provided and it returns real sold comps,
   * the book is priced from those (earning the top `isbn` tier); otherwise the
   * provider falls back to the catalog used-price estimate. Wired by
   * `createDefaultPricer`; omitted in unit tests for pure offline behavior.
   */
  soldLookup?: SoldLookup;
}

/**
 * Create the tier-1 ISBN `PricingProvider`. Inject `fetchJson` in tests to run
 * offline against canned payloads; production defaults to the real `fetch`.
 */
export function createIsbnPricingProvider(
  options: IsbnPricingProviderOptions = {},
): PricingProvider {
  const fetchJson = options.fetchJson ?? defaultFetchJson;
  const soldLookup = options.soldLookup;

  return {
    tier: "isbn-lookup",

    canHandle(signal: ItemSignal): boolean {
      return typeof signal.isbn === "string" && signal.isbn.trim().length > 0;
    },

    async price(signal: ItemSignal): Promise<PriceResult | null> {
      const isbn = signal.isbn?.trim();
      if (!isbn) return null; // Not our signal — decline, let the router fall through.

      // A thrown fetchJson (network/5xx) propagates as a hard error by design.
      const hit = await resolveHit(isbn, fetchJson);
      if (hit === null) return null; // Neither API matched → decline.

      // #2: with a structured identity in hand, prefer REAL sold comps over the
      // retail-derived heuristic. Only after the identity resolves (so we never
      // spend a sold-comp fetch on an unidentifiable ISBN) and only when the
      // lookup returns actual completed sales.
      if (soldLookup) {
        const sold = await soldLookup(signal);
        if (sold !== null && hasSoldComp(sold)) {
          return buildSoldGroundedResult(hit, sold);
        }
      }

      // No sold comps → the honest retail-derived estimate (may itself decline).
      return buildResult(hit, signal);
    },
  };
}
