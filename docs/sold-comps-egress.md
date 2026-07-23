# Sold-comps egress and operator smoke

SnapList's in-process TypeScript `ebay-sold` PricingProvider reads eBay's public
sold/completed result pages for read-only price research. The selected direct or
proxy egress path can be blocked or return too few usable comps. When that happens,
the provider declines and the pricing router continues to its cited web-search,
depreciation, or LLM-only fallback tiers; it does not fail the listing pipeline.

This seam is unrelated to the transactional eBay adapter. It cannot create a
listing, send a message, or use seller OAuth.

## Default-off Caffein Apify retrieval adapter

Issue #200 adds a second retrieval strategy inside the same provider-neutral
`ebay-sold` tier. When explicitly enabled, the Caffein Apify adapter runs first;
on any failure, thin matcher output, or open circuit, the public-page provider
below remains the immediate fallback. Both strategies feed the same
anchor/corroboration/reject matcher, freshness layer, and minimum-two-anchor gate.
The recommendation and exposed evidence retain the same deterministically ranked,
deduplicated set of at most five verified matches.

The adapter is disabled unless both `APIFY_SOLD_ENABLED=true` and `APIFY_TOKEN`
are present. The token is passed to the official Apify client only; it never
enters an Actor URL, cache key, result, or diagnostic. Actor rows are untrusted:
normalization keeps only canonical eBay URL, title, positive USD sold price,
condition, sale date, and Best Offer disclosure. Seller fields, images, raw
payload fields, malformed URLs/prices, non-USD rows, and duplicates are dropped.

The tested default pins Actor `oTtB3VgfuE9GtxQt2` to build `1.18.3`. One logical
pricing pass requests exactly 10 candidates first and makes one 20-candidate
expansion only when fewer than three anchors survive the canonical matcher. A
terminal initial failure falls through without expansion. Each request is capped
at $0.11, 55 seconds of Actor runtime, 60 seconds of client wait, two
official-client post-run read retries, and no automatic Actor restart. The paid
Actor-start request itself is never retried. The remaining safety environment
values can tighten but not raise the in-code ceilings.

Terminal initial failures, completed empty results, and combined successful
results are cached so retry or queue redelivery cannot add a third paid request
when the shared cache is healthy. Before any paid request, an atomic shared-cache
claim fences the matcher-sensitive signal identity across worker runtimes. A
missing, process-local, or unavailable fence declines to the public sold provider
without starting the Actor. Cache misses for the same identity are also
coalesced inside one runtime, and age decay/staleness are reapplied on every cache
read. Actor failures accumulate across request-scoped providers sharing one cache
so the bounded circuit cannot reset on every request. The shared-cache deployment
remains an activation prerequisite.

Production activation is not part of Issue #200. Leave the flag off until the
owner approves a separate budget and validates current Actor schema/build/pricing
plus shared-cache deployment. The zero-network readiness command and measured
gate are in [the benchmark guide](./benchmarks/sold-comps/README.md).

