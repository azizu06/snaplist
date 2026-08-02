import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteHeader } from "@/components/marketing/site-header";
import { WaitlistFormView } from "@/components/marketing/waitlist-form";
import * as site from "@/lib/marketing/site";
import LandingPage from "./page";
import PricingPage from "./pricing/page";
import PrivacyPage from "./privacy/page";
import SupportPage from "./support/page";

/**
 * The marketing surface is the one place SnapList makes claims to people who
 * have not used it, so its failure mode is a sentence that outlives the
 * behaviour behind it. The previous copy test pinned literal sentences, which
 * meant a retired capability stayed green until somebody remembered to update
 * the literal — the exact thing a test is supposed to make impossible.
 *
 * These assertions are derived from product capability instead:
 *   - The assisted marketplaces may never be the object of a publishing verb,
 *     whatever the surrounding wording is (PRD "Out of Scope", AGENTS.md).
 *   - Trophy Wall states must come from the vocabulary the product actually has.
 *     Nothing in this repository writes a sold listing status, and ADR-0008
 *     retires post-sale workflows.
 *   - Retired surfaces (inbox, buyer messaging, analytics, post-sale, autonomous
 *     marketplace actions) may not be named at all.
 *   - Social proof must be earned; there is none to cite yet.
 * A new section that breaks any of these fails without anyone editing this file.
 */

/** Marketplaces SnapList prepares a handoff for. It cannot post to them. */
const ASSISTED_MARKETPLACES = ["Mercari", "Facebook Marketplace", "Depop"];

/** Verbs that would claim SnapList delivered a listing to a marketplace. */
const DELIVERY_VERB = /\b(publish|publishes|published|list|lists|listed|post|posts|posted|sell|sells|sold|upload|uploads|uploaded)\b/i;

/** Wording that keeps an assisted destination honest about who finishes it. */
const HANDOFF_MARKER = /\b(handoff|prepare|prepares|prepared|you finish|finish (?:it )?(?:yourself|in their own apps)|share)\b/i;

/**
 * Trophy Wall states the PRD gives the product. `Sold` is deliberately absent.
 */
const TROPHY_WALL_STATES = new Set([
  "Accepted",
  "Analyzing",
  "Ready to review",
  "Needs retry",
  "Published",
  "Prepared",
  "Shared",
]);

/** Surfaces ADR-0008 retired. Naming one advertises a product that is not shipping. */
const RETIRED_SURFACES: [RegExp, string][] = [
  [/\binbox\b/i, "buyer inbox — retired by ADR-0008"],
  [/\bbuyer (?:message|messages|messaging|q&a)\b/i, "buyer messaging — retired by ADR-0008"],
  [/\banalytics\b/i, "analytics dashboard — retired by ADR-0008"],
  [/\b(?:reprice|repricing|relist|relisting)\b/i, "post-sale operations — retired by ADR-0008"],
  [/\bautomatically (?:publish|list|post)\b/i, "autonomous marketplace action — retired by ADR-0008"],
  [/\bbulk (?:capture|listing)\b|\bhaul\b/i, "bulk/haul launch posture — retired by ADR-0008"],
  [/\bcost basis\b|\bnet profit\b|\bprofit margin\b/i, "margin tracking — not in the lean MVP"],
];

/** Claims that need evidence SnapList does not have. */
const UNEARNED_PROOF: [RegExp, string][] = [
  [/\b\d[\d,]*\+?\s+(?:sellers|users|listings sold|happy)/i, "invented usage figure"],
  [/\btrusted by\b|\bloved by\b|\bjoin \d/i, "invented social proof"],
  [/\b\d(?:\.\d)?\s*(?:stars|\/\s*5)\b/i, "invented rating"],
];

/**
 * Elements that end one run of copy and start another. Everything else (span,
 * strong, em) is inline and belongs to the sentence around it.
 */
const BLOCK = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "dd", "dt", "figcaption",
  "blockquote", "summary", "td", "th", "button", "a", "div", "section",
  "article", "header", "footer", "nav", "aside", "main", "body",
]);

/**
 * Every claim the public surface renders, one unit per run of copy.
 *
 * Granularity is the whole point. `.text()` on a container concatenates
 * neighbouring elements with no separator, which glues "Confirm and publish to
 * eBay" onto the "Mercari" label beside it and manufactures a claim nobody
 * wrote. Rolling each text node up to its nearest block ancestor keeps an
 * accent `<span>` inside its sentence while keeping two sibling rows apart.
 * Sentences then split within a unit, because the page legitimately publishes
 * to eBay in one sentence and prepares a handoff in the next.
 */
