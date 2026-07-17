# Apify sold-comp implementation readiness — Issue #200

This report reconciles the completed Issue #188 live retrieval benchmark with
the Issue #198 provider-neutral matcher replay and the Issue #200 zero-network
adapter contract. It does not activate production or authorize another paid run.

## Evidence summary

| Measure | Result | Evidence boundary |
|---|---:|---|
| Retrieval success | 38/40 (95.0%) | Completed Caffein Actor run from #188 |
| Retrieved rows | 914 | Private rows; aggregate only in Git |
| Block/error rate | 0.0% | Completed Caffein Actor run from #188 |
| Retrieval relevant precision | 82.39% | Agent-attributed private review |
| Matcher anchor precision | 91.53% (108/118) | Offline replay from #198; 0 provider calls |
| Valid-comp recall into anchors | 40.91% (108/264) | Offline replay from #198; 0 provider calls |
| Two-anchor coverage | 16/40 (40.0%) | Offline replay from #198; 0 provider calls |
| Product Research comparable queries | 4/7 | Aggregate-only reference replay |
| Median suggested-price error | 7.06% | Matcher suggestion vs Product Research average; 4 queries |
| Median range overlap | 12.64% | Matcher range vs Product Research range; 4 queries |
| Retrieval latency | p50 19.743s / p95 43.477s | Completed Caffein Actor run from #188 |
| Live SnapList retries | 0 | Completed Caffein Actor run from #188 |
| Historical benchmark spend | $3.6574 | Completed #188 run under the $5 ceiling |
| Cost / retrieved query | $0.0914 | $3.6574 / 40 |
| Cost / production-usable anchor | $0.0310 | $3.6574 / 118 |
| Cost / binary-usable pricing query | $0.2032 | Historical #188 interpretation: $3.6574 / 18 |
| Cost / matcher-usable listing | **$0.2286** | Current interpretation: $3.6574 / 16 |
| Issue #200 provider calls / spend | **0 / $0.0000** | Offline replay and synthetic contract only |

The seven optional eBay Product Research aggregates produced only four
matcher-usable comparisons. The current offline matcher replay has 7.06% median
absolute suggested-price error against the reference average and 12.64% median
range overlap. Product Research provides an aggregate average/range rather than
a listing-level gold price or median, and four queries are too few for a field
accuracy claim. The aggregate-only replay is recorded in
[private-replay-summary.json](./private-replay-summary.json); private rows remain
outside Git.

## Balanced-condition contract

`pnpm benchmark:apify-readiness` evaluates equal synthetic coverage for new,
open-box, like-new, refurbished, used-good, used-fair, and parts inventory. Each
condition has two valid anchors, one corroboration row, one matcher reject, and
one normalization reject. The aggregate result is 100% expected-outcome
accuracy, 100% anchor precision, 100% valid-comp recall, and 7/7 two-anchor
coverage. These are deterministic contract results, not live quality estimates;
see [CONTRACT.md](./CONTRACT.md) and [contract-results.json](./contract-results.json).

## Runtime safety and cache effect

- The adapter is inert unless both `APIFY_SOLD_ENABLED=true` and a server-side
  `APIFY_TOKEN` are present. Production remains off.
- The evaluated Actor defaults to `oTtB3VgfuE9GtxQt2`, build `1.18.3`; Actor rows
  are reduced to URL, title, USD sold price, condition, sold date, and Best Offer
  disclosure before entering the provider-neutral matcher.
- One run is capped at 25 rows, $0.11, 55 seconds of Actor runtime, 60 seconds of
  client wait, and two official-client post-run read retries. The paid Actor-start
  request has zero retries; SnapList never automatically relaunches a failed paid
  Actor run. `restartOnError` is false.
- Three consecutive failures open the default 60-second circuit. Actor, dataset,
  cache, timeout, and thin-evidence outcomes all decline into the public sold
  provider and then the existing web/depreciation/LLM fallbacks.
- Deterministic cache tests show two sequential identical pricing requests cause
  one Actor invocation (50% invocation avoidance), including successful empty
  results; two concurrent request-scoped providers sharing the same production
  cache object in one runtime are also coalesced into one run. Cross-runtime
  distributed coalescing remains part of the shared-cache activation gate. This is
  a zero-network behavior proof, not a claim about observed production hit rate.
- Cache reads never bypass staleness filtering or recency/age-decay. Cache outages
  are fail-open and diagnostics contain bounded reasons only.

## Activation gate

Caffein Apify is the leading automatic sold-comp retrieval candidate, but the
adapter must remain default-off. Before production activation, the owner must
approve a separate provider budget and validate the current Actor build/schema,
current price, credential placement, shared-cache deployment, and a new balanced
live sample. Apify MCP was unavailable during Issue #200, so no live call was
attempted and no token was requested or exposed. Authenticated eBay Product
Research scraping remains prohibited and optional aggregate reference cannot
substitute for the activation sample.
