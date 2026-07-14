# ADR-0001 — eBay public sold-listings as the primary used-price signal

- **Status:** Accepted (2026-06-14)
- **Deciders:** Aziz
- **Implemented by:** issue #56 (this tier) · #59 (freshness) · #60 (confidence wiring) · #61 (gold set) · #125 (egress validation and operator smoke)

## Context

SnapList prices *used* goods, and the single most defensible signal for a used price is a
**sold comp** — what the item actually sold for, not what someone is asking. The PRD and
`AGENTS.md` originally treated sold-price data as effectively unavailable:

- eBay **Marketplace Insights** (true sold prices) is gated/unavailable to solo devs.
- eBay **Browse** was dropped.
- The open web (via the **web-search agent**, tiers `upc-aided-web` / `branded-web`) mostly
  surfaces *asking* prices, which we already **down-weight** (`asking-comp` sources → the
  `web_wide` confidence tier).

That leaves the product honestly capped at "smart suggestion from asking prices." But eBay's
**sold/completed results pages** (`LH_Sold=1&LH_Complete=1`) are *publicly visible with no
login* — real completed-sale comps, reachable without an API. We had previously avoided this
on a "no scraping" reading of the PRD; that line is about **never scraping to post** (export
packs stay; we never automate posting via scraping). Reading *public, sold* result pages for
price *research* is a different act and is in scope.

The original "never scraping" framing (`PRD.md` "never scraping", sold-price data listed Out of
Scope) is therefore **narrowed, not reversed**: scraping-to-post stays prohibited; read-only
sold-comp research is now a first-class tier.

## Decision

1. **Add an `ebay-sold` PricingProvider tier** that scrapes eBay's public sold-listings pages
   for **sold comps**, and slot it in the router **above the web-search tiers** (sold beats
   asking) and below `isbn-lookup`. New router order:
   `isbn-lookup → ebay-sold → upc-aided-web → branded-web → depreciation → llm-only`.

2. **Plain `fetch` + `cheerio` by default; a Playwright-style fallback behind an injected
   seam.** No login is required. IP rate-limits, CAPTCHAs, markup drift, and other egress failures
   are expected runtime conditions.
   The concrete headless driver is intentionally **not bundled yet** (heavy dep, unvalidated
   against live blocking) — the `fetchPageFallback` seam and its decline-to-next-tier behavior
   are tested. Hosted environments may route the same in-process fetch through an optional,
   vendor-neutral `EBAY_SOLD_PROXY_TEMPLATE`; missing config preserves direct fetch, malformed
   config fails validation before egress, and the operator-controlled smoke is inert by default.
   The configured template and credentials are never emitted in its report.

3. **A blocked scrape DECLINES (`null`), never hard-fails.** Being rate-limited is an expected,
   recoverable condition, so the router falls through to the legal web-search tier. The fetch
   `catch` is kept narrow (network only; the cheerio parser is total) so it can't mask real bugs.
   Runtime diagnostics retain only bounded reasons (`timeout`, `http-NNN`, or `request-failed`),
   never raw upstream text that could contain a proxy URL or credential.

4. **SSRF-hardened target.** Every eBay target URL is validated before direct or proxy egress:
   `https` only, no userinfo, host must be `ebay.com` / `*.ebay.com`, and IP literals / internal /
   loopback / link-local hosts are rejected. The proxy endpoint is trusted operator configuration;
   the base eBay host remains constrained, so a misconfiguration declines before target egress.

5. **Freshness is live-fetch-first; the vector DB is NEVER the price oracle.** Sold prices drift,
   so the source of truth is a **live fetch at query time**. A TTL **cache-on-miss** + recency /
   age-decay layer (issue #59) reduces footprint without becoming the authority. The **reference
   corpus** (pgvector) keeps its PRD roles — grounding listing-copy few-shot and *corroborating*
   pricing — and explicitly does **not** serve stored prices as current truth.

6. **Confidence stays signal-based.** `ebay-sold` is sold-grounded by construction (every source
   is a `sold-comp`), so when its comps cluster tightly it maps to the first-class **`sold`**
   confidence tier — ranked ABOVE the asking-based web tiers and below only a sold-backed exact
   ISBN result
   (#60, "sold beats asking") — and to `web_wide` when scattered, since a scattered sold set is real
   evidence of *a* market but not of a defensible tight price and must not ride the sold label past
   the publish-eligibility gate. Remaining numeric calibration of the sold tier rides with the **gold set** (#61).

7. **Freshness is live-fetch-first, with a TTL cache + age-decay (#59).** The live sold page is the
   source of truth; a **TTL request cache** keyed by resolved product identity (the search URL)
   reuses a scrape for a few days to cut footprint (Upstash when configured, else per-instance
   in-memory — never the authority). Each comp's **sale date** is parsed from its card caption;
   at synthesis the suggested price is a **recency-weighted median** (newer sales weigh more, by a
   half-life) and comps older than a **staleness cutoff** are dropped — re-applied on every read, so
   a comp that ages out while cached is still dropped. Freshness is opt-in at the provider and wired
   on by `createDefaultPricer` (the composition root), keeping the scraper's unit tests deterministic.

## Alternatives considered

- **Apify / a paid scraping API** — rejected: ~$39/mo recurring, against the 100%-free-tier
  constraint, and it hides the engineering (the scraper *is* part of the showcase).
- **Reuse `branded-web` and just feed it eBay results** — rejected: conflates a distinct, higher-
  authority source (completed sales) with LLM-extracted open-web asking comps, and muddies the
  "which tier fired" provenance the confidence/eval spine depends on.
- **Seed sold prices into pgvector once and read them back** — rejected: prices go stale and the
  system would confidently hallucinate a current price from a months-old snapshot. Live-fetch +
  decay keeps it honest (see decision 5).

## Consequences

- **Positive:** real sold comps materially raise pricing quality for the hero domain; the
  pricing → confidence → eval spine gains a genuine ground-truth tier; the system degrades
  gracefully (disabled/blocked → web-search tier) and stays offline-testable (saved HTML fixture).
- **Negative / risks:** eBay markup can change, breaking selectors — mitigated by the fixture
  contract test and the operator-controlled live smoke; scraping is best-effort and not
  contractually stable; currency normalization is out of scope (the `.com` base assumes USD).
- **Honesty for the README/interview:** this is a *smart, sold-grounded suggestion*, not an oracle;
  the scraper is read-only price research, never a posting mechanism.

## Related docs

`PRD.md` and `AGENTS.md` hold the product/engineering invariants; `CONTEXT.md` defines the sold-comp
and egress vocabulary; `.env.example`, `README.md`, and `docs/sold-comps-egress.md` document the
optional proxy seam and safe operator proof. ADR-0002 records the Gemini-dev / OpenAI-showcase LLM
provider split (issue #55).