function marketingBlocks(): string[] {
  const markup = [
    renderToStaticMarkup(<SiteHeader />),
    renderToStaticMarkup(<LandingPage />),
    renderToStaticMarkup(<PricingPage />),
    renderToStaticMarkup(<PrivacyPage />),
    renderToStaticMarkup(<SupportPage />),
    renderToStaticMarkup(<SiteFooter />),
  ].join("\n");

  const $ = load(markup);
  // Inferred from the API rather than imported from `domhandler`: that package
  // is a transitive dependency of cheerio, so under pnpm's strict layout the
  // import resolves at runtime (where the type is erased anyway) but fails
  // `tsc`. Deriving it keeps the annotation without adding a dependency.
  const elements = $("*").toArray();
  type DomElement = (typeof elements)[number];

  const blocks = new Set<DomElement>();
  for (const element of elements) {
    for (const node of $(element).contents().toArray()) {
      if (node.type !== "text" || !node.data.trim()) continue;
      let owner = node.parent;
      while (owner && !(owner.type === "tag" && BLOCK.has(owner.name))) owner = owner.parent;
      if (owner?.type === "tag") blocks.add(owner);
    }
  }

  // A block's own copy is its text nodes and inline descendants, never its
  // nested blocks — those are units in their own right. `.text()` would return
  // the whole subtree, so one caption inside the phone frame would swallow all
  // four screens and read as a single 350-character claim.
  const ownText = (block: DomElement) =>
    $(block)
      .contents()
      .toArray()
      .map((child) => {
        if (child.type === "text") return child.data;
        return child.type === "tag" && !BLOCK.has(child.name) ? $(child).text() : " ";
      })
      .join("")
      .replace(/\s+/g, " ")
      .trim();

  return [...blocks].map(ownText).filter(Boolean);
}

/**
 * The same copy split to sentences. Use this where a rule is about one claim,
 * and `marketingBlocks` where a rule is about a claim and its qualifier, which
 * are deliberately two sentences of one paragraph.
 */
function marketingCopy(): string[] {
  return marketingBlocks()
    .flatMap((text) => text.split(/(?<=[.!?])\s+/))
    .map((unit) => unit.trim())
    .filter(Boolean);
}

/** Every string reachable from the copy module, however it is nested. */
function copyStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(copyStrings);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("marketing honesty", () => {
  it("renders enough copy for the scans below to mean anything", () => {
    // Guards the guard: an empty render would make every assertion vacuous.
    const sentences = marketingCopy();
    expect(sentences.length).toBeGreaterThan(40);
    expect(sentences.join(" ")).toMatch(/eBay/);
    expect(sentences.join(" ")).toMatch(/Mercari/);
  });

  it("never puts an assisted marketplace on the receiving end of a publish", () => {
    const offenders = marketingCopy()
      .filter((sentence) => ASSISTED_MARKETPLACES.some((name) => sentence.includes(name)))
      .filter((sentence) => DELIVERY_VERB.test(sentence));

    expect(offenders).toEqual([]);
  });

  it("says who finishes an assisted marketplace every time it names one", () => {
    const unqualified = marketingCopy()
      .filter((sentence) => ASSISTED_MARKETPLACES.some((name) => sentence.includes(name)))
      .filter((sentence) => !HANDOFF_MARKER.test(sentence));

    expect(unqualified).toEqual([]);
  });

  it("shows only Trophy Wall states the product has", () => {
    const shown = site.TROPHY_WALL_ROWS.map((row) => row.state);
    expect(shown.length).toBeGreaterThan(0);
    for (const state of shown) {
      expect(TROPHY_WALL_STATES.has(state), `"${state}" is not a Trophy Wall state`).toBe(true);
    }
  });

  it("does not name a retired surface", () => {
    const copy = [...marketingCopy(), ...copyStrings(site)].join(" ");
    for (const [pattern, reason] of RETIRED_SURFACES) {
      expect(pattern.test(copy), `matched ${pattern} — ${reason}`).toBe(false);
    }
  });

  it("claims no usage, rating, or social proof it cannot cite", () => {
    // Scans the copy module as well as the render: a testimonial parked in
    // `site.ts` is a claim waiting for the section that will display it.
    const copy = [...marketingCopy(), ...copyStrings(site)].join(" ");
    for (const [pattern, reason] of UNEARNED_PROOF) {
      expect(pattern.test(copy), `matched ${pattern} — ${reason}`).toBe(false);
    }
  });

  it("never promises sold evidence without saying what happens when there is none", () => {
    // The pricing router routinely finds no trustworthy comps, and the PRD makes
    // the draft complete anyway with honest estimate language. A page that
    // promises matches and stops there is selling the tier that fires least.
    // Blocks, not sentences: the promise and its qualifier are deliberately two
    // sentences of one paragraph, and splitting them would pass a page that
    // never qualifies anything.
    const promises = marketingBlocks().filter((block) => /sold[\s-]price matches/i.test(block));
    expect(promises.length).toBeGreaterThan(0);

    const unqualified = promises.filter(
      (block) => !/when there are no|no sold matches|evidence is missing|estimate/i.test(block),
    );
    expect(unqualified).toEqual([]);
  });
});

