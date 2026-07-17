# Sold-comps provider benchmark (Issue #188)

This harness compares the current ScrapingBee-backed public eBay sold-page
provider with the exact Caffein Dev Apify Actor
`caffein.dev/ebay-sold-listings` (`oTtB3VgfuE9GtxQt2`). It is evaluation-only:
production provider routing, credentials, caches, schedules, and deployment are
unchanged.

## Safety contract

- `pnpm benchmark:sold-comps` is the bare command. It makes zero external
  requests, spends $0, and prints the fixed plan.
- Live mode requires both `--live` and `--confirm-live`.
- The corpus is fixed at 40 public-product queries and both provider adapters are
  capped at 25 rows/query.
- A live Apify run re-reads the Actor's public price metadata, uses the highest
  current account-tier result price for preflight, pins the run to the recorded
  public `latest` build number, and assigns a
  `maxTotalChargeUsd` platform cap to every Actor run. The sum of those caps must
  be at most the user-supplied cap and can never exceed the absolute $5 issue
  ceiling.
- Both provider credentials are validated before the first paid call when
  `--provider both` is selected. Missing access stops the run without partial
  spending.
- The Apify token is sent only in an `Authorization: Bearer` header. It is never
  placed in a URL, capture, report, or console record.
- Raw HTML/API responses, source URLs, item IDs, seller usernames/feedback,
  images, cookies, and credentials are never persisted. The operator-local
  review capture retains only title, displayed price, condition, date, provider,
  query ID, and a hashed comp ID; it is written mode `0600` under the OS temp
  directory.
- eBay Product Research is aggregate reference only. The harness never logs in
  to or automates Seller Hub; it can ingest a local operator-authorized capture
  containing only the declared summary fields.

## Commands

Dry-run (zero requests):

```bash
pnpm benchmark:sold-comps
```

Full live comparison (requires existing authorized local values for
`EBAY_SOLD_PROXY_TEMPLATE` and `APIFY_TOKEN`):

```bash
pnpm benchmark:sold-comps -- \
  --live \
  --confirm-live \
  --provider both \
  --max-apify-usd 5
```

An explicitly partial provider run is supported for access diagnosis and
evidence collection. It cannot produce a primary/fallback/reject decision:

```bash
pnpm benchmark:sold-comps -- \
  --live \
  --confirm-live \
  --provider scrapingbee
```

Live output is written to `docs/benchmarks/sold-comps/latest/` by default:

- `results.json` — redacted machine-readable metrics and recommendation state;
- `REPORT.md` — concise human report with coverage, precision/contamination,
  usable counts, median/range stability, Best Offer handling, latency,
  retry/block behavior, maintainability, cost, crossover, and controls.

The command also prints two private temp paths:

- `*.capture.json` — normalized title/price/condition rows, no seller/source/raw
  data;
- `*.labels.json` — heuristic queueing suggestions for attributed human or
  agent-assisted review.

After every private row is reviewed, record truthful provenance as either
`reviewedByHuman: true` or `reviewedByAgent: true` with
`reviewMethod: "codex-agent-assisted"`, then rescore without provider calls:

```bash
pnpm benchmark:sold-comps -- \
  --from-capture /private/tmp/snaplist-issue188-....capture.json \
  --labels /private/tmp/snaplist-issue188-....labels.json
```

The heuristic suggestion is only a queueing aid. Relevance precision and
variant/condition contamination remain `operator-pending` until the file is
fully reviewed and attributed. Agent-assisted review must never be represented
as human review.

## Offline matcher replay

Issue #198 separates provider retrieval from SnapList's own evidence ranking.
Replay the attributed private capture without making any provider requests:

```bash
pnpm benchmark:sold-comp-ranking -- \
  --capture /private/tmp/snaplist-issue188-....capture.json \
  --labels /private/tmp/snaplist-issue188-....labels.json \
  --product-research /private/tmp/snaplist-issue188-product-research.json
```

