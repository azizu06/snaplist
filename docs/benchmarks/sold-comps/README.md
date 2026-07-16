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
- eBay Product Research is manual aggregate reference only. The harness never
  logs in to, reads, automates, or extracts Seller Hub.

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
- `*.labels.json` — heuristic label suggestions for human review.

After a human reviews every private row, edits the labels, and sets
`reviewedByHuman: true`, rescore without provider calls:

```bash
pnpm benchmark:sold-comps -- \
  --from-capture /private/tmp/snaplist-issue188-....capture.json \
  --labels /private/tmp/snaplist-issue188-....labels.json
```

The heuristic suggestion is only a queueing aid. Relevance precision and
variant/condition contamination remain `operator-pending` until the file is
explicitly human-confirmed.

## Manual Product Research subset

Use [product-research.template.json](./product-research.template.json) only as a
manual transcription sheet. In eBay Product Research, paste each exact query,
set the same 90-day window and used/new target shown in the template, and record
only aggregate result count, median, and range. Do not copy seller names, listing
rows, item IDs, URLs, screenshots, cookies, or raw responses.

After all rows are reviewed, set `reviewedByHuman: true` and pass the local copy:

```bash
pnpm benchmark:sold-comps -- \
  --from-capture /private/tmp/snaplist-issue188-....capture.json \
  --labels /private/tmp/snaplist-issue188-....labels.json \
  --product-research /path/to/product-research.reviewed.json
```

Until this manual step and both 40-query provider runs are complete, the report
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
enter a median, range, usable-comp count, or recommendation score.

## Adoption controls

Any later production migration is a separate issue. It must keep the existing
provider interface and router, TTL cache plus freshness decay, global request
budget, per-run Apify cap, environment kill switch, bounded concurrency,
graceful fallback, and credential-safe diagnostics. Accuracy and seller trust,
not the cheapest raw request, determine primary/fallback/reject.