describe("marketing destinations", () => {
  it("renders the launch waitlist form and its quiet states", () => {
    const landing = load(renderToStaticMarkup(<LandingPage />));
    const form = landing("form.mkt-waitlist");

    expect(form.length).toBe(1);
    expect(form.find('input[type="email"][name="email"][required]').length).toBe(1);
    expect(form.find('input[name="company"][tabindex="-1"]').length).toBe(1);
    expect(form.find('button[type="submit"]').text()).toBe("Join waitlist");
    expect(form.text()).toMatch(/We'll email you once when SnapList launches\./);

    const success = load(renderToStaticMarkup(
      <WaitlistFormView state={{ status: "success" }} action={() => undefined} pending={false} />,
    ));
    expect(success('[role="status"]').text()).toBe(
      "We'll email you once when SnapList launches.",
    );
    expect(success('input[name="email"]').length).toBe(0);

    const invalid = load(renderToStaticMarkup(
      <WaitlistFormView state={{ status: "invalid" }} action={() => undefined} pending={false} />,
    ));
    expect(invalid('[role="alert"]').text()).toBe("Enter a valid email address.");
    expect(invalid('input[name="email"]').length).toBe(1);
  });

  it("keeps pricing as an honest launch teaser", () => {
    const $ = load(renderToStaticMarkup(<PricingPage />));
    const text = $("body").text();

    expect(text).toMatch(/Your first listing is free\./);
    expect(text).toMatch(/SnapList Pro is an App Store subscription\./);
    expect(text).toMatch(/Pricing will be announced at launch\./);
    expect(text).not.toMatch(/\$\s*\d|\b(?:monthly|annual|allowance|tier)s?\b/i);
  });

  it("links pricing and does not revive the scrapped guide route", () => {
    const $ = load(renderToStaticMarkup(<SiteHeader />));

    expect($('a[href="/pricing"]').length).toBeGreaterThan(0);
    expect($('a[href="/tour"]').length).toBe(0);
  });

  it("renders no App Store link until a product page exists", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_STORE_URL", "");
    const $ = load(renderToStaticMarkup(<LandingPage />));

    expect($('a[href*="apps.apple.com"]').length).toBe(0);
    expect($(".mkt-appstore[data-pending='true']").length).toBeGreaterThan(0);
    expect($(".mkt-appstore").text()).toMatch(/Coming to the/);
  });

  it("links every App Store control once the product page is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_STORE_URL", "https://apps.apple.com/app/id123456789");
    const $ = load(renderToStaticMarkup(<LandingPage />));
    const links = $('a.mkt-appstore[href="https://apps.apple.com/app/id123456789"]');

    expect(links.length).toBe($(".mkt-appstore").length);
    expect(links.attr("aria-label")).toBe("Download SnapList on the App Store");
    expect($(".mkt-appstore[data-pending='true']").length).toBe(0);
  });

  it("refuses a configured destination that is not an absolute https URL", () => {
    for (const bad of ["/downloads", "http://apps.apple.com/app", "not a url", "   "]) {
      vi.stubEnv("NEXT_PUBLIC_APP_STORE_URL", bad);
      expect(site.appStoreURL(), `${bad} should not become a link`).toBeNull();
    }
  });

  it("refuses a support address that would open an unaddressed draft", () => {
    for (const bad of ["support", "support@", "@snaplist.dev", "a b@c.dev", "   "]) {
      vi.stubEnv("NEXT_PUBLIC_SUPPORT_EMAIL", bad);
      expect(site.supportEmail(), `${bad} should not become a mailto:`).toBeNull();
    }
    vi.stubEnv("NEXT_PUBLIC_SUPPORT_EMAIL", "help@snaplist.dev");
    expect(site.supportEmail()).toBe("help@snaplist.dev");
  });

  it("says a support channel is not live rather than linking to nothing", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPPORT_EMAIL", "");
    const $ = load(renderToStaticMarkup(<SupportPage />));

    expect($('a[href^="mailto:"]').length).toBe(0);
    expect($("body").text()).toMatch(/not live yet/i);
  });

  it("renders a real mailto: once a support address is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPPORT_EMAIL", "help@snaplist.dev");
    const $ = load(renderToStaticMarkup(<SupportPage />));

    expect($('a[href="mailto:help@snaplist.dev"]').length).toBe(1);
  });
});