Official contract references: [Caffein sold-listings Actor](https://apify.com/caffein.dev/ebay-sold-listings),
[Apify client retry/timeout options](https://docs.apify.com/api/client/js/reference/interface/ApifyClientOptions),
[Actor call caps and restart controls](https://docs.apify.com/api/client/js/reference/interface/ActorCallOptions),
and [eBay condition ID meanings](https://developer.ebay.com/api-docs/sell/static/metadata/condition-id-values.html).

## Bounded public-page retrieval

The normal public-page provider requests 10 candidates first and makes one
20-candidate expansion only when fewer than three anchors survive the canonical
matcher. Terminal and sparse outcomes are cached alongside successful combined
results. With no proxy configured, the real default direct eBay fetch is free and
may coordinate through the process-local cache and in-flight map when Upstash is
absent. Cache hits and same-runtime retry/redelivery reuse that winner; this mode
claims no cross-runtime guarantee. When Upstash is configured, the same direct
path retains the shared atomic claim and its cross-runtime winner guarantee.

A configured proxy or an injected, instrumented, or wrapped normal fetch path may
carry direct cost and therefore still requires the existing atomic shared-cache
claim to select one winner across worker runtimes. Losers read the winner's result
through a bounded handoff. A missing, process-local, or unavailable shared fence
declines to the next pricing tier without making that potentially billable request.

The effective per-request timeout defaults to 8 seconds and is capped at 15
seconds even when operator configuration requests more. A loser waits for at
most that effective timeout multiplied by the maximum two requests, plus a
bounded 500 ms store/read allowance. The initial shared read, atomic claim,
loser polling reads, and winner store are each bounded by the remaining logical
deadline; request timeouts also shrink to that remainder. A coordination timeout
aborts the underlying shared-cache request and declines without starting
unclaimed egress. Same-process waiters race shared work against their own
deadline without cancelling the winner. A winner returns evidence only after the
shared store makes that same result available to losers. Polling uses a bounded
backoff; expiry is fail-soft and never starts a loser retrieval.

The operator smoke below is intentionally different: its explicit
`--confirm-one-request` authorization permits exactly the initial 10-candidate
request and suppresses the optional expansion and fallback request. The smoke
module alone imports the separately named operator-only provider factory; normal
factory construction cannot select this bypass through fetcher injection or an
options flag.

## Optional proxy-template configuration

`EBAY_SOLD_PROXY_TEMPLATE` routes the already SSRF-validated eBay target through
an operator-selected HTTP rendering/proxy provider:

```dotenv
# Example shape only. Store the real value in local/deploy secrets.
EBAY_SOLD_PROXY_TEMPLATE=https://proxy.example/fetch?api_key=REPLACE_AT_DEPLOY&url={url}
```

Configuration rules:

- Missing or blank is valid and preserves the direct-fetch path.
- A configured template must be an absolute HTTPS URL with exactly one `{url}`
  placeholder. SnapList substitutes the encoded eBay target URL there.
- The placeholder must appear before any URL fragment (`#...`), because fragments
  are not sent to the proxy server.
- URL userinfo (`https://user:pass@...`) is rejected. If a provider requires a
  query credential, keep the complete template in the secret manager and never
  commit or print it.
- Malformed configuration fails environment/provider initialization with an
  `EBAY_SOLD_PROXY_TEMPLATE` error before any request is made.
- The eBay target remains restricted to `https://ebay.com` / `https://*.ebay.com`.
  The proxy endpoint itself is trusted operator configuration.

No proxy provider is required by the application. Missing/blank configuration
also remains valid for the live smoke, which then reports `egressMode: "direct"`.
Whether a configured provider charges for a request is controlled by that
provider's account and plan, not by SnapList.

## Offline smoke (safe default)

```bash
pnpm smoke:sold-comps
```

With the default enabled configuration, the dry run makes **zero external
requests**. It constructs the exact sold/completed target URL, validates optional
egress configuration, exercises the real `ebay-sold` provider and `PriceRouter`,
and records the expected deterministic fallback:

- `status: "fallback"`
- `selectedTier: "branded-web"` for the default branded item
- `fallbackReason: "dry-run-no-network"`
- `externalRequests: 0`

The fallback tier in this smoke is a no-network sentinel. It proves that a sold
tier decline reaches the next legal router tier; it does **not** claim that a live
web-search price was fetched. Automated tests use checked-in HTML fixtures and
injected blocked/no-results responses, so they cannot spend egress-provider units or call
production services.

## Operator-controlled live smoke

Run this only after the operator has reviewed the applicable access policy and,
when using proxy egress, the provider's billing/read policy. Put a real proxy
template in `.env.local` or the deployment secret manager; leave it missing/blank
to exercise direct fetch. The command requires both flags and performs at most
one sold-page request:

```bash
pnpm smoke:sold-comps -- --live --confirm-one-request

# Optional bounded item override: brand, model, category
pnpm smoke:sold-comps -- --live --confirm-one-request Sony WH-1000XM4 electronics
```

The script never calls the web-search or LLM fallbacks. Its JSON report is safe to
attach to an operator record and contains:

- `mode`: `dry-run` or `live`
- `status`: `success` or `fallback`
- `mode`: `live` (or `dry-run` for the inert default)
- `targetUrl`: the SSRF-validated eBay sold/completed query, or `null` when the
  signal cannot form one
- `selectedTier`: `ebay-sold` on usable comps; otherwise the deterministic next-tier sentinel
- `sourceUrls`: sold-listing citations on success
- `fallbackReason`: `disabled`, `unidentifiable`, `egress-blocked`, or
  `no-usable-sold-comps` (`dry-run-no-network` appears only in dry-run mode)
- `egressMode`: `direct` or `proxy`
- `externalRequests`: `0` or `1`
- `fallbackSimulated`: `true` when any deterministic fallback sentinel wins;
  `false` on real sold-comp success

It never prints the proxy template, provider credential, response HTML, or raw
upstream error text. Exit status is `0` for a completed dry run or successful live
proof, `2` for a live fallback, and `1` for invalid configuration/flag
confirmation; the last two let an operator record failure without confusing it
with successful sold-comp retrieval.

The normal provider follows the same redaction boundary. Its structured
`pricing.ebay_sold.fetch_blocked` and `pricing.ebay_sold.fallback_blocked`
diagnostics include only a bounded reason (`timeout`, `http-NNN`, or
`request-failed`) plus non-secret routing flags; raw proxy/upstream error messages
are discarded.

## Interpreting the result

- `ebay-sold` + sold-listing `sourceUrls`: the egress seam, parser, relevance
  filter, and provider selection worked for that item at that time.
- `egress-blocked`: the request failed or timed out. The normal application router
  continues to lower tiers.
- `no-usable-sold-comps`: a page was fetched, but fewer than the required relevant
  sold comps survived parsing/filtering. The router continues rather than
  manufacturing confidence.
- `disabled`: `EBAY_SOLD_ENABLED=false|0|off`; no request was made.
- `unidentifiable`: the supplied signal could not form a safe sold-search URL; no
  request was made.

The smoke does not change production pricing behavior. Normal application pricing
still wires the existing TTL cache, staleness cutoff, recency/age-decay weighting,
confidence composite, and full provider order through `createDefaultPricer`.
