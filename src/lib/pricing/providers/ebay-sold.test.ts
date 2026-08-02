import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EBAY_SOLD_HANDOFF_STORE_READ_ALLOWANCE_MS,
  EBAY_SOLD_MIN_COMPS,
  assertSafeEbayUrl,
  buildSoldSearchUrl,
  coreComps,
  createDefaultFetchPage,
  createEbaySoldPricingProvider as createRawEbaySoldPricingProvider,
  ebaySoldConfigured,
  filterRelevantComps,
  finalizeVerifiedSoldResult,
  isAllowedEbayHost,
  isPrivateOrInternalHost,
  parsePrice,
  parseSoldComps,
  parseSoldDate,
  synthesizeSoldResult,
  type EbaySoldComp,
  type EbaySoldPricingProviderOptions,
  type FetchPage,
} from "./ebay-sold";
import { createApifySoldPricingProvider } from "./apify-sold";
import { selectSoldCompEvidence } from "../sold-comp-matcher";
import {
  SOLD_HALFLIFE_DAYS_DEFAULT,
  SOLD_STALE_DAYS_DEFAULT,
} from "../freshness";
import {
  createInMemoryTtlCache,
  createUpstashTtlCache,
  type TtlCache,
} from "../comp-cache";
import type { LogFields } from "../../observability";
import { PriceRouter } from "../router";
import {
  priceResultSchema,
  type ItemSignal,
  type PriceResult,
  type PricingProvider,
} from "../types";
import { TIGHT_AGREEMENT_MIN } from "./web-search";

/**
 * Tier "ebay-sold" — the public eBay sold-listings scraper (issue #56). Every
 * test runs fully OFFLINE: the page fetch is an injected `FetchPage` fake that
 * serves a SAVED sold-results HTML fixture, matching the repo-wide DI pattern.
 *
 * Acceptance criteria covered:
 *  - implements `PricingProvider` → a schema-valid `{ suggested, range,
 *    confidence, sources[] }` tagged tier "ebay-sold";
 *  - parses the sold-results page with cheerio (skips the "Shop on eBay"
 *    placeholder and price-less cards);
 *  - SSRF hardening: only eBay hosts, https only, no userinfo, internal /
 *    private addresses blocked, constructed URLs validated;
 *  - a Playwright-style fallback `FetchPage` is tried when the primary is blocked;
 *  - declines gracefully (null → router falls through) when blocked or thin.
 */

const FIXTURE_HTML = readFileSync(
  fileURLToPath(new URL("./fixtures/ebay-sold.sample.html", import.meta.url)),
  "utf8",
);

/**
 * The MODERN `.su-card-container` / `li.s-card` SRP layout eBay also serves (the
 * #59 follow-up to #56's classic `.srp-results > li.s-item` fixture). Captured
 * live (premium proxy) on 2026-06-16: 12 used Sony WH-1000XM4 comps, 2 "Shop on
 * eBay" placeholders (no Sold caption), and 2 wrong-model noise cards.
 */
const MODERN_FIXTURE_HTML = readFileSync(
  fileURLToPath(new URL("./fixtures/ebay-sold.modern.sample.html", import.meta.url)),
  "utf8",
);

/** The five RELEVANT sold prices for the Sony WH-1000XM4 in the fixture. */
const FIXTURE_PRICES = [169.99, 175.0, 178.0, 185.5, 199.95];
const sortedFixturePrices = [...FIXTURE_PRICES].sort((a, b) => a - b);
const FIXTURE_MEDIAN = sortedFixturePrices[2]; // 178.00 (5 relevant comps → middle)
/**
 * Priced NOISE the fixture also contains: an aftermarket ear-pad accessory
 * ($21.50) and a wrong-model Bose listing ($150). The HTML parser is identity-
 * agnostic and returns these too; the relevance filter / provider must drop them.
 */
const NOISE_PRICES = [21.5, 150.0];
const sortedAllParsed = [...FIXTURE_PRICES, ...NOISE_PRICES].sort((a, b) => a - b);

const BRANDED_SIGNAL: ItemSignal = {
  brand: "Sony",
  model: "WH-1000XM4",
  category: "electronics",
  condition: "good",
  conditionKnown: true,
};

const sharedTestCacheByCache = new WeakMap<
  TtlCache<EbaySoldComp[]>,
  TtlCache<EbaySoldComp[]>
>();

function withSharedTestClaim(
  cache: TtlCache<EbaySoldComp[]>,
): TtlCache<EbaySoldComp[]> {
  if (cache.scope === "shared" && cache.claim && cache.getClaimOwner) return cache;
  const existing = sharedTestCacheByCache.get(cache);
  if (existing) return existing;
  let claimOwner: string | null = null;
  const shared: TtlCache<EbaySoldComp[]> = {
    scope: "shared",
    get: cache.get.bind(cache),
    set: cache.set.bind(cache),
    async claim(key, signal, ownerToken) {
      const claimed = cache.claim
        ? await cache.claim(key, signal, ownerToken)
        : true;
      if (claimed) claimOwner = ownerToken ?? "1";
      return claimed;
    },
    getClaimOwner:
      cache.getClaimOwner?.bind(cache) ?? (async () => claimOwner),
  };
  sharedTestCacheByCache.set(cache, shared);
  return shared;
}

/** Normal offline provider construction still exercises the required shared claim. */
function createEbaySoldPricingProvider(
  options: EbaySoldPricingProviderOptions = {},
): PricingProvider {
  const cache = options.cache ?? createInMemoryTtlCache<EbaySoldComp[]>(60_000);
  return createRawEbaySoldPricingProvider({
    ...options,
    cache: withSharedTestClaim(cache),
  });
}

/** A FetchPage fake that records the URLs it was asked to fetch. */
function fakeFetch(html: string): FetchPage & { urls: string[] } {
  const urls: string[] = [];
  const fn = (async (url: string) => {
    urls.push(url);
    return html;
  }) as FetchPage & { urls: string[] };
  fn.urls = urls;
  return fn;
}

/** A FetchPage fake that always fails — models a blocked / CAPTCHA'd request. */
function blockedFetch(): FetchPage & { urls: string[] } {
  const urls: string[] = [];
  const fn = (async (url: string): Promise<string> => {
    urls.push(url);
    throw new Error("eBay sold fetch failed: 429");
  }) as FetchPage & { urls: string[] };
  fn.urls = urls;
  return fn;
}

/**
 * Fake-timer budget the coordination-deadline cases advance through. The provider
 * derives its handoff deadline as `fetchTimeoutMs * maximumRequestCount +
 * EBAY_SOLD_HANDOFF_STORE_READ_ALLOWANCE_MS`, so the `2` here is the fetch
 * component of every case below: each passes `fetchTimeoutMs: 1` and allows the
 * one optional expansion, giving two requests. Advancing this far lands exactly
 * on the deadline. A case that wants a different `fetchTimeoutMs` needs its own
 * advance rather than this helper.
 */
const HANDOFF_SETTLEMENT_ADVANCE_MS =
  1 * 2 + EBAY_SOLD_HANDOFF_STORE_READ_ALLOWANCE_MS;

/**
 * Runs one deadline regression to settlement under fake timers and returns what
 * `price` resolved to. Owns the scaffolding every such case repeated verbatim —
 * the `settled` latch, the logical-budget advance, and the assertion that the
 * provider actually resolved inside that budget rather than hanging. Each case
 * keeps its own cache/fetch fakes and its own outcome assertions.
 *
 * Requires `vi.useFakeTimers()` to be active before the call.
 */
async function settleWithinHandoffBudget(
  options: EbaySoldPricingProviderOptions,
): Promise<PriceResult | null> {
  let settled = false;
  const result = createRawEbaySoldPricingProvider(options)
    .price(BRANDED_SIGNAL)
    .then((value) => {
      settled = true;
      return value;
    });

  await vi.advanceTimersByTimeAsync(HANDOFF_SETTLEMENT_ADVANCE_MS);

  expect(settled).toBe(true);
  return await result;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("SSRF hardening", () => {
  it("accepts only eBay hosts (exact ebay.com or a *.ebay.com subdomain)", () => {
    expect(isAllowedEbayHost("ebay.com")).toBe(true);
    expect(isAllowedEbayHost("www.ebay.com")).toBe(true);
    // Look-alikes and other domains are rejected.
    expect(isAllowedEbayHost("notebay.com")).toBe(false);
    expect(isAllowedEbayHost("ebay.com.evil.com")).toBe(false);
    expect(isAllowedEbayHost("evil.com")).toBe(false);
    // International eBay TLDs are out of scope (USD .com only in v1).
    expect(isAllowedEbayHost("www.ebay.de")).toBe(false);
  });

  it("flags internal / private / loopback / link-local hosts (and bare IP literals)", () => {
    for (const h of [
      "localhost",
      "intranet.local",
      "127.0.0.1",
      "10.0.0.5",
      "172.16.4.4",
      "192.168.1.1",
      "169.254.10.10",
      "0.0.0.0",
      "::1",
      "1.2.3.4", // a public IP literal is still rejected — eBay is reached by name
    ]) {
      expect(isPrivateOrInternalHost(h)).toBe(true);
    }
    expect(isPrivateOrInternalHost("www.ebay.com")).toBe(false);
  });

  it("assertSafeEbayUrl accepts a real eBay https URL and returns a URL", () => {
    const u = assertSafeEbayUrl("https://www.ebay.com/sch/i.html?_nkw=sony&LH_Sold=1");
    expect(u).toBeInstanceOf(URL);
    expect(u.hostname).toBe("www.ebay.com");
  });

  it("assertSafeEbayUrl rejects non-https, userinfo, non-eBay, and internal hosts", () => {
    expect(() => assertSafeEbayUrl("http://www.ebay.com/sch")).toThrow();
    expect(() => assertSafeEbayUrl("https://user:pass@www.ebay.com/sch")).toThrow();
    expect(() => assertSafeEbayUrl("https://evil.com/sch")).toThrow();
    expect(() => assertSafeEbayUrl("https://127.0.0.1/sch")).toThrow();
    expect(() => assertSafeEbayUrl("https://ebay.com.evil.com/sch")).toThrow();
    expect(() => assertSafeEbayUrl("not a url")).toThrow();
  });
});

describe("buildSoldSearchUrl", () => {
  it("targets the sold + completed results page with the identity as the query", () => {
    const url = buildSoldSearchUrl(BRANDED_SIGNAL);
    expect(url).not.toBeNull();
    const u = new URL(url!);
    expect(u.hostname).toBe("www.ebay.com");
    expect(u.pathname).toBe("/sch/i.html");
    // The two flags that make the page show SOLD/COMPLETED comps, not active asks.
    expect(u.searchParams.get("LH_Sold")).toBe("1");
    expect(u.searchParams.get("LH_Complete")).toBe("1");
    expect(u.searchParams.get("_nkw")).toBe("Sony WH-1000XM4");
  });

  it("folds a bounded specs hint into a brand+model query so sold comps cluster on the SAME configuration", () => {
    // Without this, a sharpened multi-config item (Codex P2) prices against EVERY
    // configuration: the sold tier runs above web search and a brand+model-only sold
    // query returns mixed configs. Mirror the web-search tier — cap at 3 specs (more
    // over-narrows eBay's keyword match) so a 4th spec is dropped, blanks/whitespace
    // ignored.
    const url = buildSoldSearchUrl({
      brand: "Dell",
      model: "XPS 15",
      specs: ["RTX 4070", " ", "32GB", "1TB SSD", "OLED"],
    });
    expect(new URL(url!).searchParams.get("_nkw")).toBe("Dell XPS 15 RTX 4070 32GB 1TB SSD");
  });

  it("does NOT append specs to a bare UPC/ISBN query (an exact code key, not a keyword search)", () => {
    // A UPC/ISBN is an exact identifier; gluing generic vision specs onto it ("0272…
    // wireless over-ear") is noise, not narrowing. Specs only narrow the brand+model form.
    expect(
      new URL(
        buildSoldSearchUrl({ upc: "027242920569", specs: ["wireless", "over-ear"] })!,
      ).searchParams.get("_nkw"),
    ).toBe("027242920569");
  });

  it("uses a UPC as the query when that is the only identity, and a resolved name otherwise", () => {
    expect(new URL(buildSoldSearchUrl({ upc: "027242920569" })!).searchParams.get("_nkw")).toBe(
      "027242920569",
    );
    expect(
      new URL(buildSoldSearchUrl({ brand: "Nike", resolvedName: "Nike Air Max 90 Men's Shoes" })!)
        .searchParams.get("_nkw"),
    ).toBe("Nike Air Max 90 Men's Shoes");
  });

  it("uses an ISBN as the query for a book the structured ISBN tier couldn't price", () => {
    // The ISBN tier runs first; when it declines (identified but no USD price),
    // the book reaches this tier and should still get an exact eBay sold lookup.
    expect(new URL(buildSoldSearchUrl({ isbn: "9780140328721" })!).searchParams.get("_nkw")).toBe(
      "9780140328721",
    );
  });

  it("declines (null) for an unidentifiable signal or a bare brand", () => {
    expect(buildSoldSearchUrl({})).toBeNull();
    // A bare brand ("Sony") is not a product — its sold search returns arbitrary
    // same-brand items, exactly the false-precision the branded-web tier avoids.
    expect(buildSoldSearchUrl({ brand: "Sony", category: "electronics" })).toBeNull();
    expect(buildSoldSearchUrl({ brand: "Sony", model: "  " })).toBeNull();
  });

  it("respects a configured base URL (host still SSRF-checked at fetch time)", () => {
    const url = buildSoldSearchUrl(BRANDED_SIGNAL, "https://ebay.com");
    expect(new URL(url!).hostname).toBe("ebay.com");
  });

  it("declines (null) — never throws — on a malformed base URL (round-4)", () => {
    // A bad EBAY_SOLD_BASE_URL (no scheme) must NOT throw out of `canHandle`/this
    // precheck and abort the whole pricing pipeline — it declines to web search.
    expect(buildSoldSearchUrl(BRANDED_SIGNAL, "www.ebay.com")).toBeNull();
    expect(buildSoldSearchUrl(BRANDED_SIGNAL, "")).toBeNull();
    // And the provider's `canHandle` stays total with a malformed base URL.
    const provider = createEbaySoldPricingProvider({ baseUrl: "not a url" });
    expect(() => provider.canHandle?.(BRANDED_SIGNAL)).not.toThrow();
    expect(provider.canHandle?.(BRANDED_SIGNAL)).toBe(false);
  });
});

describe("parsePrice", () => {
  it("parses a single plain or comma-grouped USD price", () => {
    expect(parsePrice("$178.00")).toBeCloseTo(178, 2);
    expect(parsePrice("$1,299.99")).toBeCloseTo(1299.99, 2);
    // "US $" is USD and stays accepted.
    expect(parsePrice("US $178.00")).toBeCloseTo(178, 2);
  });

  it("declines a variation RANGE instead of fabricating a midpoint (round-7)", () => {
    // "$120 to $150" is a multi-variation listing — different variants, not one
    // unit sold at $135; a fabricated midpoint would contaminate the median.
    expect(parsePrice("$120.00 to $150.00")).toBeNull();
  });

  it("rejects NON-USD amounts so a foreign price can't anchor a USD median (round-5/6)", () => {
    expect(parsePrice("C $99.00")).toBeNull(); // CAD
    expect(parsePrice("AU $150.00")).toBeNull(); // AUD
    expect(parsePrice("£99.00")).toBeNull(); // GBP symbol
    expect(parsePrice("€99,00")).toBeNull(); // EUR symbol
    expect(parsePrice("EUR 99.00")).toBeNull(); // EUR code
    // The nightmare case: a foreign price with an approx USD must NOT be averaged.
    expect(parsePrice("C $99.00 (approx US $73.00)")).toBeNull();
    // Generic detection (round-6): currencies OUTSIDE any finite list still reject.
    expect(parsePrice("ILS 500.00")).toBeNull();
    expect(parsePrice("RUB 500.00")).toBeNull();
    expect(parsePrice("THB 500.00")).toBeNull();
    expect(parsePrice("₪500.00")).toBeNull(); // shekel symbol
    expect(parsePrice("₺500.00")).toBeNull(); // lira symbol
    // A bare number with no currency marker is not assumed to be USD.
    expect(parsePrice("500.00")).toBeNull();
  });

  it("returns null for empty / non-numeric text", () => {
    expect(parsePrice("")).toBeNull();
    expect(parsePrice(undefined)).toBeNull();
    expect(parsePrice("Free")).toBeNull();
  });
});

describe("parseSoldComps (saved fixture)", () => {
  const comps = parseSoldComps(FIXTURE_HTML);

  it("extracts every PRICED card (identity-agnostic), skipping the placeholder and price-less cards", () => {
    // The parser does NOT judge relevance — it returns all priced cards (the 5
    // real comps PLUS the priced accessory and the wrong-model Bose). Relevance
    // is a separate, testable stage.
    expect(comps).toHaveLength(sortedAllParsed.length);
    expect(comps.map((c) => c.price).sort((a, b) => a - b)).toEqual(sortedAllParsed);
    // The "Shop on eBay" placeholder and the price-less "ear pads ONLY" card never become comps.
    expect(comps.some((c) => /shop on ebay/i.test(c.title ?? ""))).toBe(false);
    expect(comps.some((c) => /ONLY \(no headphones\)/.test(c.title ?? ""))).toBe(false);
  });

  it("excludes active + sponsored cards that reuse li.s-item (round-5)", () => {
    // An ACTIVE listing inside .srp-results ($250, no Sold caption) and a
    // SPONSORED card OUTSIDE .srp-results ($999, even WITH a Sold caption) must
    // both be excluded — an asking price must never be counted as a sold comp.
    expect(comps.some((c) => c.price === 250)).toBe(false);
    expect(comps.some((c) => c.price === 999)).toBe(false);
    expect(comps.some((c) => /sponsored|buy it now/i.test(c.title ?? ""))).toBe(false);
  });

  it("cites a real eBay item URL and a cleaned title for every comp", () => {
    for (const c of comps) {
      expect(c.url.startsWith("https://www.ebay.com/itm/")).toBe(true);
      expect(c.title).toBeTruthy();
      // The "New Listing" badge text is stripped from the title.
      expect(c.title!.startsWith("New Listing")).toBe(false);
    }
  });

  it("extracts card condition metadata from the subtitle/SECONDARY_INFO (round-6)", () => {
    const html = `<ul class="srp-results">
      <li class="s-item">
        <a class="s-item__link" href="https://www.ebay.com/itm/1"><div class="s-item__title">Sony WH-1000XM4 Headphones</div></a>
        <span class="s-item__price">$300.00</span>
        <div class="s-item__caption"><span>Sold May 1, 2026</span></div>
        <div class="s-item__subtitle"><span class="SECONDARY_INFO">Brand New</span></div>
      </li>
    </ul>`;
    const parsed = parseSoldComps(html);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].condition).toBe("Brand New");
  });

  it("skips Best-Offer-accepted cards (their shown price may be the list price) (round-7)", () => {
    const html = `<ul class="srp-results">
      <li class="s-item">
        <a class="s-item__link" href="https://www.ebay.com/itm/1"><div class="s-item__title">Sony WH-1000XM4 Headphones</div></a>
        <span class="s-item__price">$300.00</span>
        <div class="s-item__caption"><span>Sold May 1, 2026</span></div>
        <div class="s-item__detail">Best offer accepted</div>
      </li>
      <li class="s-item">
        <a class="s-item__link" href="https://www.ebay.com/itm/2"><div class="s-item__title">Sony WH-1000XM4 Headphones</div></a>
        <span class="s-item__price">$180.00</span>
        <div class="s-item__caption"><span>Sold May 2, 2026</span></div>
      </li>
    </ul>`;
    const parsed = parseSoldComps(html);
    expect(parsed.map((c) => c.price)).toEqual([180]);
  });
});

