# Sold-comps provider benchmark — Issue #188

Run: `issue188-20260716T190054137Z` · 2026-07-16T19:00:54.137Z

- Harness status: complete
- Live benchmark status: complete
- Recommendation status: `reject-apify`
- Comp review: complete (codex-agent-assisted; 914 rows)
- Candidate: Caffein Actor `oTtB3VgfuE9GtxQt2` pinned to build `1.18.3` (`x9YHX1iN97Vs1N8nN`)
- Corpus: 40 fixed public-product queries, capped at 25 rows/query
- Apify safety: absolute $5.00 ceiling plus per-run platform caps

## Measured results

| Provider | Coverage | Empty | Block/error | Relevant precision | Variant contamination | Condition contamination | Usable pricing queries | p50 / p95 latency | Retries | Spend |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ScrapingBee public page | 0.0% | 7.5% | 92.5% | not measurable | not measurable | not measurable | 0/40 | 8002 / 8005 ms | 0 | $0.0000 + 380 credits |
| Caffein Apify | 95.0% | 5.0% | 0.0% | 82.4% | 37.5% | 38.0% | 18/40 | 19743 / 43477 ms | 0 | $3.6574 |

Cross-provider comparable queries: 0; median price delta: not measurable; median range overlap: not measurable.

Median stability is the deterministic odd/even split-median delta; range stability is the observed range width divided by the median. These provider metrics never substitute for the attributed relevance review.

## Best Offer handling

The public eBay page does not disclose the accepted offer amount. The displayed value is an asking price, not the accepted transaction amount. The existing parser excludes Best Offer Accepted cards before pricing. The Apify adapter preserves the row only for audit, labels its displayed value as `asking-price-not-accepted-amount`, and excludes it from every average, median, range, precision-backed usable count, and recommendation calculation.

## Cost and crossover

- ScrapingBee fixed reference: $49/month for 250,000 included credits on the lowest public plan. Marginal cash cost stays $0 while included credits remain; `SPB-cost` is exact when a response arrives and the isolated account-usage delta is authoritative when the client aborts.
- ScrapingBee credit evidence: 380 account-delta credits; 30 response-header credits; 350 charged credits intentionally left unassigned to individual timed-out queries.
- ScrapingBee allocated reference cost in this run: $0.0745. This is allocation math, not an additional charge.
- ScrapingBee public page marginal result: $0.0000/query, not measurable/usable comp, and not measurable/usable pricing query; 9.50 credits/query and not measurable credits/usable pricing query.
- Caffein Apify marginal result: $0.0914/query, $0.0310/usable comp, and $0.2032/usable pricing query.
- Apify live public price snapshot: up to $0.0040/result plus $0.00005 per GB-start event, observed 2026-07-16T19:00:54.137Z.
- Fixed-cost crossover model: ~242 queries/month at the observed Apify cost per usable pricing query versus the $49 ScrapingBee subscription. If ScrapingBee is already paid for other traffic, its marginal crossover does not occur until included credits are exhausted.

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

Operator-authorized Codex browser capture completed for: Q01, Q05, Q09, Q11, Q14, Q24, Q28. The redacted result retains 7 summary rows with average sold price, sold-price range, sell-through, and total sellers. It is not marked as human-reviewed by Aziz, and no listing-level Seller Hub evidence was persisted.

| Provider | Comparable summary queries | Median absolute average delta | Median range overlap |
|---|---:|---:|---:|
| ScrapingBee public page | 0 | not measurable | not measurable |
| Caffein Apify | 4 | 8.2% | 12.8% |

## Recommendation

**reject-apify.** Apify eliminated the observed block failures, but fewer than five Product Research queries produced comparable usable evidence and variant/condition contamination exceeded the 25% primary-quality limits; reject the candidate rather than add a second paid provider.

A production follow-up, if later approved, must preserve the provider-neutral adapter, existing TTL cache and freshness decay, a global budget counter, per-run cost caps, an environment kill switch, graceful fallback, and redacted diagnostics. This evaluation does not change production routing.

## Live-access limitations

- Apify MCP did not expose usageTotalUsd; $3.6574 is calculated from observed billable dataset items at the verified Free-tier event price plus seven 4 GB starts.
