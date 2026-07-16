# Sold-comps provider benchmark — Issue #188

Run: `issue188-20260716T190054137Z` · 2026-07-16T19:00:54.137Z

- Harness status: complete
- Live benchmark status: incomplete
- Recommendation status: `operator-pending`
- Candidate: Caffein Actor `oTtB3VgfuE9GtxQt2` pinned to build `1.18.3` (`x9YHX1iN97Vs1N8nN`)
- Corpus: 40 fixed public-product queries, capped at 25 rows/query
- Apify safety: absolute $5.00 ceiling plus per-run platform caps

## Measured results

| Provider | Coverage | Empty | Block/error | Relevant precision | Variant contamination | Condition contamination | Usable pricing queries | p50 / p95 latency | Retries | Spend |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ScrapingBee public page | 0.0% | 7.5% | 92.5% | operator-pending | operator-pending | operator-pending | 0/40 | 8002 / 8005 ms | 0 | $0.0000 + 380 credits |
| Caffein Apify | 95.0% | 5.0% | 0.0% | operator-pending | operator-pending | operator-pending | 20/40 | 19743 / 43477 ms | 0 | $3.6574 |

Cross-provider comparable queries: 0; median price delta: operator-pending; median range overlap: operator-pending.

Median stability is the deterministic odd/even split-median delta; range stability is the observed range width divided by the median. These are reported per provider and never substitute for human relevance labels.

## Best Offer handling

The public eBay page does not disclose the accepted offer amount. The displayed value is an asking price, not the accepted transaction amount. The existing parser excludes Best Offer Accepted cards before pricing. The Apify adapter preserves the row only for audit, labels its displayed value as `asking-price-not-accepted-amount`, and excludes it from every median, range, precision-backed usable count, and recommendation calculation.

## Cost and crossover

- ScrapingBee fixed reference: $49/month for 250,000 included credits on the lowest public plan. Marginal cash cost stays $0 while included credits remain; `SPB-cost` is exact when a response arrives and the isolated account-usage delta is authoritative when the client aborts.
- ScrapingBee credit evidence: 380 account-delta credits; 30 response-header credits; 350 charged credits intentionally left unassigned to individual timed-out queries.
- ScrapingBee allocated reference cost in this run: $0.0745. This is allocation math, not an additional charge.
- ScrapingBee public page marginal result: $0.0000/query and operator-pending/usable pricing query; 9.50 credits/query and operator-pending credits/usable pricing query.
- Caffein Apify marginal result: $0.0914/query and $0.1829/usable pricing query.
- Apify live public price snapshot: up to $0.0040/result plus $0.00005 per GB-start event, observed 2026-07-16T19:00:54.137Z.
- Fixed-cost crossover model: ~490 queries/month at the 25-result Apify upper bound versus the $49 ScrapingBee subscription. If ScrapingBee is already paid for other traffic, its marginal crossover does not occur until included credits are exhausted.

Sources: [Caffein Actor](https://apify.com/caffein.dev/ebay-sold-listings), [Apify maximum run charge](https://docs.apify.com/api/v2/act-run-sync-get-dataset-items-get), [ScrapingBee pricing](https://www.scrapingbee.com/pricing/), [ScrapingBee credit costs](https://help.scrapingbee.com/en/article/credit-system-explained-1h2ackp/).

## Maintainability and provider risk

### ScrapingBee public page

- Schema/parser burden: Two in-repo Cheerio selector layouts plus relevance/filter fixtures; markup drift is SnapList-owned.
- Block/retry behavior: One proxy-backed request/query; provider retries internally, SnapList declines on block/thin HTML.
- Lock-in: Low adapter lock-in: vendor-neutral URL template and in-repo parser, with higher parser maintenance.

### Caffein Apify

- Schema/parser burden: Structured Actor schema mapping; eBay markup maintenance is delegated to a community Actor.
- Block/retry behavior: Actor run status is explicit; internal crawl retries are provider-controlled and opaque to SnapList.
- Lock-in: Moderate Actor/API and pay-per-result lock-in; adapter remains replaceable and output is normalized.

## Product Research reference

Status: operator-pending for exact query IDs Q01, Q05, Q09, Q11, Q14, Q24, Q28. The checked-in template requires only manually transcribed aggregate count/median/range; no authenticated response or seller data is collected.

## Recommendation

**operator-pending.** A primary/fallback/reject decision requires both 40-query live runs, human comp labels, and the manual Product Research aggregate subset.

A production follow-up, if later approved, must preserve the provider-neutral adapter, existing TTL cache and freshness decay, a global budget counter, per-run cost caps, an environment kill switch, graceful fallback, and redacted diagnostics. This evaluation does not change production routing.

## Live-access limitations

- Human comp labels remain operator-pending; heuristic suggestions are not treated as human review.
- Product Research aggregate remains operator-pending.
- Apify MCP did not expose usageTotalUsd; $3.6574 is calculated from observed billable dataset items at the verified Free-tier event price plus seven 4 GB starts.
- Product Research aggregate remains operator-pending.