describe("parseSoldComps (modern li.s-card layout — #59 follow-up)", () => {
  // eBay also serves a MODERN `.su-card-container` / `li.s-card` SRP layout,
  // distinct from the classic `.srp-results > li.s-item`. The SAME parser must
  // read both, or a premium-proxy fetch that succeeds still yields zero comps and
  // the sold tier silently declines to web search (the real-world #59 symptom).
  const comps = parseSoldComps(MODERN_FIXTURE_HTML);

  it("parses sold comps from the modern card markup", () => {
    // 12 used WH-1000XM4 comps + 2 wrong-model noise cards; the 2 "Shop on eBay"
    // placeholders (no Sold caption) are skipped.
    expect(comps.length).toBeGreaterThanOrEqual(12);
    expect(comps.some((c) => /shop on ebay/i.test(c.title ?? ""))).toBe(false);
    for (const c of comps) {
      expect(c.url.startsWith("https://www.ebay.com/itm/")).toBe(true);
      expect(c.price).toBeGreaterThan(0);
      expect(c.title).toBeTruthy();
    }
  });

  it("cleans the modern title (strips 'Opens in a new window' suffix + 'New Listing' badge)", () => {
    expect(comps.some((c) => /opens in a new window/i.test(c.title ?? ""))).toBe(false);
    expect(comps.some((c) => /^New Listing/i.test(c.title ?? ""))).toBe(false);
    // A specific known comp from the captured page (sanity that real data parses).
    expect(
      comps.some((c) => c.price === 175 && /sony wh-1000xm4/i.test(c.title ?? "")),
    ).toBe(true);
  });

  it("reads condition metadata and the Sold date from the modern card", () => {
    expect(comps.some((c) => c.condition === "Pre-Owned")).toBe(true);
    // "Sold Jun 16, 2026" → a parsed epoch-ms timestamp on at least one comp.
    expect(comps.some((c) => typeof c.soldAt === "number")).toBe(true);
  });

  it("relevance filter drops the wrong-model noise (WF-1000XM5 / WF-1000XM6)", () => {
    const relevant = filterRelevantComps(comps, BRANDED_SIGNAL);
    expect(relevant.length).toBeGreaterThanOrEqual(12);
    expect(relevant.some((c) => /WF-1000XM[56]/i.test(c.title ?? ""))).toBe(false);
    expect(relevant.some((c) => c.price === 37.61 || c.price === 268.99)).toBe(false);
  });

  it("prices a used item from the modern sold page end-to-end through the provider", async () => {
    const provider = createEbaySoldPricingProvider({
      fetchPage: fakeFetch(MODERN_FIXTURE_HTML),
    });
    const result = await provider.price(BRANDED_SIGNAL);
    expect(result).not.toBeNull();
    expect(() => priceResultSchema.parse(result)).not.toThrow();
    expect(result!.tier).toBe("ebay-sold");
    // Median of the ~12 used comps lands in a sane used band; the $37.61 accessory
    // and $268.99 new earbuds were filtered out, so they don't drag the suggestion.
    expect(result!.suggested).toBeGreaterThan(120);
    expect(result!.suggested).toBeLessThan(200);
    expect(result!.sources.every((s) => !/WF-1000XM/i.test(s.title ?? ""))).toBe(true);
  });
});