The command writes aggregate-only output to
`docs/benchmarks/sold-comps/ranking-replay/`. Price anchors are the only rows
allowed into the median, citations, or minimum-two-comp gate; corroboration is
reported separately and cannot silently price an item. The private capture and
labels remain outside the repository.

## Production-adapter readiness replay

Issue #200 adds the default-off Caffein adapter behind `PricingProvider` and a
synthetic balanced-condition contract. Its bare command is always zero-network:

```bash
pnpm benchmark:apify-readiness
```

It writes aggregate-only results under `apify-readiness/` for new, open-box,
like-new, refurbished, used-good, used-fair, and parts inventory. The report also
reconciles the completed #188 live retrieval/cost evidence with the #198 matcher
replay. The synthetic 100% contract metrics prove normalization/ranking behavior;
they are not a replacement for live retrieval precision or an activation signal.
Production remains default-off and another paid Actor run requires owner approval.

## Product Research aggregate subset

Use [product-research.template.json](./product-research.template.json) as the
aggregate-only capture contract. In eBay Product Research, use the Sold tab,
Last 90 days, and the exact condition semantics shown for each query. Record
only average sold price, sold-price range, sell-through, and total sellers.
Product Research does not expose a median in this summary, so the benchmark
compares provider average to Product Research average. Do not copy seller names,
listing rows, item IDs, URLs, screenshots, cookies, or raw responses.

After the seven aggregates are captured with operator authorization, pass the
local copy:

```bash
pnpm benchmark:sold-comps -- \
  --from-capture /private/tmp/snaplist-issue188-....capture.json \
  --labels /private/tmp/snaplist-issue188-....labels.json \
  --product-research /path/to/product-research.reviewed.json
```

Until this aggregate step and both 40-query provider runs are complete, the report
must remain `operator-pending` rather than inventing a recommendation.

## Cost model

- The Actor's live public price is read from the Apify Actor metadata before any
  paid run. On 2026-07-16 the free-tier upper price was $0.004/result, with a
  $0.00005 per-GB Actor-start event. At 1,000 maximum results plus seven 4 GB
  starts, the preflight upper bound was $4.0014.
- ScrapingBee reports exact request credits in the `SPB-cost` response header
  when the response reaches the client. For timed-out requests, the harness
  records the isolated account-usage delta as the run total and leaves the
  difference unattributed at query level. The current public lowest plan is
  $49/month for 250,000 credits; premium non-JavaScript HTML costs 10
  credits/request and premium JavaScript costs 25.
- At the 25-result/free-tier Apify upper bound, the fixed-cost crossover is about
  490 queries/month versus the $49 ScrapingBee subscription. If ScrapingBee is
  already paid for other traffic, its marginal cash cost remains $0 until its
  included credits are exhausted. The live report replaces the upper-bound model
  with observed cost per usable pricing result when both sides are available.

Official references:

- [Caffein Actor and Best Offer contract](https://apify.com/caffein.dev/ebay-sold-listings)
- [Apify maximum run charge](https://docs.apify.com/api/v2/act-run-sync-get-dataset-items-get)
- [ScrapingBee pricing](https://www.scrapingbee.com/pricing/)
- [ScrapingBee request credit costs](https://help.scrapingbee.com/en/article/credit-system-explained-1h2ackp/)
- [ScrapingBee `SPB-cost` usage evidence](https://help.scrapingbee.com/en/article/how-to-monitor-credit-usage-1s4jo0f/)

## Interpreting Best Offer Accepted

The public page shows the asking price for a Best Offer Accepted sale, not the
accepted amount. The existing parser excludes those cards. The Apify adapter
retains the row only for audit with
`asking-price-not-accepted-amount` and `usableForPricing: false`. It can never
enter an average, median, range, usable-comp count, or recommendation score.

## Adoption controls

Any later production migration is a separate issue. It must keep the existing
provider interface and router, TTL cache plus freshness decay, global request
budget, per-run Apify cap, environment kill switch, bounded concurrency,
graceful fallback, and credential-safe diagnostics. Accuracy and seller trust,
not the cheapest raw request, determine primary/fallback/reject.