describe("App Review destinations", () => {
  it("states the one use of a waitlist address", () => {
    const $ = load(renderToStaticMarkup(<PrivacyPage />));

    expect($("body").text()).toMatch(
      /If you join the launch waitlist, SnapList uses your email address only to send one launch email\./,
    );
  });

  it("keeps the privacy and support URLs resolvable without a session", () => {
    // App Review fetches both signed out before the 15 August submission. If the
    // proxy stops treating them as public they answer a redirect to /login,
    // which reads as a working page to a human and as a failure to review.
    const proxy = readFileSync(resolve("src/proxy.ts"), "utf8");
    const publicMatcher = proxy.slice(
      proxy.indexOf("createRouteMatcher(["),
      proxy.indexOf("]);", proxy.indexOf("createRouteMatcher([")),
    );

    expect(publicMatcher).toMatch(/"\/privacy"/);
    expect(publicMatcher).toMatch(/"\/support"/);
  });

  it("reaches both pages from the footer of every marketing page", () => {
    const $ = load(renderToStaticMarkup(<SiteFooter />));

    expect($('a[href="/privacy"]').length).toBe(1);
    expect($('a[href="/support"]').length).toBe(1);
  });

  it("does not offer a legal document SnapList has not written", () => {
    // v6 carries a Terms of Use row as the inert token LEGAL_TERMS_PENDING. No
    // terms document exists, and a link to a page that does not resolve is worse
    // than an absent row. See the #191 PR body.
    const $ = load(renderToStaticMarkup(<SiteFooter />));
    expect($("body").text()).not.toMatch(/terms of (?:use|service)/i);
  });
});

describe("marketing in-page navigation", () => {
  it("uses landing-page URLs for header sections", () => {
    const $ = load(renderToStaticMarkup(<SiteHeader />));

    expect($('a[href="/#features"]').length).toBeGreaterThan(0);
    expect($('a[href="/#faq"]').length).toBeGreaterThan(0);
  });

  it("points every in-page anchor at an element that exists", () => {
    const markup = [
      renderToStaticMarkup(<SiteHeader />),
      renderToStaticMarkup(<LandingPage />),
    ].join("\n");
    const $ = load(markup);

    // `#main` and `#top` live in the layout, which cannot render here (it loads
    // a Next font). Read the ids it declares out of the source instead.
    const layout = readFileSync(resolve("src/app/(marketing)/layout.tsx"), "utf8");
    const ids = new Set<string>([
      ...$("[id]").map((_, element) => $(element).attr("id") ?? "").get(),
      ...[...layout.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]),
    ]);

    const anchors = $('a[href^="#"]')
      .map((_, element) => $(element).attr("href") ?? "")
      .get()
      .filter((href) => href.length > 1);

    expect(anchors.length).toBeGreaterThan(0);
    const dead = anchors.filter((href) => !ids.has(href.slice(1)));
    expect(dead).toEqual([]);
  });
});

describe("feature explorer semantics", () => {
  it("exposes exactly one screen and one tabbable card", () => {
    const $ = load(renderToStaticMarkup(<LandingPage />));
    const tabs = $('[role="tab"]');

    expect(tabs.length).toBe(site.FEATURE_STEPS.length);
    expect(tabs.filter('[aria-selected="true"]').length).toBe(1);
    expect(tabs.filter('[tabindex="0"]').length).toBe(1);
    // Roving tabindex: the selected card is the one that takes focus, so Tab
    // enters the group at the card whose screen is showing.
    expect(tabs.filter('[aria-selected="true"]').attr("tabindex")).toBe("0");
    expect($('[role="tabpanel"]').length).toBe(1);
    expect($('.mkt-explorer__slide[data-active="true"]').length).toBe(1);
  });

  it("labels the panel with the card that controls it", () => {
    const $ = load(renderToStaticMarkup(<LandingPage />));
    const labelledBy = $('[role="tabpanel"]').attr("aria-labelledby");

    expect(labelledBy).toBeTruthy();
    expect($(`#${labelledBy}`).attr("aria-selected")).toBe("true");
    expect($(`#${labelledBy}`).attr("role")).toBe("tab");
  });

  it("marks the screen the native design package has not frozen", () => {
    const candidates = site.FEATURE_STEPS.filter((step) => step.candidate);
    expect(candidates.length).toBeGreaterThan(0);

    const $ = load(renderToStaticMarkup(<LandingPage />));
    for (const step of candidates) {
      const card = $(`#mkt-feature-tab-${step.id}`);
      expect(card.find(".mkt-chip").text(), `${step.title} must be marked`).toBe("Candidate");
    }
  });
});