describe("filterRelevantComps (#56 review: accessories/parts/wrong-model)", () => {
  it("keeps the real item comps and drops the priced accessory + wrong-model listings", () => {
    const relevant = filterRelevantComps(parseSoldComps(FIXTURE_HTML), BRANDED_SIGNAL);
    expect(relevant.map((c) => c.price).sort((a, b) => a - b)).toEqual(sortedFixturePrices);
    // The $21.50 ear-pad accessory and the $150 Bose never survive.
    expect(relevant.some((c) => /ear ?pad|replacement/i.test(c.title ?? ""))).toBe(false);
    expect(relevant.some((c) => /bose/i.test(c.title ?? ""))).toBe(false);
  });

  it("requires the model token in the title when a model is known", () => {
    const comps: EbaySoldComp[] = [
      { url: "https://www.ebay.com/itm/1", title: "Sony WH-1000XM4 Headphones", price: 180 },
      { url: "https://www.ebay.com/itm/2", title: "Sony WH-1000XM3 Headphones", price: 120 }, // wrong model
    ];
    const r = filterRelevantComps(comps, BRANDED_SIGNAL);
    expect(r).toHaveLength(1);
    expect(r[0].price).toBe(180);
  });

  it("without a catalog identity, only anchors a barcode-exposing row and still drops noise", () => {
    const upcSignal = { upc: "027242920569", condition: "good" } as ItemSignal;
    const comps: EbaySoldComp[] = [
      { url: "https://www.ebay.com/itm/1", title: "Sony WH-1000XM4 Headphones", price: 180 },
      { url: "https://www.ebay.com/itm/4", title: "Sony WH-1000XM4 UPC 027242920569", price: 190 },
      { url: "https://www.ebay.com/itm/2", title: "WH-1000XM4 replacement ear pads", price: 20 },
      { url: "https://www.ebay.com/itm/3", title: "Headphones for parts not working", price: 30 },
    ];
    const r = filterRelevantComps(comps, upcSignal);
    expect(r.map((c) => c.price)).toEqual([190]);
  });

  it("drops new/sealed comps for a USED item, keeps them when the seller's item is new", () => {
    const comps: EbaySoldComp[] = [
      { url: "https://www.ebay.com/itm/1", title: "Sony WH-1000XM4 Headphones", price: 180 },
      { url: "https://www.ebay.com/itm/2", title: "Sony WH-1000XM4 Brand New Sealed", price: 280 },
    ];
    // BRANDED_SIGNAL is condition "good" → the $280 new/sealed comp would inflate
    // the median, so it is dropped.
    expect(filterRelevantComps(comps, BRANDED_SIGNAL).map((c) => c.price)).toEqual([180]);
    // If the seller's OWN item is new, new comps are valid and kept.
    const newSignal: ItemSignal = { ...BRANDED_SIGNAL, condition: "new" };
    expect(filterRelevantComps(comps, newSignal).map((c) => c.price).sort((a, b) => a - b)).toEqual([
      180, 280,
    ]);
  });

  it("treats an accessory term as noise UNLESS it is part of the item's own identity", () => {
    // Selling a PS5 console: a DualSense Controller sale is an accessory → dropped.
    const consoleSignal: ItemSignal = { brand: "Sony", model: "PS5", condition: "good" };
    const consoleComps: EbaySoldComp[] = [
      { url: "https://www.ebay.com/itm/a", title: "Sony PS5 Console Disc Edition", price: 400 },
      { url: "https://www.ebay.com/itm/b", title: "Sony PS5 DualSense Controller", price: 55 },
    ];
    expect(filterRelevantComps(consoleComps, consoleSignal).map((c) => c.price)).toEqual([400]);
    // Selling the controller ITSELF: "controller" is identity, so those comps stay.
    // NOTE: `resolvedName` here models a CATALOG-RESOLVED identity (e.g. a future UPC
    // lookup). The current vision pipeline's `attributesToSignal` does NOT set it —
    // see the "declines ... as PRODUCTION sees it" test below for that reality (#61).
    const controllerSignal: ItemSignal = {
      brand: "Sony",
      model: "DualSense",
      resolvedName: "Sony DualSense Wireless Controller",
      condition: "good",
    };
    const controllerComps: EbaySoldComp[] = [
      { url: "https://www.ebay.com/itm/c", title: "Sony DualSense Wireless Controller", price: 55 },
      { url: "https://www.ebay.com/itm/d", title: "Sony DualSense Controller White", price: 50 },
    ];
    expect(
      filterRelevantComps(controllerComps, controllerSignal).map((c) => c.price).sort((a, b) => a - b),
    ).toEqual([50, 55]);
  });

  it("treats LIKE-NEW as a used grade — new/sealed comps are still dropped (round-3)", () => {
    const comps: EbaySoldComp[] = [
      { url: "https://www.ebay.com/itm/1", title: "Sony WH-1000XM4 Headphones", price: 180 },
      { url: "https://www.ebay.com/itm/2", title: "Sony WH-1000XM4 Brand New Sealed", price: 280 },
    ];
    const likeNew: ItemSignal = { ...BRANDED_SIGNAL, condition: "like-new" };
    // "like-new".includes("new") used to wrongly keep the $280 new comp.
    expect(filterRelevantComps(comps, likeNew).map((c) => c.price)).toEqual([180]);
  });

  it("rejects a comp with a SECOND accessory term even if the first is in identity (round-3)", () => {
    // Selling a DualSense controller: "DualSense Controller Case" matches
    // "Controller" (identity) first, but "Case" must still reject it.
    const controllerSignal: ItemSignal = {
      brand: "Sony",
      model: "DualSense",
      resolvedName: "Sony DualSense Wireless Controller",
      condition: "good",
    };
    const comps: EbaySoldComp[] = [
      { url: "https://www.ebay.com/itm/1", title: "Sony DualSense Wireless Controller", price: 55 },
      { url: "https://www.ebay.com/itm/2", title: "Sony DualSense Controller Case", price: 12 },
    ];
    expect(filterRelevantComps(comps, controllerSignal).map((c) => c.price)).toEqual([55]);
  });

  it("catches a standalone NEW marker but keeps identity uses like 'New Balance' (round-3)", () => {
    // Used headphones: a standalone "NEW" comp is dropped.
    const xm4 = [
      { url: "https://www.ebay.com/itm/1", title: "Sony WH-1000XM4 Headphones", price: 180 },
      { url: "https://www.ebay.com/itm/2", title: "NEW Sony WH-1000XM4 Headphones", price: 300 },
    ];
    expect(filterRelevantComps(xm4, BRANDED_SIGNAL).map((c) => c.price)).toEqual([180]);
    // A "New Balance" product name is NOT a new-condition marker.
    const nbSignal: ItemSignal = { brand: "New Balance", model: "574", condition: "good" };
    const nb = [
      { url: "https://www.ebay.com/itm/3", title: "New Balance 574 Sneakers Used", price: 45 },
      { url: "https://www.ebay.com/itm/4", title: "New Balance 574 Grey", price: 50 },
    ];
    expect(filterRelevantComps(nb, nbSignal).map((c) => c.price).sort((a, b) => a - b)).toEqual([
      45, 50,
    ]);
  });

  it("requires a model match at TOKEN BOUNDARIES, not as a prefix (round-4)", () => {
    // signal model "574" must NOT accept "New Balance 5740" (a different shoe) —
    // the old whole-title `.includes()` did, letting wrong-model comps price the item.
    const nbSignal: ItemSignal = { brand: "New Balance", model: "574", condition: "good" };
    const comps: EbaySoldComp[] = [
      { url: "https://www.ebay.com/itm/1", title: "New Balance 574 Grey", price: 50 },
      { url: "https://www.ebay.com/itm/2", title: "New Balance 5740 Black", price: 95 },
    ];
    expect(filterRelevantComps(comps, nbSignal).map((c) => c.price)).toEqual([50]);
    // Separator-insensitivity is preserved: "WH 1000XM4" still matches "WH-1000XM4".
    const spaced: EbaySoldComp[] = [
      { url: "https://www.ebay.com/itm/3", title: "Sony WH 1000XM4 Headphones", price: 180 },
    ];
    expect(filterRelevantComps(spaced, BRANDED_SIGNAL).map((c) => c.price)).toEqual([180]);
  });

  it("drops multi-unit lots (2-pack / set of N / N pcs) for a single item (round-4)", () => {
    const comps: EbaySoldComp[] = [
      { url: "https://www.ebay.com/itm/1", title: "Sony WH-1000XM4 Headphones", price: 180 },
      { url: "https://www.ebay.com/itm/2", title: "Sony WH-1000XM4 Headphones 2-Pack", price: 360 },
      { url: "https://www.ebay.com/itm/3", title: "Sony WH-1000XM4 Set of 2", price: 350 },
      { url: "https://www.ebay.com/itm/4", title: "Sony WH-1000XM4 Lot 4 pcs", price: 700 },
    ];
    // Each multi-unit lot clears identity + price agreement and would inflate the
    // median past the autopilot gate; only the genuine single unit survives.
    expect(filterRelevantComps(comps, BRANDED_SIGNAL).map((c) => c.price)).toEqual([180]);
  });

  it("flags a standalone NEW even when the brand itself contains 'new' (round-4)", () => {
    // "New Balance" used-shoe seller: a genuine new-inventory comp must be dropped,
    // not masked by the brand's own "New" (#56 review: idText.includes('new') was).
    const nbSignal: ItemSignal = { brand: "New Balance", model: "574", condition: "good" };
    const comps: EbaySoldComp[] = [
      { url: "https://www.ebay.com/itm/1", title: "New Balance 574 Grey Used", price: 50 },
      { url: "https://www.ebay.com/itm/2", title: "NEW New Balance 574 Black", price: 110 },
      { url: "https://www.ebay.com/itm/3", title: "New Balance 574 Brand New In Box", price: 120 },
    ];
    expect(filterRelevantComps(comps, nbSignal).map((c) => c.price)).toEqual([50]);
  });

  it("declines a generic-category item whose own type is an accessory noun, as PRODUCTION sees it (round-4)", () => {
    // attributesToSignal (the real pipeline) sets NO resolvedName, so a DualSense
    // controller arrives as { brand, model, category } with "controller" NOT in its
    // identity. The accessory filter drops "...Controller" comps and the sold tier
    // declines (→ web-search tier). This is the documented precision-over-recall
    // behavior; a category-aware carve-out so genuine accessory-CATEGORY items keep
    // their own comps is gold-set work (#61). Pinning the real behavior here so the
    // resolvedName-based tests above can't give false confidence (#56 review).
    const productionSignal: ItemSignal = {
      brand: "Sony",
      model: "DualSense",
      category: "electronics",
    };
    const comps: EbaySoldComp[] = [
      { url: "https://www.ebay.com/itm/1", title: "Sony DualSense Wireless Controller", price: 55 },
      { url: "https://www.ebay.com/itm/2", title: "Sony DualSense Controller White", price: 50 },
    ];
    expect(filterRelevantComps(comps, productionSignal)).toEqual([]);
  });

  it("rejects a longer product VARIANT a token-prefix would otherwise match (round-6)", () => {
    // "iPhone 14 Pro" must not be priced off "iPhone 14 Pro Max" comps, nor
    // "PlayStation 5" off "PlayStation 5 Slim" — materially different resale values.
    const iphone: ItemSignal = { brand: "Apple", model: "iPhone 14 Pro", condition: "good" };
    const iphoneComps: EbaySoldComp[] = [
      { url: "https://www.ebay.com/itm/1", title: "Apple iPhone 14 Pro 256GB Space Black", price: 720 },
      { url: "https://www.ebay.com/itm/2", title: "Apple iPhone 14 Pro Max 256GB", price: 950 },
    ];
    expect(filterRelevantComps(iphoneComps, iphone).map((c) => c.price)).toEqual([720]);
    const ps5: ItemSignal = { brand: "Sony", model: "PlayStation 5", condition: "good" };
    const ps5Comps: EbaySoldComp[] = [
      { url: "https://www.ebay.com/itm/3", title: "Sony PlayStation 5 Disc Console", price: 400 },
      { url: "https://www.ebay.com/itm/4", title: "Sony PlayStation 5 Slim Disc", price: 450 },
    ];
    expect(filterRelevantComps(ps5Comps, ps5).map((c) => c.price)).toEqual([400]);
  });

  it("uses card CONDITION metadata to drop a new comp whose title omits 'new' (round-6)", () => {
    // The seller-written title says nothing about condition; the card metadata
    // does. A USED-item seller must not be priced off a brand-new sale (#56 review).
    const comps: EbaySoldComp[] = [
      { url: "https://www.ebay.com/itm/1", title: "Sony WH-1000XM4 Headphones", price: 180, condition: "Pre-Owned" },
      { url: "https://www.ebay.com/itm/2", title: "Sony WH-1000XM4 Headphones", price: 300, condition: "Brand New" },
      { url: "https://www.ebay.com/itm/3", title: "Sony WH-1000XM4 Headphones", price: 260, condition: "Open Box" },
    ];
    expect(filterRelevantComps(comps, BRANDED_SIGNAL).map((c) => c.price)).toEqual([180]);
    // "Like New" in metadata is a USED grade — kept.
    const likeNew: EbaySoldComp[] = [
      { url: "https://www.ebay.com/itm/4", title: "Sony WH-1000XM4 Headphones", price: 175, condition: "Like New" },
    ];
    expect(filterRelevantComps(likeNew, BRANDED_SIGNAL).map((c) => c.price)).toEqual([175]);
  });
});

