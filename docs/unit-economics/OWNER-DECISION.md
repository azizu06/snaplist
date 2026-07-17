# SnapList Pro unit economics — provisional owner decision

**Status:** `PROVISIONAL — NOT A LAUNCH COMMITMENT`

**Evidence date:** 2026-07-17

**Decision owner:** Aziz

**Implementation owners:** #168 defines the ledger; #173 independently owns StoreKit/RevenueCat. This analysis changes neither.

## Recommendation

Carry **$9.99/month, $99.99/year (16.6% cadence discount), and 10 AI items per monthly allowance period** into TestFlight as the single provisional candidate. Annual subscribers receive the same 10-item monthly reset: no annual bucket, rollover, unlimited claim, or second correction credit.

For the monthly product, that allowance period is the server-verified signed StoreKit transaction span. For the annual product, billing is cadence only: the server derives UTC calendar-month-anniversary subperiods inside the signed annual span, anchored to verified `purchaseDate`, capped at verified `expiresDate`, and keyed by `(originalTransactionId, transactionId, subperiodIndex)`. This is an internal credit window, not a fabricated Apple renewal. It cannot advance from client time, a duplicate callback, verified grace, or late/ambiguous entitlement state. #173 owns implementing this contract. See Apple's signed [transaction fields](https://developer.apple.com/documentation/appstoreserverapi/jwstransactiondecodedpayload) and [subscription billing guidance](https://developer.apple.com/documentation/storekit/handling-subscriptions-billing).

Confidence is **medium-low**. The midpoint looks healthy, but the assumed p90 at full allowance is just below the 30% monthly contribution-margin gate and the intentionally adverse stress bound is negative. That makes `$9.99 / $99.99 / 10` a telemetry hypothesis, not production copy, an App Store product, or an authorized provider-plan decision. The previously discussed **$10/month and $30/year are unapproved hypotheses**; $30/year is not supported by this model.

The reproducible inputs live in [`snaplist-pro-model.json`](./snaplist-pro-model.json), generated outputs in [`snaplist-pro-results.json`](./snaplist-pro-results.json), and calculation code in [`calculate.ts`](../../src/lib/unit-economics/calculate.ts). Regenerate and validate with:

```bash
pnpm unit-economics:generate
pnpm unit-economics:check
pnpm vitest run src/lib/unit-economics/calculate.test.ts
```

## What is evidence versus assumption

The only provider cost measured on a representative fixed corpus is the #188 Caffein Apify run: 40 queries, $3.6574 total, **$0.091435/query**, 0 SnapList retries, and 95% retrieval coverage. The current matcher replay produced at least two price anchors for 16/40 queries, with 91.53% anchor precision and 40.91% valid-comparable recall. That evidence is cost input and routing sensitivity—not approval to activate Apify. See the [live benchmark](../benchmarks/sold-comps/latest/REPORT.md) and [matcher replay](../benchmarks/sold-comps/ranking-replay/REPORT.md).

All token counts, stage route shares, cache-hit rates, failure rates, correction rates, free-activation conversion burden, refund/tax rates, and per-attempt infrastructure values are **dated assumption ranges**. The runtime proof is also deliberately separated: its 25-run air-gapped result is an orchestration lower bound, while the provider-inclusive 120-second/10-active-CPU-second/512-MiB envelope is an assumption awaiting device and provider telemetry ([runtime proof](../architecture/mobile-runtime-hosting-proof.md)).

Current public rate cards are linked in the model beside every assumption. In particular, the showcase path uses the repo's GPT-5.5 default at the official [$5/M input, $0.50/M cached input, and $30/M output rates](https://developers.openai.com/api/docs/models/gpt-5.5); the development flip remains Gemini 2.5 Flash at its [current official rates](https://ai.google.dev/gemini-api/docs/pricing). The model does not silently substitute today's Apify card for #188's historical measured spend: the actor now advertises [from $2.50/1,000 results](https://apify.com/caffein.dev/ebay-sold-listings), while this version preserves the actual benchmark cost.

## Successful-listing COGS

These are **direct COGS per durable successful listing**, before allocating the free activation subsidy to a subscriber. The ledger restores a credit when a run fails before durable value, but provider and compute spend are still sunk, so failure burden is included. The one guided correction reruns pricing and grounded listing generation without charging another credit.

| Cost view | Median assumption | P90 assumption | Stress bound |
|---|---:|---:|---:|
| Initial attempt | $0.150 | $0.355 | $1.242 |
| Included correction burden | $0.015 | $0.067 | $0.369 |
| Restored-failure burden | $0.005 | $0.036 | $0.373 |
| **Durable successful listing COGS** | **$0.170** | **$0.458** | **$1.984** |
| Free-activation subsidy per paid subscriber | $0.085 | $0.687 | $7.934 |

The stress case intentionally uses the maximum in-repo retry envelopes, no sold-comp cache hits, 25% pre-value failure, a 50% correction rate, four free activations per paid subscriber, 30% Apple commission, and high token volumes. It is a guardrail, not a predicted percentile.

## Candidate comparison

At midpoint cost assumptions, contribution margin after Apple commission, refunds/tax assumptions, RevenueCat marginal fee, used-listing COGS, and allocated free activation is:

