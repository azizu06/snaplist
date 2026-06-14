import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EBAY_SOLD_MIN_COMPS,
  assertSafeEbayUrl,
  buildSoldSearchUrl,
  createDefaultFetchPage,
  createEbaySoldPricingProvider,
  ebaySoldConfigured,
  filterRelevantComps,
  isAllowedEbayHost,
  isPrivateOrInternalHost,
  parsePrice,
  parseSoldComps,
  synthesizeSoldResult,
  type EbaySoldComp,
  type FetchPage,
} from "./ebay-sold";
import { PriceRouter } from "../router";
import { priceResultSchema, type ItemSignal, type PricingProvider } from "../types";
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

afterEach(() => {
  vi.unstubAllEnvs();
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

  it("without a known model, trusts the exact eBay query but still drops parts/accessories", () => {
    const upcSignal = { upc: "027242920569" } as ItemSignal;
    const comps: EbaySoldComp[] = [
      { url: "https://www.ebay.com/itm/1", title: "Sony WH-1000XM4 Headphones", price: 180 },
      { url: "https://www.ebay.com/itm/2", title: "WH-1000XM4 replacement ear pads", price: 20 },
      { url: "https://www.ebay.com/itm/3", title: "Headphones for parts not working", price: 30 },
    ];
    const r = filterRelevantComps(comps, upcSignal);
    expect(r.map((c) => c.price)).toEqual([180]);
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
    const consoleSignal: ItemSignal = { brand: "Sony", model: "PS5" };
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

describe("createEbaySoldPricingProvider (offline via injected fetch)", () => {
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
    expect(fetchPage.urls[0]).toContain("LH_Sold=1");
    expect(fetchPage.urls[0]).toContain("Sony");
  });

  it("declines (null) — never throws — when the page fetch is blocked", async () => {
    const fetchPage = blockedFetch();
    const provider = createEbaySoldPricingProvider({ fetchPage });
    // A blocked scraper is an EXPECTED, recoverable condition: decline so the
    // router falls through to the legal web-search tier, don't hard-fail.
    await expect(provider.price(BRANDED_SIGNAL)).resolves.toBeNull();
    expect(fetchPage.urls).toHaveLength(1);
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
});