describe("createDefaultFetchPage (#56 review: SSRF + timeout)", () => {
  it("enforces the SSRF guard BEFORE issuing any request", async () => {
    let called = false;
    const spyFetch = (async () => {
      called = true;
      return new Response("<html></html>");
    }) as unknown as typeof fetch;
    const fetchPage = createDefaultFetchPage({ fetchImpl: spyFetch });
    await expect(fetchPage("https://evil.com/sch")).rejects.toThrow();
    expect(called).toBe(false); // rejected by the guard, never reached the network
  });

  it("aborts a stalled request after the timeout so the provider can decline (not hang)", async () => {
    // A fetch that accepts the connection but never sends a body — it only
    // settles when its AbortSignal fires.
    const hangingFetch = ((_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as unknown as typeof fetch;
    const fetchPage = createDefaultFetchPage({ timeoutMs: 10, fetchImpl: hangingFetch });
    await expect(
      fetchPage("https://www.ebay.com/sch/i.html?_nkw=x&LH_Sold=1"),
    ).rejects.toThrow();
  });

  it.each([
    ["direct", ""],
    ["proxy", "https://proxy.example/get?url={url}"],
  ])(
    "combines the caller abort signal with the internal timeout for %s requests",
    async (_mode, proxyTemplate) => {
      vi.useFakeTimers();
      let requestSignal: AbortSignal | undefined;
      const hangingFetch = ((
        _input: unknown,
        init?: { signal?: AbortSignal },
      ) => {
        requestSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }) as unknown as typeof fetch;
      const fetchPage = createDefaultFetchPage({
        timeoutMs: 10_000,
        fetchImpl: hangingFetch,
        proxyTemplate,
      });
      const caller = new AbortController();
      const result = fetchPage(
        "https://www.ebay.com/sch/i.html?_nkw=x&LH_Sold=1",
        caller.signal,
      );
      const rejection = expect(result).rejects.toThrow();

      caller.abort();
      await vi.advanceTimersByTimeAsync(0);

      expect(requestSignal?.aborted).toBe(true);
      await rejection;
    },
  );

  it("routes through a proxy template when configured (eBay 403s direct server fetches)", async () => {
    let requestedUrl = "";
    const spyFetch = (async (input: unknown) => {
      requestedUrl = String(input);
      return new Response("<html>sold page via proxy</html>");
    }) as unknown as typeof fetch;
    const fetchPage = createDefaultFetchPage({
      fetchImpl: spyFetch,
      proxyTemplate: "https://proxy.example/get?token=K&url={url}",
    });
    const ebayUrl = "https://www.ebay.com/sch/i.html?_nkw=sony&LH_Sold=1";
    const html = await fetchPage(ebayUrl);
    expect(html).toContain("via proxy");
    // The request went to the PROXY host, carrying the (SSRF-validated) eBay URL encoded.
    expect(requestedUrl.startsWith("https://proxy.example/get?token=K&url=")).toBe(true);
    expect(requestedUrl).toContain(encodeURIComponent(ebayUrl));
  });

  it("rejects a malformed configured proxy before issuing any request", () => {
    let called = false;
    const spyFetch = (async () => {
      called = true;
      return new Response("<html></html>");
    }) as unknown as typeof fetch;

    expect(() =>
      createDefaultFetchPage({
        fetchImpl: spyFetch,
        proxyTemplate: "https://proxy.example/fetch",
      }),
    ).toThrow(/EBAY_SOLD_PROXY_TEMPLATE/);
    expect(called).toBe(false);
  });

  it("still SSRF-validates the eBay target before routing through a proxy", async () => {
    let called = false;
    const spyFetch = (async () => {
      called = true;
      return new Response("<html></html>");
    }) as unknown as typeof fetch;
    const fetchPage = createDefaultFetchPage({
      fetchImpl: spyFetch,
      proxyTemplate: "https://proxy.example/get?url={url}",
    });
    await expect(fetchPage("https://evil.com/sch")).rejects.toThrow();
    expect(called).toBe(false); // guard rejects the non-eBay target before any egress
  });

  it("fetches eBay directly when no proxy template is configured", async () => {
    let requestedUrl = "";
    const spyFetch = (async (input: unknown) => {
      requestedUrl = String(input);
      return new Response("<html>direct</html>");
    }) as unknown as typeof fetch;
    const fetchPage = createDefaultFetchPage({ fetchImpl: spyFetch });
    const ebayUrl = "https://www.ebay.com/sch/i.html?_nkw=sony&LH_Sold=1";
    await fetchPage(ebayUrl);
    expect(requestedUrl).toBe(ebayUrl);
  });
});

describe("synthesizeSoldResult", () => {
  const comps: EbaySoldComp[] = FIXTURE_PRICES.map((price, i) => ({
    url: `https://www.ebay.com/itm/${i}`,
    title: `comp ${i}`,
    price,
  }));
  const result = synthesizeSoldResult(comps);

  it("produces a schema-valid, sold-grounded ebay-sold price recommendation", () => {
    expect(() => priceResultSchema.parse(result)).not.toThrow();
    expect(result.tier).toBe("ebay-sold");
    // Suggested = median of the sold prices; band = min..max.
    expect(result.suggested).toBeCloseTo(FIXTURE_MEDIAN, 2);
    expect(result.range.min).toBeCloseTo(sortedFixturePrices[0], 2);
    expect(result.range.max).toBeCloseTo(sortedFixturePrices.at(-1)!, 2);
    // Completed eBay sales are SOLD ground truth — every source is a sold-comp.
    expect(result.sources).toHaveLength(comps.length);
    expect(result.sources.every((s) => s.kind === "sold-comp")).toBe(true);
    // No LLM is involved, so no model provenance is claimed.
    expect(result.model).toBeUndefined();
  });

  it("reports comp agreement so the confidence composite sees tightness, not a constant", () => {
    expect(result.compAgreement).toBeGreaterThanOrEqual(TIGHT_AGREEMENT_MIN);
    const scattered = synthesizeSoldResult([
      { url: "https://www.ebay.com/itm/a", price: 60, title: "a" },
      { url: "https://www.ebay.com/itm/b", price: 185, title: "b" },
      { url: "https://www.ebay.com/itm/c", price: 420, title: "c" },
    ]);
    expect(scattered.compAgreement!).toBeLessThan(TIGHT_AGREEMENT_MIN);
    // A scattered sold set is honestly less confident than a tight one.
    expect(scattered.confidence).toBeLessThan(result.confidence);
  });
});

describe("synthesizeSoldResult — condition-aware evidence weight (#198)", () => {
  it("lets same-condition anchors outweigh adjacent-condition anchors", () => {
    const same: EbaySoldComp = {
      url: "https://www.ebay.com/itm/same",
      title: "Apple iPhone 14 Pro 256GB",
      price: 700,
      condition: "Like New",
    };
    const adjacent: EbaySoldComp = {
      url: "https://www.ebay.com/itm/adjacent",
      title: "Apple iPhone 14 Pro 256GB",
      price: 760,
      condition: "Open Box",
    };

    const result = synthesizeSoldResult([same, adjacent], {
      evidenceWeight: (comp) => (comp === same ? 0.98 : 0.85),
    });

    expect(result.suggested).toBe(700);
    expect(result.range).toEqual({ min: 700, max: 760 });
  });
});

describe("coreComps — robust outlier trimming (#1 confidence lever)", () => {
  const mk = (prices: number[]): EbaySoldComp[] =>
    prices.map((price, i) => ({ url: `https://www.ebay.com/itm/${i}`, price, title: `c${i}` }));
  const prices = (cs: EbaySoldComp[]) => cs.map((c) => c.price).sort((a, b) => a - b);

  it("drops a single extreme HIGH spike (sealed unit / bundle / wrong model that slipped the filter)", () => {
    // [120,125,130,135,140] is a tight used cluster; 400 is anomalous.
    expect(prices(coreComps(mk([120, 125, 130, 135, 140, 400])))).toEqual([120, 125, 130, 135, 140]);
  });

  it("drops a single extreme LOW spike (a 'for parts / not working' sale)", () => {
    expect(prices(coreComps(mk([20, 120, 125, 130, 135, 140])))).toEqual([120, 125, 130, 135, 140]);
  });

  it("catches a spike that masks itself under IQR fences (MAD's 50% breakpoint)", () => {
    // Under Tukey IQR the 400 inflates Q3 and hides inside the fence; MAD flags it.
    expect(prices(coreComps(mk([120, 125, 130, 135, 400])))).toEqual([120, 125, 130, 135]);
  });

  it("does NOT trim a genuinely scattered (uniform) set — no isolated outlier to remove", () => {
    expect(coreComps(mk([60, 120, 185, 300, 420]))).toHaveLength(5);
  });

  it("does NOT trim a bimodal set — both clusters are real, neither is noise", () => {
    expect(coreComps(mk([100, 105, 110, 500, 510, 520]))).toHaveLength(6);
  });

  it("leaves thin sets (<4 comps) untrimmed — MAD is unreliable on tiny n", () => {
    expect(coreComps(mk([120, 125, 400]))).toHaveLength(3);
  });

  it("keeps an all-identical set intact (MAD = 0 → never drops the minority)", () => {
    expect(coreComps(mk([130, 130, 130, 135]))).toHaveLength(4);
  });
});

describe("synthesizeSoldResult — robust core rescues a tight cluster from one spike (#1)", () => {
  const mk = (prices: number[]): EbaySoldComp[] =>
    prices.map((price, i) => ({ url: `https://www.ebay.com/itm/${i}`, price, title: `c${i}` }));

  it("trims a high spike so the tight core earns sold-tier agreement, range, and citations", () => {
    const withSpike = synthesizeSoldResult(mk([120, 125, 130, 135, 140, 400]));
    // Before the fix the 400 collapses agreement → web_wide; now the core is tight.
    expect(withSpike.compAgreement!).toBeGreaterThanOrEqual(TIGHT_AGREEMENT_MIN);
    // Suggested + band describe the DEFENSIBLE core, not the spike.
    expect(withSpike.suggested).toBeCloseTo(130, 2);
    expect(withSpike.range.max).toBeCloseTo(140, 2);
    // Only the core comps are cited as backing the price (the spike is not evidence).
    expect(withSpike.sources).toHaveLength(5);
    expect(withSpike.sources.every((s) => s.kind === "sold-comp")).toBe(true);
    expect(withSpike.evidence).toEqual(
      [120, 125, 130, 135, 140].map((price, index) => ({
        id: `https://www.ebay.com/itm/${index}`,
        sourceUrl: `https://www.ebay.com/itm/${index}`,
        title: `c${index}`,
        price,
        currency: "USD",
        kind: "sold-comparable",
        priceDisclosure: "displayed-sold-price",
      })),
    );
  });

  it("trims a low 'for parts' spike the same way", () => {
    const withLow = synthesizeSoldResult(mk([20, 120, 125, 130, 135, 140]));
    expect(withLow.compAgreement!).toBeGreaterThanOrEqual(TIGHT_AGREEMENT_MIN);
    expect(withLow.range.min).toBeCloseTo(120, 2);
  });

  it("still reports a scattered sold set as sub-tight (honesty preserved)", () => {
    const scattered = synthesizeSoldResult(mk([60, 120, 185, 300, 420]));
    expect(scattered.compAgreement!).toBeLessThan(TIGHT_AGREEMENT_MIN);
    expect(scattered.sources).toHaveLength(5);
  });
});

describe("createEbaySoldPricingProvider (offline via injected fetch)", () => {
  it("caps disjoint initial and expanded responses at twenty cached candidates", async () => {
    const initial = srp(
      Array.from({ length: 10 }, (_, index) => {
        const card = soldCard(
          `https://www.ebay.com/itm/initial-${index}`,
          150 + index,
          index + 1,
        );
        return index < 2
          ? card
          : card.replace(
              "Sony WH-1000XM4 Headphones",
              "Bose QuietComfort Headphones",
            );
      }),
    );
    const expanded = srp(
      Array.from({ length: 20 }, (_, index) =>
        soldCard(
          `https://www.ebay.com/itm/expanded-${index}`,
          170 + index,
          10 + index,
        ),
      ),
    );
    const urls: string[] = [];
    const fetchPage = vi.fn(async (url: string) => {
      urls.push(url);
      return new URL(url).searchParams.get("_ipg") === "10" ? initial : expanded;
    });
    let cachedCandidates: EbaySoldComp[] = [];
    const cache: TtlCache<EbaySoldComp[]> = {
      get: async () => (cachedCandidates.length > 0 ? cachedCandidates : null),
      set: async (_key, value) => {
        cachedCandidates = value;
      },
    };
    const provider = createEbaySoldPricingProvider({
      fetchPage,
      cache,
      now: () => NOW,
    });

    const first = await provider.price(BRANDED_SIGNAL);
    const retry = await provider.price(BRANDED_SIGNAL);

    expect(urls.map((url) => new URL(url).searchParams.get("_ipg"))).toEqual([
      "10",
      "20",
    ]);
    expect(cachedCandidates).toHaveLength(20);
    expect(cachedCandidates.map(({ url }) => url)).toEqual(
      Array.from(
        { length: 20 },
        (_, index) => `https://www.ebay.com/itm/expanded-${index}`,
      ),
    );
    expect(first?.evidence?.map(({ sourceUrl }) => sourceUrl)).toEqual([
      "https://www.ebay.com/itm/expanded-0",
      "https://www.ebay.com/itm/expanded-1",
      "https://www.ebay.com/itm/expanded-2",
      "https://www.ebay.com/itm/expanded-3",
      "https://www.ebay.com/itm/expanded-4",
    ]);
    expect(first?.sources.map(({ url }) => url)).toEqual(
      first?.evidence?.map(({ sourceUrl }) => sourceUrl),
    );
    expect(retry).toEqual(first);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("caches a terminal initial failure so retry cannot make another public request", async () => {
    const fetchPage = blockedFetch();
    const provider = createEbaySoldPricingProvider({
      fetchPage,
      cache: createInMemoryTtlCache<EbaySoldComp[]>(60_000),
    });

    await expect(provider.price(BRANDED_SIGNAL)).resolves.toBeNull();
    await expect(provider.price(BRANDED_SIGNAL)).resolves.toBeNull();

    expect(fetchPage.urls.map((url) => new URL(url).searchParams.get("_ipg"))).toEqual([
      "10",
    ]);
  });

  it("bounds an injected normal fetch and declines without starting expansion", async () => {
    vi.useFakeTimers();
    const fetchPage = vi.fn<FetchPage>(
      async () => new Promise<string>(() => undefined),
    );
    const provider = createEbaySoldPricingProvider({
      fetchPage,
      fetchTimeoutMs: 100,
      emitDiagnostic: () => undefined,
    });

    const result = provider.price(BRANDED_SIGNAL);
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toBeNull();
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent redelivery into one bounded public retrieval pass", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const urls: string[] = [];
    const fetchPage = vi.fn(async (url: string) => {
      urls.push(url);
      await gate;
      return new URL(url).searchParams.get("_ipg") === "10"
        ? srp([
            soldCard("https://www.ebay.com/itm/initial-a", 170, 8),
            soldCard("https://www.ebay.com/itm/initial-b", 180, 7),
          ])
        : FIXTURE_HTML;
    });
    const cache = createInMemoryTtlCache<EbaySoldComp[]>(60_000);
    const providerForRequest = () => createEbaySoldPricingProvider({ fetchPage, cache });

    const first = providerForRequest().price(BRANDED_SIGNAL);
    const redelivery = providerForRequest().price(BRANDED_SIGNAL);
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    const [firstResult, redeliveryResult] = await Promise.all([first, redelivery]);

    expect(redeliveryResult).toEqual(firstResult);
    expect(urls.map((url) => new URL(url).searchParams.get("_ipg"))).toEqual([
      "10",
      "20",
    ]);
  });

  it("hands off a near-deadline winner across immediate-miss Redis-like runtimes", async () => {
    vi.useFakeTimers();
    const values = new Map<string, EbaySoldComp[]>();
    let claimed = false;
    const claimResults: boolean[] = [];
    const cacheForRuntime = (): TtlCache<EbaySoldComp[]> => ({
      scope: "shared",
      async get(key) {
        return values.get(key) ?? null;
      },
      async set(key, value) {
        await new Promise<void>((resolve) => setTimeout(resolve, 400));
        values.set(key, value);
      },
      async claim() {
        const won = !claimed;
        claimed = true;
        claimResults.push(won);
        return won;
      },
    });
    const urls: string[] = [];
    const fetchPage = vi.fn(async (url: string) => {
      urls.push(url);
      await new Promise<void>((resolve) => setTimeout(resolve, 975));
      return new URL(url).searchParams.get("_ipg") === "10"
        ? srp([
            soldCard("https://www.ebay.com/itm/initial-a", 170, 8),
            soldCard("https://www.ebay.com/itm/initial-b", 180, 7),
          ])
        : FIXTURE_HTML;
    });
    const providerForRuntime = () =>
      createEbaySoldPricingProvider({
        fetchPage,
        fetchTimeoutMs: 1_000,
        cache: cacheForRuntime(),
      });

    const winner = providerForRuntime().price(BRANDED_SIGNAL);
    await vi.advanceTimersByTimeAsync(0);
    const loser = providerForRuntime().price(BRANDED_SIGNAL);
    await vi.advanceTimersByTimeAsync(2_500);
    const [winnerResult, loserResult] = await Promise.all([winner, loser]);

    expect(loserResult).toEqual(winnerResult);
    expect(claimResults).toEqual([true, false]);
    expect(urls.map((url) => new URL(url).searchParams.get("_ipg"))).toEqual([
      "10",
      "20",
    ]);
  });

  it("continues cross-runtime handoff after a transient loser read failure", async () => {
    vi.useFakeTimers();
    const values = new Map<string, EbaySoldComp[]>();
    let claimOwner: string | null = null;
    const claimResults: boolean[] = [];
    let runtimeCount = 0;
    let transientHandoffFailures = 0;
    const cacheForRuntime = (): TtlCache<EbaySoldComp[]> => {
      const runtime = runtimeCount;
      runtimeCount += 1;
      let reads = 0;
      return {
        scope: "shared",
        async get(key) {
          reads += 1;
          if (runtime === 1 && reads === 2) {
            transientHandoffFailures += 1;
            throw new Error("transient loser handoff read failure");
          }
          return values.get(key) ?? null;
        },
        async set(key, value) {
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          values.set(key, value);
        },
        async claim(_key, _signal, ownerToken) {
          const claimed = claimOwner === null;
          if (claimed) claimOwner = ownerToken ?? "owner";
          claimResults.push(claimed);
          return claimed;
        },
        async getClaimOwner() {
          return claimOwner;
        },
      };
    };
    const fetchPage = vi.fn<FetchPage>(async () => FIXTURE_HTML);
    const providerForRuntime = () =>
      createRawEbaySoldPricingProvider({
        fetchPage,
        fetchTimeoutMs: 1,
        cache: cacheForRuntime(),
        emitDiagnostic: () => undefined,
      });

    const winner = providerForRuntime().price(BRANDED_SIGNAL);
    await vi.advanceTimersByTimeAsync(0);
    const loser = providerForRuntime().price(BRANDED_SIGNAL);
    await vi.advanceTimersByTimeAsync(502);
    const [winnerResult, loserResult] = await Promise.all([winner, loser]);
    const retryResult = await providerForRuntime().price(BRANDED_SIGNAL);

    expect(claimResults).toEqual([true, false]);
    expect(transientHandoffFailures).toBe(1);
    expect(fetchPage).toHaveBeenCalledOnce();
    expect(values.size).toBe(1);
    expect(winnerResult).not.toBeNull();
    expect(winnerResult?.sources).toHaveLength(5);
    expect(retryResult).toEqual(winnerResult);
    expect({
      winner: winnerResult?.tier ?? null,
      loser: loserResult?.tier ?? null,
      retry: retryResult?.tier ?? null,
    }).toEqual({
      winner: "ebay-sold",
      loser: "ebay-sold",
      retry: "ebay-sold",
    });
    expect(loserResult).toEqual(winnerResult);
  });

  it("observes a winner stored during the loser final backoff interval", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const values = new Map<string, EbaySoldComp[]>();
    let claimed = false;
    let claimOwner: string | null = null;
    const cacheForRuntime = (): TtlCache<EbaySoldComp[]> => ({
      scope: "shared",
      async get(key, signal) {
        const readStartedAt = Date.now() - startedAt;
        if (readStartedAt >= 503) return null;
        return new Promise<EbaySoldComp[] | null>((resolve, reject) => {
          const timer = setTimeout(() => resolve(values.get(key) ?? null), 1);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        });
      },
      async set(key, value) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.max(0, startedAt + 500 - Date.now())),
        );
        values.set(key, value);
      },
      async claim(_key, _signal, ownerToken) {
        const won = !claimed;
        claimed = true;
        if (won) claimOwner = ownerToken ?? null;
        return won;
      },
      async getClaimOwner() {
        return claimOwner;
      },
    });
    const fetchPage = vi.fn<FetchPage>(async () => FIXTURE_HTML);
    const providerForRuntime = () =>
      createRawEbaySoldPricingProvider({
        fetchPage,
        fetchTimeoutMs: 1,
        cache: cacheForRuntime(),
        emitDiagnostic: () => undefined,
      });

    const winner = providerForRuntime().price(BRANDED_SIGNAL);
    await vi.advanceTimersByTimeAsync(1);
    const loser = providerForRuntime().price(BRANDED_SIGNAL);
    await vi.advanceTimersByTimeAsync(502);
    await vi.advanceTimersToNextTimerAsync();
    const [winnerResult, loserResult] = await Promise.all([winner, loser]);

    expect(winnerResult).not.toBeNull();
    expect(loserResult).toEqual(winnerResult);
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it("clamps configured timeouts and fails soft after the derived handoff budget", async () => {
    vi.useFakeTimers();
    const reads: number[] = [];
    const cache: TtlCache<EbaySoldComp[]> = {
      scope: "shared",
      async get() {
        reads.push(Date.now());
        return null;
      },
      async set() {
        throw new Error("loser must not store");
      },
      async claim() {
        return false;
      },
    };
    const fetchPage = vi.fn<FetchPage>(async () => FIXTURE_HTML);
    const provider = createEbaySoldPricingProvider({
      fetchPage,
      fetchTimeoutMs: 60_000,
      cache,
      emitDiagnostic: () => undefined,
    });

    const result = provider.price(BRANDED_SIGNAL);
    await vi.advanceTimersByTimeAsync(30_499);
    expect(fetchPage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBeNull();
    expect(fetchPage).not.toHaveBeenCalled();
    expect(reads.at(-1)! - reads[0]!).toBe(30_500);
  });

  it("fails soft by the derived handoff deadline when a loser cache read never settles", async () => {
    vi.useFakeTimers();
    let reads = 0;
    let loserReadAborted = false;
    const cache = createUpstashTtlCache<EbaySoldComp[]>("sold-test", 60_000, {
      async get(_key, signal) {
        reads += 1;
        if (reads === 1) return null;
        return new Promise<unknown>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              loserReadAborted = true;
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        });
      },
      async set(_key, _value, options) {
        if (options.nx) return null;
        throw new Error("loser must not store");
      },
    });
    const fetchPage = vi.fn<FetchPage>(async () => FIXTURE_HTML);

    const result = await settleWithinHandoffBudget({
      fetchPage,
      fetchTimeoutMs: 1,
      cache,
      emitDiagnostic: () => undefined,
    });

    expect(result).toBeNull();
    expect(reads).toBe(2);
    expect(loserReadAborted).toBe(true);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("fails soft by the derived handoff deadline when the initial cache read never settles", async () => {
    vi.useFakeTimers();
    const set = vi.fn(async () => "OK");
    let initialReadAborted = false;
    const cache = createUpstashTtlCache<EbaySoldComp[]>("sold-test", 60_000, {
      async get(_key, signal) {
        return new Promise<unknown>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              initialReadAborted = true;
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        });
      },
      set,
    });
    const fetchPage = vi.fn<FetchPage>(async () => FIXTURE_HTML);

    const result = await settleWithinHandoffBudget({
      fetchPage,
      fetchTimeoutMs: 1,
      cache,
      emitDiagnostic: () => undefined,
    });

    expect(result).toBeNull();
    expect(initialReadAborted).toBe(true);
    expect(set).not.toHaveBeenCalled();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("fails soft by the derived handoff deadline when the atomic claim never settles", async () => {
    vi.useFakeTimers();
    let claimAborted = false;
    const cache = createUpstashTtlCache<EbaySoldComp[]>("sold-test", 60_000, {
      async get() {
        return null;
      },
      async set(_key, _value, options, signal) {
        if (options.nx) {
          return new Promise<unknown>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                claimAborted = true;
                reject(new DOMException("aborted", "AbortError"));
              },
              { once: true },
            );
          });
        }
        throw new Error("unreached store");
      },
    });
    const fetchPage = vi.fn<FetchPage>(async () => FIXTURE_HTML);

    const result = await settleWithinHandoffBudget({
      fetchPage,
      fetchTimeoutMs: 1,
      cache,
      emitDiagnostic: () => undefined,
    });

    expect(result).toBeNull();
    expect(claimAborted).toBe(true);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("reconciles a claim that commits before its response stalls", async () => {
    vi.useFakeTimers();
    const values = new Map<string, EbaySoldComp[]>();
    let claimed = false;
    let claimOwner: string | null = null;
    const cacheForRuntime = (): TtlCache<EbaySoldComp[]> => ({
      scope: "shared",
      async get(key) {
        return values.get(key) ?? null;
      },
      async set(key, value) {
        values.set(key, value);
      },
      async claim(_key, signal, ownerToken) {
        if (claimed) return false;
        claimed = true;
        claimOwner = ownerToken ?? null;
        return new Promise<boolean>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
      async getClaimOwner() {
        return claimOwner;
      },
    });
    const fetchPage = vi.fn<FetchPage>(async () => FIXTURE_HTML);
    const providerForRuntime = () =>
      createRawEbaySoldPricingProvider({
        fetchPage,
        fetchTimeoutMs: 1,
        cache: cacheForRuntime(),
        emitDiagnostic: () => undefined,
      });

    const ambiguousOwner = providerForRuntime().price(BRANDED_SIGNAL);
    await vi.advanceTimersByTimeAsync(0);
    const waitingRetry = providerForRuntime().price(BRANDED_SIGNAL);
    await vi.advanceTimersByTimeAsync(502);
    const [ownerResult, retryResult] = await Promise.all([
      ambiguousOwner,
      waitingRetry,
    ]);

    expect(ownerResult?.tier).toBe("ebay-sold");
    expect(retryResult).toEqual(ownerResult);
    expect(fetchPage).toHaveBeenCalledOnce();
    expect(values).toHaveLength(1);
  });

  it("reconciles a claim that commits before its response rejects", async () => {
    vi.useFakeTimers();
    const values = new Map<string, EbaySoldComp[]>();
    let claimOwner: string | null = null;
    const getClaimOwner = vi.fn(async () => claimOwner);
    const cacheForRuntime = (): TtlCache<EbaySoldComp[]> => ({
      scope: "shared",
      async get(key) {
        return values.get(key) ?? null;
      },
      async set(key, value) {
        values.set(key, value);
      },
      async claim(_key, _signal, ownerToken) {
        if (claimOwner !== null) return false;
        claimOwner = ownerToken ?? null;
        throw new Error("claim response rejected after commit");
      },
      getClaimOwner,
    });
    const fetchPage = vi.fn<FetchPage>(async () => FIXTURE_HTML);
    const providerForRuntime = () =>
      createRawEbaySoldPricingProvider({
        fetchPage,
        fetchTimeoutMs: 1,
        cache: cacheForRuntime(),
        emitDiagnostic: () => undefined,
      });

    const ambiguousOwner = providerForRuntime().price(BRANDED_SIGNAL);
    await vi.advanceTimersByTimeAsync(502);
    const ownerResult = await ambiguousOwner;
    const waitingRetry = providerForRuntime().price(BRANDED_SIGNAL);
    await vi.advanceTimersByTimeAsync(502);
    const retryResult = await waitingRetry;

    expect({
      ownerTier: ownerResult?.tier ?? null,
      retryTier: retryResult?.tier ?? null,
      ownerCommitted: claimOwner !== null,
      ownerObservations: getClaimOwner.mock.calls.length,
      fetchCalls: fetchPage.mock.calls.length,
      cachedValues: values.size,
    }).toEqual({
      ownerTier: "ebay-sold",
      retryTier: "ebay-sold",
      ownerCommitted: true,
      ownerObservations: 1,
      fetchCalls: 1,
      cachedValues: 1,
    });
    expect(retryResult).toEqual(ownerResult);
  });

  it("fails soft by the handoff deadline when a claim rejects without committing", async () => {
    vi.useFakeTimers();
    const getClaimOwner = vi.fn(async () => null);
    const cache: TtlCache<EbaySoldComp[]> = {
      scope: "shared",
      async get() {
        return null;
      },
      async set() {
        throw new Error("unreached store");
      },
      async claim() {
        throw new Error("claim rejected without commit");
      },
      getClaimOwner,
    };
    const fetchPage = vi.fn<FetchPage>(async () => FIXTURE_HTML);

    const result = await settleWithinHandoffBudget({
      fetchPage,
      fetchTimeoutMs: 1,
      cache,
      emitDiagnostic: () => undefined,
    });

    expect(result).toBeNull();
    expect(getClaimOwner).toHaveBeenCalled();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("fails soft by the derived handoff deadline when the winner store never settles", async () => {
    vi.useFakeTimers();
    let stores = 0;
    let storeAborted = false;
    const cache = createUpstashTtlCache<EbaySoldComp[]>("sold-test", 60_000, {
      async get() {
        return null;
      },
      async set(_key, _value, options, signal) {
        if (options.nx) return "OK";
        stores += 1;
        return new Promise<unknown>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              storeAborted = true;
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        });
      },
    });
    const fetchPage = vi.fn<FetchPage>(async () => FIXTURE_HTML);

    const result = await settleWithinHandoffBudget({
      fetchPage,
      fetchTimeoutMs: 1,
      cache,
      emitDiagnostic: () => undefined,
    });

    expect(result).toBeNull();
    expect(stores).toBe(1);
    expect(storeAborted).toBe(true);
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it("reconciles a winner store that commits before its response stalls", async () => {
    vi.useFakeTimers();
    const values = new Map<string, string>();
    const cache = createUpstashTtlCache<EbaySoldComp[]>("sold-test", 60_000, {
      async get(key) {
        return values.get(key) ?? null;
      },
      async set(key, value, options, signal) {
        values.set(key, value);
        if (options.nx) return "OK";
        return new Promise<unknown>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });
    const fetchPage = vi.fn<FetchPage>(async () => FIXTURE_HTML);
    const providerForRuntime = () =>
      createRawEbaySoldPricingProvider({
        fetchPage,
        fetchTimeoutMs: 1,
        cache,
        emitDiagnostic: () => undefined,
      });

    const first = providerForRuntime().price(BRANDED_SIGNAL);
    await vi.advanceTimersByTimeAsync(502);
    const firstResult = await first;
    const secondResult = await providerForRuntime().price(BRANDED_SIGNAL);
    const cachedValues = [...values.keys()].filter(
      (key) => !key.endsWith(":paid-claim"),
    ).length;

    expect({
      firstTier: firstResult?.tier ?? null,
      secondTier: secondResult?.tier ?? null,
      cachedValues,
    }).toEqual({
      firstTier: "ebay-sold",
      secondTier: "ebay-sold",
      cachedValues: 1,
    });
    expect(secondResult).toEqual(firstResult);
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it("reconciles an exact winner store that commits before its response rejects", async () => {
    let claimed = false;
    let stored: EbaySoldComp[] | null = null;
    const cache: TtlCache<EbaySoldComp[]> = {
      scope: "shared",
      async get() {
        return stored;
      },
      async set(_key, value) {
        stored = value;
        throw new Error("winner store response rejected after commit");
      },
      async claim() {
        if (claimed) return false;
        claimed = true;
        return true;
      },
      async getClaimOwner() {
        return claimed ? "owner" : null;
      },
    };
    const fetchPage = vi.fn<FetchPage>(async () => FIXTURE_HTML);
    const providerForRuntime = () =>
      createRawEbaySoldPricingProvider({
        fetchPage,
        cache,
        emitDiagnostic: () => undefined,
      });

    const firstResult = await providerForRuntime().price(BRANDED_SIGNAL);
    const retryResult = await providerForRuntime().price(BRANDED_SIGNAL);

    expect(stored).toHaveLength(7);
    expect(firstResult?.sources).toHaveLength(5);
    expect(retryResult).toEqual(firstResult);
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it("reserves a final exact observation when the winner store commits near the deadline and rejects", async () => {
    vi.useFakeTimers();
    let claimed = false;
    let storeStarted = false;
    let stored: EbaySoldComp[] | null = null;
    const cache: TtlCache<EbaySoldComp[]> = {
      scope: "shared",
      async get() {
        if (!storeStarted) return stored;
        const observed = stored;
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        return observed;
      },
      async set(_key, value) {
        storeStarted = true;
        await new Promise<void>((_, reject) =>
          setTimeout(() => {
            stored = value;
            reject(new Error("winner store response rejected after commit"));
          }, 400),
        );
      },
      async claim() {
        if (claimed) return false;
        claimed = true;
        return true;
      },
      async getClaimOwner() {
        return claimed ? "owner" : null;
      },
    };
    const fetchPage = vi.fn<FetchPage>(async () => FIXTURE_HTML);
    const providerForRuntime = () =>
      createRawEbaySoldPricingProvider({
        fetchPage,
        fetchTimeoutMs: 1,
        cache,
        emitDiagnostic: () => undefined,
      });

    const first = providerForRuntime().price(BRANDED_SIGNAL);
    await vi.runAllTimersAsync();
    const firstResult = await first;
    storeStarted = false;
    const retryResult = await providerForRuntime().price(BRANDED_SIGNAL);

    expect(stored).toHaveLength(7);
    expect(firstResult?.sources).toHaveLength(5);
    expect(retryResult).toEqual(firstResult);
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it("continues exact winner observation after transient cache read failures", async () => {
    vi.useFakeTimers();
    let claimed = false;
    let storeStarted = false;
    let observationFailuresRemaining = 2;
    let stored: EbaySoldComp[] | null = null;
    const cache: TtlCache<EbaySoldComp[]> = {
      scope: "shared",
      async get() {
        if (storeStarted && observationFailuresRemaining > 0) {
          observationFailuresRemaining -= 1;
          throw new Error("transient observation read failure");
        }
        return stored;
      },
      async set(_key, value) {
        storeStarted = true;
        await new Promise<void>((_, reject) =>
          setTimeout(() => {
            stored = value;
            reject(new Error("winner store response rejected after commit"));
          }, 100),
        );
      },
      async claim() {
        if (claimed) return false;
        claimed = true;
        return true;
      },
      async getClaimOwner() {
        return claimed ? "owner" : null;
      },
    };
    const fetchPage = vi.fn<FetchPage>(async () => FIXTURE_HTML);
    const providerForRuntime = () =>
      createRawEbaySoldPricingProvider({
        fetchPage,
        fetchTimeoutMs: 1,
        cache,
        emitDiagnostic: () => undefined,
      });

    const first = providerForRuntime().price(BRANDED_SIGNAL);
    await vi.runAllTimersAsync();
    const firstResult = await first;
    const retryResult = await providerForRuntime().price(BRANDED_SIGNAL);

    expect(observationFailuresRemaining).toBe(0);
    expect(firstResult?.sources).toHaveLength(5);
    expect(retryResult).toEqual(firstResult);
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it("retries a transient reserved final observation before the caller deadline", async () => {
    vi.useFakeTimers();
    let claimed = false;
    let storeStarted = false;
    let stored: EbaySoldComp[] | null = null;
    let winnerObservationReads = 0;
    const cache: TtlCache<EbaySoldComp[]> = {
      scope: "shared",
      async get() {
        if (!storeStarted) return stored;

        winnerObservationReads += 1;
        if (winnerObservationReads < 5) {
          await new Promise<void>((resolve) => setTimeout(resolve, 6));
          return stored;
        }
        if (winnerObservationReads === 5) {
          await new Promise<void>((_, reject) =>
            setTimeout(
              () => reject(new Error("transient reserved observation failure")),
              76,
            ),
          );
        }
        return stored;
      },
      async set(_key, value) {
        storeStarted = true;
        await new Promise<void>((_, reject) =>
          setTimeout(() => {
            stored = value;
            reject(new Error("winner store response rejected after commit"));
          }, 471),
        );
      },
      async claim() {
        if (claimed) return false;
        claimed = true;
        return true;
      },
      async getClaimOwner() {
        return claimed ? "owner" : null;
      },
    };
    const fetchPage = vi.fn<FetchPage>(async () => FIXTURE_HTML);
    const providerForRuntime = () =>
      createRawEbaySoldPricingProvider({
        fetchPage,
        fetchTimeoutMs: 1,
        cache,
        emitDiagnostic: () => undefined,
      });

    const first = providerForRuntime().price(BRANDED_SIGNAL);
    await vi.advanceTimersByTimeAsync(502);
    const firstResult = await first;
    storeStarted = false;
    const retryResult = await providerForRuntime().price(BRANDED_SIGNAL);

    expect(stored).toHaveLength(7);
    expect(retryResult).toEqual(firstResult);
    expect(firstResult?.sources).toHaveLength(5);
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it.each([
    {
      observed: Array.from({ length: 5 }, (_, index) => ({
        url: `https://www.ebay.com/itm/different-${index}`,
        title: "Sony WH-1000XM4 Wireless Headphones",
        price: 900 + index,
      })),
    },
    {
      observed: { rows: "malformed" } as unknown as EbaySoldComp[],
    },
  ])(
    "does not authorize a rejected winner store from different or malformed cache data",
    async ({ observed }) => {
      vi.useFakeTimers();
      let storeAttempted = false;
      let claimOwner: string | null = null;
      const cache: TtlCache<EbaySoldComp[]> = {
        scope: "shared",
        async get() {
          return storeAttempted ? observed : null;
        },
        async set() {
          storeAttempted = true;
          throw new Error("winner store response rejected without the retrieved result");
        },
        async claim(_key, _signal, ownerToken) {
          claimOwner = ownerToken ?? "owner";
          return true;
        },
        async getClaimOwner() {
          return claimOwner;
        },
      };
      const fetchPage = vi.fn<FetchPage>(async () => FIXTURE_HTML);
      const result = createRawEbaySoldPricingProvider({
        fetchPage,
        fetchTimeoutMs: 1,
        cache,
        emitDiagnostic: () => undefined,
      }).price(BRANDED_SIGNAL);

      await vi.advanceTimersByTimeAsync(502);

      await expect(result).resolves.toBeNull();
      expect(fetchPage).toHaveBeenCalledOnce();
    },
  );

  it("does not authorize a rejected winner store from reordered cache data", async () => {
    vi.useFakeTimers();
    let observed: EbaySoldComp[] | null = null;
    let claimOwner: string | null = null;
    const cache: TtlCache<EbaySoldComp[]> = {
      scope: "shared",
      async get() {
        return observed;
      },
      async set(_key, value) {
        observed = [...value].reverse();
        throw new Error("winner store response rejected after a reordered commit");
      },
      async claim(_key, _signal, ownerToken) {
        claimOwner = ownerToken ?? "owner";
        return true;
      },
      async getClaimOwner() {
        return claimOwner;
      },
    };
    const fetchPage = vi.fn<FetchPage>(async () => FIXTURE_HTML);
    const result = createRawEbaySoldPricingProvider({
      fetchPage,
      fetchTimeoutMs: 1,
      cache,
      emitDiagnostic: () => undefined,
    }).price(BRANDED_SIGNAL);

    await vi.runAllTimersAsync();

    await expect(result).resolves.toBeNull();
    expect(observed).toHaveLength(7);
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it("fails soft without divergent evidence when the winner store rejects", async () => {
    vi.useFakeTimers();
    const cache = createUpstashTtlCache<EbaySoldComp[]>("sold-test", 60_000, {
      async get() {
        return null;
      },
      async set(_key, _value, options) {
        if (options.nx) return "OK";
        throw new Error("shared store unavailable");
      },
    });
    const fetchPage = vi.fn<FetchPage>(async () => FIXTURE_HTML);
    const provider = createRawEbaySoldPricingProvider({
      fetchPage,
      fetchTimeoutMs: 1,
      cache,
      emitDiagnostic: () => undefined,
    });

    const result = provider.price(BRANDED_SIGNAL);
    await vi.advanceTimersByTimeAsync(502);

    await expect(result).resolves.toBeNull();
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it("uses the remaining logical deadline after a slow initial cache read", async () => {
    vi.useFakeTimers();
    const cache = createUpstashTtlCache<EbaySoldComp[]>("sold-test", 60_000, {
      async get() {
        await new Promise<void>((resolve) => setTimeout(resolve, 501));
        return null;
      },
      async set() {
        return "OK";
      },
    });
    const fetchPage = vi.fn<FetchPage>(async (url) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      return new URL(url).searchParams.get("_ipg") === "10"
        ? "<html><body>No exact matches</body></html>"
        : FIXTURE_HTML;
    });

    const result = await settleWithinHandoffBudget({
      fetchPage,
      fetchTimeoutMs: 1,
      cache,
      emitDiagnostic: () => undefined,
    });

    expect(result).toBeNull();
    expect(
      fetchPage.mock.calls.map(([url]) => new URL(url).searchParams.get("_ipg")),
    ).toEqual(["10"]);
  });

  it("aborts the active fetch before settling at the remaining logical deadline", async () => {
    vi.useFakeTimers();
    const cache = createUpstashTtlCache<EbaySoldComp[]>("sold-test", 60_000, {
      async get() {
        await new Promise<void>((resolve) => setTimeout(resolve, 501));
        return null;
      },
      async set() {
        return "OK";
      },
    });
    let fetchCount = 0;
    let observedSignal: AbortSignal | undefined;
    let aborted = false;
    const fetchPage = ((
      _url: string,
      signal?: AbortSignal,
    ): Promise<string> => {
      fetchCount += 1;
      observedSignal = signal;
      return new Promise<string>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }) as FetchPage;

    const result = await settleWithinHandoffBudget({
      fetchPage,
      fetchTimeoutMs: 1,
      cache,
      emitDiagnostic: () => undefined,
    });

    expect(result).toBeNull();
    expect(fetchCount).toBe(1);
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(true);
    expect(aborted).toBe(true);
  });

  it("does not await a newer in-process retrieval past the caller deadline", async () => {
    vi.useFakeTimers();
    let reads = 0;
    let claimOwner: string | null = null;
    const cache: TtlCache<EbaySoldComp[]> = {
      scope: "shared",
      async get() {
        reads += 1;
        if (reads === 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 501));
        }
        return null;
      },
      async set(_key, _value, signal) {
        return new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
      async claim(_key, _signal, ownerToken) {
        claimOwner = ownerToken ?? null;
        return true;
      },
      async getClaimOwner() {
        return claimOwner;
      },
    };
    const fetchPage = vi.fn<FetchPage>(async () => FIXTURE_HTML);
    const providerForRequest = () =>
      createRawEbaySoldPricingProvider({
        fetchPage,
        fetchTimeoutMs: 1,
        cache,
        emitDiagnostic: () => undefined,
      });
    let firstSettled = false;
    const first = providerForRequest()
      .price(BRANDED_SIGNAL)
      .then((value) => {
        firstSettled = true;
        return value;
      });
    await vi.advanceTimersByTimeAsync(100);
    const second = providerForRequest().price(BRANDED_SIGNAL);
    await vi.advanceTimersByTimeAsync(402);
    const firstSettledByItsDeadline = firstSettled;

    await vi.advanceTimersByTimeAsync(100);
    await expect(Promise.all([first, second])).resolves.toEqual([null, null]);

    expect(firstSettledByItsDeadline).toBe(true);
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it("uses the free default direct fetch with process-local coordination", async () => {
    vi.stubEnv("EBAY_SOLD_PROXY_TEMPLATE", "");
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const html =
        new URL(String(input)).searchParams.get("_ipg") === "10"
          ? ""
          : FIXTURE_HTML;
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });
    vi.stubGlobal("fetch", fetchImpl);
    const provider = createRawEbaySoldPricingProvider({
      enabled: true,
      cache: createInMemoryTtlCache<EbaySoldComp[]>(60_000),
      emitDiagnostic: () => undefined,
    });

    const result = await provider.price(BRANDED_SIGNAL);
    const retry = await provider.price(BRANDED_SIGNAL);

    expect(result).not.toBeNull();
    expect(result?.evidence).toHaveLength(5);
    expect(result?.sources.map(({ url }) => url)).toEqual(
      result?.evidence?.map(({ sourceUrl }) => sourceUrl),
    );
    expect(retry).toEqual(result);
    expect(
      fetchImpl.mock.calls.map(([input]) =>
        new URL(String(input)).searchParams.get("_ipg"),
      ),
    ).toEqual(["10", "20"]);
  });

  it("coordinates separate default-direct runtimes through an available shared claim", async () => {
    vi.stubEnv("EBAY_SOLD_PROXY_TEMPLATE", "");
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let firstFetchStarted!: () => void;
    const firstFetch = new Promise<void>((resolve) => {
      firstFetchStarted = resolve;
    });
    let reportSecondPath!: (path: "claim" | "fetch") => void;
    const secondPath = new Promise<"claim" | "fetch">((resolve) => {
      reportSecondPath = resolve;
    });
    let fetchCount = 0;
    const fetchImpl = vi.fn(async () => {
      fetchCount += 1;
      if (fetchCount === 1) firstFetchStarted();
      if (fetchCount === 2) reportSecondPath("fetch");
      await fetchGate;
      return new Response(FIXTURE_HTML);
    });
    vi.stubGlobal("fetch", fetchImpl);
    const values = new Map<string, EbaySoldComp[]>();
    let claimOwner: string | null = null;
    const claimResults: boolean[] = [];
    const claim = vi.fn(
      async (key: string, signal?: AbortSignal, ownerToken?: string) => {
        void key;
        void signal;
        const claimed = claimOwner === null;
        if (claimed) claimOwner = ownerToken ?? "1";
        claimResults.push(claimed);
        if (claimResults.length === 2) reportSecondPath("claim");
        return claimed;
      },
    );
    const cacheForRuntime = (): TtlCache<EbaySoldComp[]> => ({
      scope: "shared",
      async get(key) {
        return values.get(key) ?? null;
      },
      async set(key, value) {
        values.set(key, value);
      },
      claim,
      async getClaimOwner(key, signal) {
        void key;
        void signal;
        return claimOwner;
      },
    });
    const providerForRuntime = () =>
      createRawEbaySoldPricingProvider({
        enabled: true,
        cache: cacheForRuntime(),
        emitDiagnostic: () => undefined,
      });

    const first = providerForRuntime().price(BRANDED_SIGNAL);
    await firstFetch;
    const second = providerForRuntime().price(BRANDED_SIGNAL);
    const observedSecondPath = await secondPath;
    releaseFetch();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(observedSecondPath).toBe("claim");
    expect(claimResults).toEqual([true, false]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(firstResult).not.toBeNull();
    expect(secondResult).toEqual(firstResult);
  });

  it("keeps a configured proxy behind the shared cost fence", async () => {
    vi.stubEnv(
      "EBAY_SOLD_PROXY_TEMPLATE",
      "https://proxy.example/fetch?key=secret&url={url}",
    );
    const fetchImpl = vi.fn(async () => new Response(FIXTURE_HTML));
    vi.stubGlobal("fetch", fetchImpl);
    const provider = createRawEbaySoldPricingProvider({
      enabled: true,
      cache: createInMemoryTtlCache<EbaySoldComp[]>(60_000),
      emitDiagnostic: () => undefined,
    });

    await expect(provider.price(BRANDED_SIGNAL)).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("declines before issuing a shared claim that cannot be reconciled", async () => {
    const claim = vi.fn(async () => true);
    const cache: TtlCache<EbaySoldComp[]> = {
      scope: "shared",
      async get() {
        return null;
      },
      async set() {
        throw new Error("unreached store");
      },
      claim,
    };
    const fetchPage = vi.fn<FetchPage>(async () => FIXTURE_HTML);
    const provider = createRawEbaySoldPricingProvider({
      fetchPage,
      cache,
      emitDiagnostic: () => undefined,
    });

    await expect(provider.price(BRANDED_SIGNAL)).resolves.toBeNull();
    expect(claim).not.toHaveBeenCalled();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("does not infer operator authority from an injected fetch seam", async () => {
    const fetchPage = fakeFetch(FIXTURE_HTML);
    const provider = createRawEbaySoldPricingProvider({
      fetchPage,
      cache: createInMemoryTtlCache<EbaySoldComp[]>(60_000),
      emitDiagnostic: () => undefined,
    });

    await expect(provider.price(BRANDED_SIGNAL)).resolves.toBeNull();
    expect(fetchPage.urls).toHaveLength(0);
  });

  it("does not let a ten-only cache entry suppress expansion for another condition", async () => {
    const used = srp([
      soldCard("https://www.ebay.com/itm/used-a", 170, 1),
      soldCard("https://www.ebay.com/itm/used-b", 180, 2),
      soldCard("https://www.ebay.com/itm/used-c", 190, 3),
    ]);
    const brandNew = used.replaceAll("Pre-Owned", "Brand New");
    const urls: string[] = [];
    const fetchPage = vi.fn(async (url: string) => {
      urls.push(url);
      return new URL(url).searchParams.get("_ipg") === "20" ? brandNew : used;
    });
    const provider = createEbaySoldPricingProvider({
      fetchPage,
      cache: createInMemoryTtlCache<EbaySoldComp[]>(60_000),
    });

    await expect(provider.price(BRANDED_SIGNAL)).resolves.not.toBeNull();
    await expect(
      provider.price({
        ...BRANDED_SIGNAL,
        condition: "brand new",
      }),
    ).resolves.not.toBeNull();

    expect(urls.map((url) => new URL(url).searchParams.get("_ipg"))).toEqual([
      "10",
      "10",
      "20",
    ]);
  });

  it("declares its tier and only handles identifiable signals", () => {
    const provider = createEbaySoldPricingProvider({ fetchPage: fakeFetch(FIXTURE_HTML) });
    expect(provider.tier).toBe("ebay-sold");
    expect(provider.canHandle?.(BRANDED_SIGNAL)).toBe(true);
    expect(provider.canHandle?.({ upc: "027242920569" })).toBe(true);
    expect(provider.canHandle?.({ isbn: "9780140328721" })).toBe(true);
    expect(provider.canHandle?.({})).toBe(false);
    expect(provider.canHandle?.({ brand: "Sony" })).toBe(false); // bare brand
  });

  it("prices a branded item from the scraped sold page (median + cited sold comps)", async () => {
    const fetchPage = fakeFetch(FIXTURE_HTML);
    const provider = createEbaySoldPricingProvider({ fetchPage });
    const result = await provider.price(BRANDED_SIGNAL);

    expect(result).not.toBeNull();
    expect(() => priceResultSchema.parse(result)).not.toThrow();
    expect(result!.tier).toBe("ebay-sold");
    expect(result!.suggested).toBeCloseTo(FIXTURE_MEDIAN, 2);
    expect(result!.sources.every((s) => s.kind === "sold-comp")).toBe(true);
    // It fetched the SOLD/COMPLETED results page for this identity.
    expect(fetchPage.urls).toHaveLength(1);
    expect(new URL(fetchPage.urls[0]).searchParams.get("_ipg")).toBe("10");
    expect(fetchPage.urls[0]).toContain("LH_Sold=1");
    expect(fetchPage.urls[0]).toContain("Sony");
  });

  it("rejects hostile freshly fetched rows through the same sold-item boundary", async () => {
    const hostileHtml = `<ul class="srp-results">
      <li class="s-item">
        <a class="s-item__link" href="https://evil.example/itm/poisoned-a"><div class="s-item__title">Sony WH-1000XM4 Wireless Headphones</div></a>
        <span class="s-item__price">$170.00</span>
        <div class="s-item__caption"><span>Sold May 1, 2026</span></div>
      </li>
      <li class="s-item">
        <a class="s-item__link" href="https://www.ebay.com/help/poisoned-b"><div class="s-item__title">Sony WH-1000XM4 Wireless Headphones</div></a>
        <span class="s-item__price">$190.00</span>
        <div class="s-item__caption"><span>Sold May 2, 2026</span></div>
      </li>
    </ul>`;
    const fetchPage = fakeFetch(hostileHtml);
    const provider = createEbaySoldPricingProvider({ fetchPage });

    await expect(provider.price(BRANDED_SIGNAL)).resolves.toBeNull();
    expect(fetchPage.urls.map((url) => new URL(url).searchParams.get("_ipg"))).toEqual([
      "10",
      "20",
    ]);
  });

  it("declines (null) — never throws — when the page fetch is blocked", async () => {
    const fetchPage = blockedFetch();
    const provider = createEbaySoldPricingProvider({ fetchPage });
    // A blocked scraper is an EXPECTED, recoverable condition: decline so the
    // router falls through to the legal web-search tier, don't hard-fail.
    await expect(provider.price(BRANDED_SIGNAL)).resolves.toBeNull();
    expect(fetchPage.urls).toHaveLength(1);
  });

  it("does not leak proxy credentials from a blocked fetch error into logs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const provider = createEbaySoldPricingProvider({
      fetchPage: async () => {
        throw new Error("request failed for https://proxy.example/?token=super-secret");
      },
    });

    await expect(provider.price(BRANDED_SIGNAL)).resolves.toBeNull();
    expect(log.mock.calls.flat().join("\n")).not.toContain("super-secret");
    log.mockRestore();
  });

  it("falls back to the Playwright-style fetcher when the primary is blocked", async () => {
    const primary = blockedFetch();
    const fallback = fakeFetch(FIXTURE_HTML);
    const provider = createEbaySoldPricingProvider({
      fetchPage: primary,
      fetchPageFallback: fallback,
    });
    const result = await provider.price(BRANDED_SIGNAL);
    expect(result).not.toBeNull();
    expect(result!.tier).toBe("ebay-sold");
    expect(primary.urls).toHaveLength(1); // primary tried first
    expect(fallback.urls).toHaveLength(1); // then the fallback rescued it
  });

  it("declines when fewer than MIN_COMPS sold comps are found", async () => {
    const thin = `<ul class="srp-results"><li class="s-item">
      <a class="s-item__link" href="https://www.ebay.com/itm/1"><div class="s-item__title">Sony WH-1000XM4</div></a>
      <span class="s-item__price">$178.00</span>
      <div class="s-item__caption"><span>Sold May 1, 2026</span></div></li></ul>`;
    expect(EBAY_SOLD_MIN_COMPS).toBeGreaterThan(1);
    const provider = createEbaySoldPricingProvider({ fetchPage: fakeFetch(thin) });
    expect(await provider.price(BRANDED_SIGNAL)).toBeNull();
  });

  it("declines an unidentifiable signal without fetching at all", async () => {
    const fetchPage = fakeFetch(FIXTURE_HTML);
    const provider = createEbaySoldPricingProvider({ fetchPage });
    expect(await provider.price({})).toBeNull();
    expect(fetchPage.urls).toHaveLength(0);
  });

  it("is disabled by EBAY_SOLD_ENABLED=false (declines without fetching)", async () => {
    vi.stubEnv("EBAY_SOLD_ENABLED", "false");
    expect(ebaySoldConfigured()).toBe(false);
    const fetchPage = fakeFetch(FIXTURE_HTML);
    const provider = createEbaySoldPricingProvider({ fetchPage });
    expect(await provider.price(BRANDED_SIGNAL)).toBeNull();
    expect(fetchPage.urls).toHaveLength(0);
  });

  it("guards BOTH fetch seams with the SSRF validator (round-6)", async () => {
    // A non-eBay/internal EBAY_SOLD_BASE_URL must reach NEITHER the primary nor the
    // injected fallback — the guard lives at the provider boundary, not just inside
    // the default fetcher.
    const primary = fakeFetch(FIXTURE_HTML);
    const fallback = fakeFetch(FIXTURE_HTML);
    const provider = createEbaySoldPricingProvider({
      baseUrl: "https://evil.example.com",
      fetchPage: primary,
      fetchPageFallback: fallback,
    });
    expect(await provider.price(BRANDED_SIGNAL)).toBeNull();
    expect(primary.urls).toHaveLength(0);
    expect(fallback.urls).toHaveLength(0);
  });
});

describe("ebay-sold wired into the PriceRouter above the web tiers", () => {
  const declineIsbn: PricingProvider = {
    tier: "isbn-lookup",
    canHandle: (s) => Boolean(s.isbn),
    price: async () => null,
  };
  const brandedStub: PricingProvider = {
    tier: "branded-web",
    price: async () => ({
      suggested: 150,
      range: { min: 120, max: 180 },
      confidence: 0.6,
      sources: [{ url: "https://www.ebay.com/itm/asking", kind: "asking-comp" }],
      tier: "branded-web" as const,
    }),
  };

  it("wins over the branded web tier when sold comps are found (sold beats asking)", async () => {
    const ebaySold = createEbaySoldPricingProvider({ fetchPage: fakeFetch(FIXTURE_HTML) });
    const router = new PriceRouter([declineIsbn, ebaySold, brandedStub]);
    const result = await router.price(BRANDED_SIGNAL);
    expect(result.tier).toBe("ebay-sold");
    expect(result.sources.every((s) => s.kind === "sold-comp")).toBe(true);
  });

  it("falls through to the web tier when the scrape is blocked", async () => {
    const ebaySold = createEbaySoldPricingProvider({ fetchPage: blockedFetch() });
    const router = new PriceRouter([declineIsbn, ebaySold, brandedStub]);
    const result = await router.price(BRANDED_SIGNAL);
    expect(result.tier).toBe("branded-web");
  });

  it("falls through without hostile evidence when every cached sold row is rejected", async () => {
    const cache: TtlCache<EbaySoldComp[]> = {
      get: async () => [
        {
          url: "https://evil.example/itm/poisoned-a",
          title: "Sony WH-1000XM4 Wireless Headphones",
          price: 170,
        },
        {
          url: "https://www.ebay.com/help/poisoned-b",
          title: "Sony WH-1000XM4 Wireless Headphones",
          price: 190,
        },
        {
          url: "/itm/poisoned-c",
          title: "Sony WH-1000XM4 Wireless Headphones",
          price: 175,
        },
        {
          url: "itm/poisoned-d",
          title: "Sony WH-1000XM4 Wireless Headphones",
          price: 185,
        },
      ],
      set: async () => undefined,
    };
    const ebaySold = createEbaySoldPricingProvider({
      fetchPage: fakeFetch(FIXTURE_HTML),
      cache,
    });
    const result = await new PriceRouter([declineIsbn, ebaySold, brandedStub]).price(
      BRANDED_SIGNAL,
    );

    expect(result).toMatchObject({ tier: "branded-web", suggested: 150 });
    expect(result.sources).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: expect.stringContaining("poisoned") }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Freshness: sale-date capture, TTL cache, staleness drop, recency weighting (#59)
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 14); // fixed "now" for deterministic age-decay
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Mon D, YYYY" for a sale `daysAgo` before NOW (matches eBay's caption format). */
function soldDateText(daysAgo: number): string {
  const d = new Date(NOW - daysAgo * DAY);
  return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
function soldCard(href: string, price: number, daysAgo: number): string {
  return `<li class="s-item">
    <a class="s-item__link" href="${href}"><div class="s-item__title">Sony WH-1000XM4 Headphones</div></a>
    <span class="s-item__price">$${price.toFixed(2)}</span>
    <div class="s-item__caption"><span>Sold ${soldDateText(daysAgo)}</span></div>
    <div class="s-item__subtitle"><span class="SECONDARY_INFO">Pre-Owned</span></div>
  </li>`;
}
const srp = (cards: string[]) => `<ul class="srp-results">${cards.join("")}</ul>`;

/** A FetchPage whose body can be swapped mid-test (to simulate a block→recover). */
function mutableFetch(initial: string): FetchPage & { urls: string[]; set: (b: string) => void } {
  let body = initial;
  const urls: string[] = [];
  const fn = (async (url: string) => {
    urls.push(url);
    return body;
  }) as FetchPage & { urls: string[]; set: (b: string) => void };
  fn.urls = urls;
  fn.set = (b) => {
    body = b;
  };
  return fn;
}

describe("parseSoldDate", () => {
  it("parses an &nbsp;-separated caption to an epoch ms", () => {
    expect(parseSoldDate("Sold Jun 3, 2026")).toBe(Date.parse("Jun 3, 2026"));
  });

  it("parses a plain-space caption", () => {
    expect(parseSoldDate("Sold Jun 3, 2026")).toBe(Date.parse("Jun 3, 2026"));
  });

  it("returns undefined for a missing or unparseable date (kept as neutral)", () => {
    expect(parseSoldDate(undefined)).toBeUndefined();
    expect(parseSoldDate("Sold")).toBeUndefined();
    expect(parseSoldDate("Completed listing")).toBeUndefined();
  });
});

describe("parseSoldComps — sale-date capture (#59)", () => {
  it("populates soldAt from the card caption when present", () => {
    const html = srp([soldCard("https://www.ebay.com/itm/1", 180, 5)]);
    const [comp] = parseSoldComps(html);
    expect(comp.soldAt).toBe(Date.parse(soldDateText(5)));
  });
});

describe("createEbaySoldPricingProvider — TTL request cache (#59)", () => {
  it.each([
    { label: "object", payload: { rows: [] } },
    { label: "scalar", payload: 42 },
  ])(
    "declines a malformed non-array $label cache hit without fetching",
    async ({ payload }) => {
      const fetchPage = fakeFetch(FIXTURE_HTML);
      const cache: TtlCache<EbaySoldComp[]> = {
        get: async () => payload as unknown as EbaySoldComp[],
        set: async () => undefined,
      };
      const diagnostics: Array<{ event: string; fields: LogFields }> = [];
      const provider = createEbaySoldPricingProvider({
        fetchPage,
        cache,
        emitDiagnostic: (event, fields) => diagnostics.push({ event, fields }),
      });

      await expect(provider.price(BRANDED_SIGNAL)).resolves.toBeNull();
      expect(fetchPage.urls).toHaveLength(0);
      // A malformed payload must not be an invisible decline: every other
      // cache/coordination decline in the module emits before returning null.
      expect(diagnostics).toContainEqual({
        event: "pricing.ebay_sold.cost_fence_unavailable",
        fields: { reason: "initial-read-malformed" },
      });
    },
  );

  it("declines a mixed-row cache hit without fetching", async () => {
    const fetchPage = fakeFetch(FIXTURE_HTML);
    const cache: TtlCache<EbaySoldComp[]> = {
      get: async () =>
        [
          {
            url: "https://www.ebay.com/itm/cache-a",
            title: "Sony WH-1000XM4 Wireless Headphones",
            price: 170,
          },
          null,
          {
            url: "https://www.ebay.com/itm/cache-b",
            title: "Sony WH-1000XM4 Wireless Headphones",
            price: 190,
          },
        ] as unknown as EbaySoldComp[],
      set: async () => undefined,
    };
    const provider = createEbaySoldPricingProvider({ fetchPage, cache });

    await expect(provider.price(BRANDED_SIGNAL)).resolves.toBeNull();
    expect(fetchPage.urls).toHaveLength(0);
  });

  it("declines a malformed claimed-cache handoff without fetching", async () => {
    const fetchPage = vi.fn<FetchPage>(async () => FIXTURE_HTML);
    let reads = 0;
    const cache: TtlCache<EbaySoldComp[]> = {
      scope: "shared",
      async get() {
        reads += 1;
        return reads === 1
          ? null
          : ({ rows: [] } as unknown as EbaySoldComp[]);
      },
      set: async () => undefined,
      claim: async () => false,
      getClaimOwner: async () => "another-owner",
    };
    const diagnostics: Array<{ event: string; fields: LogFields }> = [];
    const provider = createRawEbaySoldPricingProvider({
      fetchPage,
      cache,
      emitDiagnostic: (event, fields) => diagnostics.push({ event, fields }),
    });

    await expect(provider.price(BRANDED_SIGNAL)).resolves.toBeNull();
    expect(fetchPage).not.toHaveBeenCalled();
    // The claim loser's handoff read is the other silent decline: a malformed
    // winner payload must name itself rather than look like an empty handoff.
    expect(diagnostics).toContainEqual({
      event: "pricing.ebay_sold.cost_fence_unavailable",
      fields: { reason: "handoff-malformed" },
    });
  });

  it("declines cached rows with non-positive prices without fetching", async () => {
    const fetchPage = fakeFetch(FIXTURE_HTML);
    const cache: TtlCache<EbaySoldComp[]> = {
      get: async () => [
        {
          url: "https://www.ebay.com/itm/cache-a",
          title: "Sony WH-1000XM4 Wireless Headphones",
          price: -170,
        },
        {
          url: "https://www.ebay.com/itm/cache-b",
          title: "Sony WH-1000XM4 Wireless Headphones",
          price: 0,
        },
      ],
      set: async () => undefined,
    };
    const provider = createEbaySoldPricingProvider({ fetchPage, cache });

    await expect(provider.price(BRANDED_SIGNAL)).resolves.toBeNull();
    expect(fetchPage.urls).toHaveLength(0);
  });

  it("rejects hostile cached rows before they can produce sold authority", async () => {
    const fetchPage = fakeFetch(FIXTURE_HTML);
    const cache: TtlCache<EbaySoldComp[]> = {
      get: async () => [
        {
          url: "https://evil.example/itm/poisoned-a",
          title: "Sony WH-1000XM4 Wireless Headphones",
          price: 170,
        },
        {
          url: "https://www.ebay.com/help/poisoned-b",
          title: "Sony WH-1000XM4 Wireless Headphones",
          price: 190,
        },
        {
          url: "/itm/poisoned-c",
          title: "Sony WH-1000XM4 Wireless Headphones",
          price: 175,
        },
        {
          url: "itm/poisoned-d",
          title: "Sony WH-1000XM4 Wireless Headphones",
          price: 185,
        },
      ],
      set: async () => undefined,
    };
    const provider = createEbaySoldPricingProvider({ fetchPage, cache });

    await expect(provider.price(BRANDED_SIGNAL)).resolves.toBeNull();
    expect(fetchPage.urls).toHaveLength(0);
  });

  it("normalizes canonical cached rows without fetching", async () => {
    const fetchPage = fakeFetch(FIXTURE_HTML);
    const cache: TtlCache<EbaySoldComp[]> = {
      get: async () => [
        {
          url: "https://www.ebay.com/itm/cache-a?hash=item-a#fragment",
          title: "Sony WH-1000XM4 Wireless Headphones",
          price: 170,
        },
        {
          url: "https://www.ebay.com/itm/cache-b?hash=item-b#fragment",
          title: "Sony WH-1000XM4 Wireless Headphones",
          price: 190,
        },
      ],
      set: async () => undefined,
    };
    const provider = createEbaySoldPricingProvider({ fetchPage, cache });

    const result = await provider.price(BRANDED_SIGNAL);

    expect(result?.sources.map(({ url }) => url)).toEqual([
      "https://www.ebay.com/itm/cache-a",
      "https://www.ebay.com/itm/cache-b",
    ]);
    expect(fetchPage.urls).toHaveLength(0);
  });

  it("cache-miss → fetch; cache-hit within TTL → reuse (no second fetch)", async () => {
    const fetchPage = fakeFetch(FIXTURE_HTML);
    const cache = createInMemoryTtlCache<EbaySoldComp[]>(60_000);
    const provider = createEbaySoldPricingProvider({ fetchPage, cache });

    const first = await provider.price(BRANDED_SIGNAL);
    const second = await provider.price(BRANDED_SIGNAL);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.suggested).toBe(first!.suggested);
    expect(fetchPage.urls).toHaveLength(1); // second served from cache
  });

  it("caches an empty expanded scrape so retry cannot start a third request", async () => {
    const fetchPage = mutableFetch("");
    const cache = createInMemoryTtlCache<EbaySoldComp[]>(60_000);
    const provider = createEbaySoldPricingProvider({ fetchPage, cache });

    expect(await provider.price(BRANDED_SIGNAL)).toBeNull();
    fetchPage.set(FIXTURE_HTML);
    expect(await provider.price(BRANDED_SIGNAL)).toBeNull();
    expect(fetchPage.urls).toHaveLength(2);
  });

  it("caches a thin expanded scrape so retry cannot start a third request", async () => {
    const thin = srp([soldCard("https://www.ebay.com/itm/1", 178, 5)]); // 1 raw comp < MIN
    const fetchPage = mutableFetch(thin);
    const cache = createInMemoryTtlCache<EbaySoldComp[]>(60_000);
    const provider = createEbaySoldPricingProvider({ fetchPage, cache });

    expect(await provider.price(BRANDED_SIGNAL)).toBeNull();
    fetchPage.set(FIXTURE_HTML);
    expect(await provider.price(BRANDED_SIGNAL)).toBeNull();
    expect(fetchPage.urls).toHaveLength(2);
  });

  it("declines without throwing when a shared cache outage prevents winner storage", async () => {
    vi.useFakeTimers();
    // The claimed retrieval may finish after a transient read failure, but its
    // evidence cannot be returned unless the shared store makes it observable
    // to other runtimes. Decline so the router can continue fail-soft.
    const fetchPage = fakeFetch(FIXTURE_HTML);
    const throwingCache: TtlCache<EbaySoldComp[]> = {
      async get() {
        throw new Error("upstash unreachable");
      },
      async set() {
        throw new Error("upstash unreachable");
      },
    };
    const provider = createEbaySoldPricingProvider({
      fetchPage,
      fetchTimeoutMs: 1,
      cache: throwingCache,
    });

    const result = provider.price(BRANDED_SIGNAL);
    await vi.advanceTimersByTimeAsync(502);

    await expect(result).resolves.toBeNull();
    expect(fetchPage.urls).toHaveLength(1);
  });
});

describe("createEbaySoldPricingProvider — age-decay (#59, now injected)", () => {
  it("drops stale comps so an ancient sale can't anchor today's price", async () => {
    const html = srp([
      soldCard("https://www.ebay.com/itm/1", 170, 3),
      soldCard("https://www.ebay.com/itm/2", 180, 6),
      soldCard("https://www.ebay.com/itm/3", 190, 9),
      soldCard("https://www.ebay.com/itm/4", 500, 1000), // ~3y old → stale
      soldCard("https://www.ebay.com/itm/5", 520, 1100), // ~3y old → stale
    ]);
    const fresh = await createEbaySoldPricingProvider({
      fetchPage: fakeFetch(html),
      now: () => NOW,
    }).price(BRANDED_SIGNAL);
    const noFreshness = await createEbaySoldPricingProvider({
      fetchPage: fakeFetch(html),
    }).price(BRANDED_SIGNAL);

    // With freshness on, the two ancient $500/$520 sales are dropped → the band
    // tops out at the recent cluster; without it, they widen the band and lift the median.
    expect(fresh!.range.max).toBe(190);
    expect(noFreshness!.range.max).toBe(520);
    expect(fresh!.suggested).toBeLessThan(noFreshness!.suggested);
  });

  it("declines when every comp is stale (too thin after the cutoff)", async () => {
    const html = srp([
      soldCard("https://www.ebay.com/itm/1", 500, 900),
      soldCard("https://www.ebay.com/itm/2", 520, 950),
    ]);
    const provider = createEbaySoldPricingProvider({ fetchPage: fakeFetch(html), now: () => NOW });
    expect(await provider.price(BRANDED_SIGNAL)).toBeNull();
  });

  it("recency-weights the suggested price toward more recent sales", async () => {
    // All fresh (within the cutoff), but the priciest sale is the most recent and
    // the cheapest is the oldest → the weighted median lifts above the plain median.
    const html = srp([
      soldCard("https://www.ebay.com/itm/1", 100, 130), // old + cheap
      soldCard("https://www.ebay.com/itm/2", 150, 60),
      soldCard("https://www.ebay.com/itm/3", 200, 2), // recent + pricey
    ]);
    const weighted = await createEbaySoldPricingProvider({
      fetchPage: fakeFetch(html),
      now: () => NOW,
    }).price(BRANDED_SIGNAL);
    const plain = await createEbaySoldPricingProvider({
      fetchPage: fakeFetch(html),
    }).price(BRANDED_SIGNAL);

    expect(plain!.suggested).toBe(150); // plain median of [100,150,200]
    expect(weighted!.suggested).toBeGreaterThan(plain!.suggested);
  });
});

// ---------------------------------------------------------------------------
// The shared verified-sold finalization seam (#363)
// ---------------------------------------------------------------------------

/** One anchor-eligible sold comp; omit `soldAt` to leave the sale undated. */
function anchorComp(
  id: string,
  price: number,
  soldAt?: number,
  condition = "Pre-Owned",
): EbaySoldComp {
  return {
    url: `https://www.ebay.com/itm/${id}`,
    title: "Sony WH-1000XM4 Wireless Headphones",
    price,
    condition,
    ...(soldAt != null ? { soldAt } : {}),
  };
}

const STALE_SOLD_AT = NOW - 400 * DAY;
const FINALIZATION_FRESHNESS = {
  staleDays: SOLD_STALE_DAYS_DEFAULT,
  halfLifeDays: SOLD_HALFLIFE_DAYS_DEFAULT,
};

describe("finalizeVerifiedSoldResult — one shared seam for every retrieval adapter (#363)", () => {
  it("declines when fewer than two verified anchors survive", () => {
    const evidence = selectSoldCompEvidence(
      [anchorComp("only", 180)],
      BRANDED_SIGNAL,
    );

    expect(evidence.anchors).toHaveLength(1);
    expect(finalizeVerifiedSoldResult(evidence, FINALIZATION_FRESHNESS)).toBeNull();
  });

  it("retains at most five deterministically ranked verified matches, never padded", () => {
    // Seven equally-scored, undated anchors: rank falls through to the stable
    // canonical-URL tie-break, so retrieval order cannot change the projection.
    const comps = ["7", "5", "1", "3", "6", "2", "4"].map((id) =>
      anchorComp(id, 100 + Number(id)),
    );
    const evidence = selectSoldCompEvidence(comps, BRANDED_SIGNAL);

    const result = finalizeVerifiedSoldResult(evidence, FINALIZATION_FRESHNESS);

    expect(evidence.anchors).toHaveLength(7);
    expect(result!.evidence!.map((entry) => entry.sourceUrl)).toEqual([
      "https://www.ebay.com/itm/1",
      "https://www.ebay.com/itm/2",
      "https://www.ebay.com/itm/3",
      "https://www.ebay.com/itm/4",
      "https://www.ebay.com/itm/5",
    ]);
    expect(result!.sources).toHaveLength(5);
    expect(result!.suggested).toBe(103); // median of [101,102,103,104,105]
  });

  it("drops stale anchors before retention, weighting, and the minimum-evidence gate", () => {
    const evidence = selectSoldCompEvidence(
      [anchorComp("fresh", 180), anchorComp("stale", 900, STALE_SOLD_AT)],
      BRANDED_SIGNAL,
    );

    // Without a clock there is no age-decay layer, so both anchors stand.
    expect(finalizeVerifiedSoldResult(evidence, FINALIZATION_FRESHNESS)!.sources).toHaveLength(2);
    // With one, the stale sale is dropped and the survivor is below the gate.
    expect(finalizeVerifiedSoldResult(evidence, { ...FINALIZATION_FRESHNESS, now: NOW })).toBeNull();
  });

  it("weights the suggested price by canonical match score, not raw comp order", () => {
    const evidence = selectSoldCompEvidence(
      [anchorComp("same-condition", 100), anchorComp("adjacent-condition", 200, undefined, "Like New")],
      BRANDED_SIGNAL,
    );
    // The seller's "good" condition gives the first anchor a higher canonical
    // score, so weighted median must prefer 100 over raw-order median 150.
    expect(evidence.anchors[0].score).not.toBe(evidence.anchors[1].score);
    expect(finalizeVerifiedSoldResult(evidence, FINALIZATION_FRESHNESS)!.suggested).toBe(100);
  });
});

describe("verified sold finalization is identical across retrieval adapters (#363)", () => {
  /** A public sold card with no parseable sale date (caption present, date absent). */
  function undatedCard(id: string, price: number): string {
    return `<li class="s-item">
      <a class="s-item__link" href="https://www.ebay.com/itm/${id}"><div class="s-item__title">Sony WH-1000XM4 Wireless Headphones</div></a>
      <span class="s-item__price">$${price.toFixed(2)}</span>
      <div class="s-item__caption"><span>Sold</span></div>
      <div class="s-item__subtitle"><span class="SECONDARY_INFO">Pre-Owned</span></div>
    </li>`;
  }

  /** The same seven sales, expressed in each adapter's own retrieval shape. */
  const FRESH: Array<[string, number]> = [
    ["a", 170],
    ["b", 180],
    ["c", 190],
    ["d", 200],
    ["e", 210],
    ["f", 175],
  ];
  const STALE_ID = "z";
  const STALE_PRICE = 185;

  /** Only the finalized facts both adapters must agree on. Sale timestamps are
   * excluded: the public page reports a local-midnight caption date and the
   * Actor an ISO instant, which is a retrieval difference, not a finalization one. */
  function finalizedFacts(result: PriceResult) {
    return {
      suggested: result.suggested,
      range: result.range,
      confidence: result.confidence,
      compAgreement: result.compAgreement,
      tier: result.tier,
      cited: result.evidence!.map((entry) => [entry.sourceUrl, entry.price]),
    };
  }

  it("finalizes the same sales into the same cited result from both adapters", async () => {
    const publicPage = await createEbaySoldPricingProvider({
      fetchPage: fakeFetch(
        srp([
          ...FRESH.map(([id, price]) => undatedCard(id, price)),
          soldCard(`https://www.ebay.com/itm/${STALE_ID}`, STALE_PRICE, 400),
        ]),
      ),
      now: () => NOW,
    }).price(BRANDED_SIGNAL);

    const apify = await createApifySoldPricingProvider({
      enabled: true,
      token: "test-token",
      cache: createInMemoryTtlCache(60_000, () => NOW, "shared"),
      now: () => NOW,
      runActor: async () => ({
        status: "SUCCEEDED",
        items: [
          ...FRESH.map(([id, price]) => ({
            url: `https://www.ebay.com/itm/${id}`,
            title: "Sony WH-1000XM4 Wireless Headphones",
            condition: "Pre-Owned",
            soldPrice: price,
            soldCurrency: "USD",
          })),
          {
            url: `https://www.ebay.com/itm/${STALE_ID}`,
            title: "Sony WH-1000XM4 Wireless Headphones",
            condition: "Pre-Owned",
            soldPrice: STALE_PRICE,
            soldCurrency: "USD",
            endedAt: new Date(STALE_SOLD_AT).toISOString(),
          },
        ],
      }),
    }).price(BRANDED_SIGNAL);

    // The stale sale is dropped and the sixth fresh sale falls outside the
    // best-five retention, so the median of [170,180,190,200,210] stands.
    expect(publicPage!.suggested).toBe(190);
    expect(publicPage!.range).toEqual({ min: 170, max: 210 });
    expect(publicPage!.evidence!.map((entry) => entry.sourceUrl)).toEqual([
      "https://www.ebay.com/itm/a",
      "https://www.ebay.com/itm/b",
      "https://www.ebay.com/itm/c",
      "https://www.ebay.com/itm/d",
      "https://www.ebay.com/itm/e",
    ]);
    expect(finalizedFacts(apify!)).toEqual(finalizedFacts(publicPage!));
  });
});