| Candidate | Price / annual | Allowance | Low use | Expected use | High use |
|---|---:|---:|---:|---:|---:|
| Starter | $7.99 / $59.99 | 5 | 95.5% | 91.0% | 85.9% |
| **Balanced** | **$9.99 / $99.99** | **10** | **93.9%** | **86.7%** | **78.5%** |
| Volume | $12.99 / $119.99 | 20 | 91.3% | 80.3% | 67.8% |

For the balanced candidate at expected six-item use:

| Scenario | Monthly gross margin | Monthly contribution margin | Annual contribution margin | Monthly fixed-cost crossover |
|---|---:|---:|---:|---:|
| Median assumptions | 87.7% | 86.7% | 84.1% | 2 subscribers |
| P90 assumptions | 63.3% | 54.2% | 45.1% | 15 subscribers |
| Stress bound | -123.8% | -273.9% | -348.3% | No crossover |

“Gross margin” deducts the direct COGS of paid allowance use after store/refund/tax/RevenueCat deductions. “Contribution margin” additionally allocates the free activation subsidy. Fixed platform costs are excluded from both and shown through the crossover count. At p90 high use, the provisional candidate reaches **29.8% monthly** and **15.8% annual** contribution margin, so it does not yet clear the 30% gate.

## Sensitivity and breakpoints

Against the balanced expected-use midpoint (86.7% monthly contribution margin):

| One-variable change | COGS change / subscriber-month | Margin change |
|---|---:|---:|
| Sold-comp cache hit 35% → 0% | +$0.160 | -1.9 pp |
| Failed runs 5% → 15% | +$0.079 | -0.9 pp |
| Included corrections 15% → 50% | +$0.223 | -2.7 pp |
| Free activations per paid subscriber 0.5 → 2.0 | +$0.255 | -3.1 pp |
| Refunds 2% → 10% | $0.000 COGS; lower proceeds | -1.2 pp |

The current plan breakpoints are transparent, not automatic upgrades:

- ScrapingBee's [$49/month plan](https://www.scrapingbee.com/pricing/) equals about **536 #188-cost Apify queries**, or **215 matcher-usable listing equivalents** at the replay's 40% coverage. #188 observed 92.5% ScrapingBee block/error and zero usable pricing queries, so this is only arithmetic—not a route recommendation.
- [RevenueCat](https://www.revenuecat.com/pricing) is free through $2,500 monthly tracked revenue, then 1%; p90/stress already include the 1% marginal rate.
- [PostHog](https://posthog.com/pricing) includes 1M product-analytics events; at the explicit 25-events/listing assumption, that is about 40,000 listings. Session replay is unnecessary for this decision.
- [Supabase Pro](https://supabase.com/pricing) starts at $25/month. The model treats Supabase, hosting, observability, auth, Redis, email, and analytics as fixed/step-variable breakpoints rather than burying them in an invented per-listing rate. The full inventory and official links are in the machine model.
- Apple membership is [$99/year](https://developer.apple.com/programs/whats-included/). The 15% commission case requires eligibility and enrollment in the [Small Business Program](https://developer.apple.com/news/?id=i7jzeefs); the stress case uses 30%. Refund and tax-withheld assumptions must be replaced by actual proceeds evidence.

## Minimal TestFlight telemetry

Use three sources of truth, joined by opaque `run_id`, `item_id`, entitlement period, and a non-PII cohort identifier:

1. **Server ledger/provider metering — cost and durable truth**
   - reservation created, settled, or restored; reason and timestamps;
   - pipeline stage start/end, attempt number, outcome, provider role/model, input/cached/output tokens, provider request ID, and billed cost when exposed;
   - photo count/bytes (not image contents), garment-measurement invocation, pricing route, web-search requests/credits, sold-comp attempted/cache-hit/provider/result count/anchor count, listing retry, terminal failure stage, queue deliveries, storage bytes, and egress bytes;
   - first-free versus paid allowance, unchanged photo fingerprint, correction started/completed, and durable-value timestamp.
2. **PostHog — behavior denominators only**
   - guest run started, durable draft viewed, correction opened/completed, paywall viewed, trial/purchase flow started, and publish intent;
   - do not send photos, listing text, raw model prompts, seller identifiers, or provider credentials.
3. **RevenueCat/App Store — proceeds truth**
   - product/cadence, signed purchase/renewal/refund date, verified entitlement span, derived allowance-period identity (including annual subperiod index), grace/expiry, storefront/currency, gross proceeds, commission/tax/refund deductions when available, and MTR tier;
   - #173 owns the bridge. This report defines required economics fields but implements no SDK, product, webhook, or account change.

## Launch-commitment gate

Do not convert the provisional candidate into a launch price until one representative TestFlight window has:

- at least **100 durable successful listings**, **30 distinct testers**, **28 days**, and **20 guided corrections**;
- server-reconciled provider cost for every stage plus complete settled/restored ledger outcomes;
- p50 and p90 successful-listing COGS with the p90 stable within **±15%** over two consecutive weekly cuts;
- measured cache hit, failure, retry, correction, free-to-paid activation, allowance utilization, refund, commission/tax, and RevenueCat fee rates;
- at least **60% expected-use contribution margin**, **30% p90 high-use contribution margin on both cadences**, and non-negative monthly and annual stress results after replacing assumed extremes with defensible observed bounds.

The current model passes only the expected-use midpoint margin check. It fails the p90 high-use and stress gates and lacks the required sample, so the decision remains `PROVISIONAL — NOT A LAUNCH COMMITMENT`.
