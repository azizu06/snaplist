# Sold-comps egress and operator smoke

SnapList's in-process TypeScript `ebay-sold` PricingProvider reads eBay's public
sold/completed result pages for read-only price research. Direct server fetches
can be blocked by the host environment. When that happens, the provider declines
and the pricing router continues to its cited web-search, depreciation, or
LLM-only fallback tiers; it does not fail the listing pipeline.

This seam is unrelated to the transactional eBay adapter. It cannot create a
listing, send a message, or use seller OAuth.

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
- URL userinfo (`https://user:pass@...`) is rejected. If a provider requires a
  query credential, keep the complete template in the secret manager and never
  commit or print it.
- Malformed configuration fails environment/provider initialization with an
  `EBAY_SOLD_PROXY_TEMPLATE` error before any request is made.
- The eBay target remains restricted to `https://ebay.com` / `https://*.ebay.com`.
  The proxy endpoint itself is trusted operator configuration.

No proxy provider is required by the application. Whether a provider charges for
a request is controlled by that provider's account and plan, not by SnapList.

## Offline smoke (safe default)

```bash
pnpm smoke:sold-comps
```

The default dry run makes **zero external requests**. It constructs the exact
sold/completed target URL, validates optional egress configuration, exercises the
real `ebay-sold` provider and `PriceRouter`, and records the expected deterministic
fallback:

- `status: "fallback"`
- `selectedTier: "branded-web"` for the default branded item
- `fallbackReason: "dry-run-no-network"`
- `externalRequests: 0`

The fallback tier in this smoke is a no-network sentinel. It proves that a sold
tier decline reaches the next legal router tier; it does **not** claim that a live
web-search price was fetched. Automated tests use checked-in HTML fixtures and
injected blocked/no-results responses, so they cannot spend proxy credits or call
production services.

## Operator-controlled live smoke

Run this only after the operator has reviewed the proxy provider's billing/read
policy and placed the real template in `.env.local` or the deployment secret
manager. The command requires both flags and performs at most one sold-page
request:

```bash
pnpm smoke:sold-comps -- --live --confirm-one-request

# Optional bounded item override: brand, model, category
pnpm smoke:sold-comps -- --live --confirm-one-request Sony WH-1000XM4 electronics
```

The script never calls the web-search or LLM fallbacks. Its JSON report is safe to
attach to an operator record and contains:

- `status`: `success` or `fallback`
- `selectedTier`: `ebay-sold` on usable comps; otherwise the deterministic next-tier sentinel
- `sourceUrls`: sold-listing citations on success
- `fallbackReason`: `disabled`, `unidentifiable`, `egress-blocked`, or
  `no-usable-sold-comps`
- `egressMode`: `direct` or `proxy`
- `externalRequests`: `0` or `1`

It never prints the proxy template, provider credential, response HTML, or raw
upstream error text. A live fallback exits with status 2 so an operator can record
the failed proof without confusing it with a successful sold-comp retrieval.

## Interpreting the result

- `ebay-sold` + sold-listing `sourceUrls`: the egress seam, parser, relevance
  filter, and provider selection worked for that item at that time.
- `egress-blocked`: the request failed or timed out. The normal application router
  continues to lower tiers.
- `no-usable-sold-comps`: a page was fetched, but fewer than the required relevant,
  fresh sold comps survived parsing/filtering. The router continues rather than
  manufacturing confidence.
- `disabled`: `EBAY_SOLD_ENABLED=false|0|off`; no request was made.

The smoke does not change production pricing behavior. Normal application pricing
still wires the existing TTL cache, staleness cutoff, recency/age-decay weighting,
confidence composite, and full provider order through `createDefaultPricer`.
