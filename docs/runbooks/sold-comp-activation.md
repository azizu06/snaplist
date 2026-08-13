# Runbook — activating a sold-comp source in production

Issue #715. Audience: the operator who controls deployment environment variables.

SnapList's `ebay-sold` tier is one pricing tier served by two ordered retrieval
strategies. Neither fires in production today, so every recommended price is
derived from *asking* comps. This runbook is how to arm one or both, how to tell
whether it worked, and how to back it out.

Activation is deliberately operator-controlled: ADR-0001 keeps production
activation a config, cost, and quality decision rather than a code default. This
runbook does not authorize the spend; it documents how to execute a decision that
has already been made.

Related: [ADR-0001](../adr/0001-ebay-public-sold-comps-pricing.md),
[sold-comps egress](../sold-comps-egress.md), `.env.example` (the annotated
source of truth for every variable named below).

---

## The two paths

| | Path A — Apify adapter | Path B — public-page proxy |
|---|---|---|
| Strategy name | `apify-sold` | `ebay-sold-public-page` |
| Order in the tier | first | second |
| Costs money | yes, pay-per-result | depends on the proxy vendor |
| Blocked today because | `APIFY_SOLD_ENABLED` / `APIFY_TOKEN` unset | eBay 403s the direct hosted fetch, no proxy configured |

They are independent. Arming both gives Apify first refusal and leaves the public
page as the fallback; arming neither leaves the tier declining, which is a
supported state (the run still completes an editable draft).

---

## Path A — activate the Apify adapter

### Required environment variables

| Variable | Value | Why |
|---|---|---|
| `APIFY_SOLD_ENABLED` | `true` (also accepts `1`, `on`) | The explicit activation flag. Default-off. |
| `APIFY_TOKEN` | the Apify account token | Server-side only. Never enters a URL, cache key, diagnostic, or result. |
| `UPSTASH_REDIS_REST_URL` | Upstash REST URL | **Required.** See the cost fence below. |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash REST token | **Required.** See the cost fence below. |

`apifySoldConfigured` requires the flag *and* a non-empty token. Either one alone
leaves the adapter disarmed.

**The cost fence is a third precondition, and it is easy to miss.** Before it
starts a paid Actor run, the adapter requires a cache whose scope is `shared` and
that exposes an atomic `claim` — that is the mutual exclusion which stops several
serverless instances from each starting (and paying for) the same run.
`getTtlCache` only returns a shared cache when both Upstash variables are set;
otherwise it returns a per-instance in-memory map. With the flag and token set but
Upstash missing, **Apify is armed and still never calls the Actor**, and the run
looks like this in the logs:

```
{"event":"pricing.apify_sold.cost_fence_unavailable","reason":"shared-cache-required"}
```

### Optional knobs

All optional, all documented in `.env.example`. Each may only *tighten* its
in-code ceiling — a larger value is clamped down, so these cannot be used to raise
the spend ceiling:

`APIFY_SOLD_ACTOR_BUILD` (default `1.18.3`), `APIFY_SOLD_DAYS_TO_SCRAPE` (90, max
180), `APIFY_SOLD_TIMEOUT_SECS` (55), `APIFY_SOLD_WAIT_SECS` (60),
`APIFY_SOLD_REQUEST_RETRIES` (2), `APIFY_SOLD_MAX_TOTAL_CHARGE_USD` (0.11),
`APIFY_SOLD_CLAIM_AUTHORITY_WINDOW_MS` (15000).

The build is **pinned**, not `latest`. Changing `APIFY_SOLD_ACTOR_BUILD` points
production at an Actor build whose output schema has not been checked against the
in-repo normalizer.

---

## Path B — configure a validated proxy template

### Required environment variable

| Variable | Value |
|---|---|
| `EBAY_SOLD_PROXY_TEMPLATE` | absolute HTTPS URL containing exactly one `{url}` placeholder |

Example shape (not a working endpoint): `https://proxy.example/fetch?key=…&url={url}`

The real template usually embeds a vendor credential, so it belongs in deploy
secrets only — never in `.env.example`, a PR, or a log line.

### What validation actually does

A configured template is validated and used. Specifically:

- The template is rejected unless it is absolute, HTTPS, carries exactly one
  `{url}` placeholder before any fragment, and embeds no URL userinfo.
- The eBay target itself is SSRF-validated (https, no userinfo, host must be
  `ebay.com`/`*.ebay.com`, no IP literals or internal hosts) *before* it is
  encoded into the template.
- On the proxy path redirects are followed (proxies often 30x to the rendered
  page); on the direct path a redirect is treated as blocked.
- Validation errors never echo the configured template, so a bad value cannot
  leak a credential into logs.

### Malformed config fails FAST, not soft — read this before editing the value

This is the operational trap in Path B. A blocked or thin *fetch* declines and
falls through to the next tier. A malformed *template* does not: it throws while
the provider is being constructed, before any egress. Because
`createEbaySoldPricingProvider` is built by `createDefaultPricer`, which is the
composition root for all six pricing tiers, a typo in this variable does not
degrade the sold tier — **it fails pricing construction for every run**.

That is ADR-0001 decision 2 working as designed (invalid operator config must not
silently become a direct fetch). Treat it as: validate the template before you
deploy it, and roll it back immediately if pricing starts failing wholesale.

The two halves of that contract are pinned by
`createDefaultPricer public sold-comp proxy egress` in
`src/lib/pricing/default-pricer.test.ts`.

---

## Precedence the ordered provider applies

`createOrderedSoldProvider` (`src/lib/pricing/default-pricer.ts`) serves the one
`ebay-sold` tier from an ordered list, first usable result wins:

1. `apify-sold`
2. `ebay-sold-public-page`

Rules that follow from that:

- **Order is fixed in code.** Environment variables decide whether a strategy is
  armed, never where it sits.
- **A strategy that cannot handle the run is skipped, and the skip is logged.**
  `pricing.sold_comps.strategy_skipped` names the strategy and a reason:
  `unconfigured` (activation flag or token missing — operator-actionable) or
  `signal-not-identifiable` (this item had nothing to search on).
- **Apify winning means the public page is never fetched.** On an Apify success
  the loop returns before the second strategy runs.
- **Every failure is fail-soft to the seller.** If both strategies decline, the
  tier declines, the router falls through to the web-search tiers, and the run
  still produces an editable draft with `Starting price estimate` and
  `No verified sold matches found.` Activation does not change that path.
- **The whole tier sits below `isbn-lookup` and above the web tiers.** Unchanged
  by this runbook.

---

## Verifying activation worked

### The acceptance signal — `prediction_logs`

Read **`prediction_logs.tier_fired`**. It is `'ebay-sold'` when the sold tier
served the run. Confirm alongside it that **`prediction_logs.sources`** contains
at least one entry with `kind: "sold-comp"` — `tier_fired` alone says which tier
answered, `sources` is what proves the answer was sold-grounded.

Before activation, every row is `llm-only` or `branded-web` with no `sold-comp`
source. That is the baseline to compare against.

### What `prediction_logs` cannot tell you

`tier_fired` does **not** distinguish which strategy served the tier — Apify and
the public page both report `ebay-sold`. To attribute a run to Apify
specifically, use either:

- **`pipeline_run_provider_usage`** — `sold_comps[].strategy` is `'apify'` for an
  Actor-served run, with `attempts`, `results`, and `chargedUsd` alongside it, and
  `sold_comp_charged_usd` aggregated on the row. A null charge means the strategy
  reported none, which is deliberately distinct from zero.
- **Runtime log events** — the absence of
  `pricing.sold_comps.strategy_skipped {strategy: "apify-sold"}` plus the presence
  of `pricing.apify_sold.*` events for the run.

### Reading the failure modes

| Log event | Means |
|---|---|
| `pricing.sold_comps.strategy_skipped` · `reason: unconfigured` | Flag or token missing/misspelled. Path A is not armed. |
| `pricing.apify_sold.cost_fence_unavailable` · `shared-cache-required` | Flag and token set, Upstash not. No Actor run will ever start. |
| `pricing.apify_sold.circuit_open` | Consecutive Actor failures tripped the breaker; it retries after the cooldown. |
| `pricing.apify_sold.actor_failed` | The Actor run itself failed; bounded reason only. |
| `pricing.ebay_sold.fetch_blocked` · `viaProxy: false` | Path B direct fetch refused — this is today's production state. |
| `pricing.ebay_sold.fetch_blocked` · `viaProxy: true` | The proxy was used and still failed. Vendor-side problem, not config. |
| `pricing.ebay_sold.declined_thin` | Retrieval worked; too few comps survived the matcher. Not an activation failure. |

---

## Rollback

Both paths roll back by environment variable only. No code change, no migration,
no data cleanup.

**Path A.** Set `APIFY_SOLD_ENABLED=false` (or remove it). The adapter disarms,
the ordered provider logs `strategy_skipped / unconfigured`, and
`ebay-sold-public-page` serves the tier. Clearing `APIFY_TOKEN` has the same
effect. Removing the Upstash variables also stops Apify, but it disables the
shared sold-comp cache for the public path too — prefer the flag.

**Path B.** Remove `EBAY_SOLD_PROXY_TEMPLATE` (or set it blank). Blank is an
explicitly supported value meaning "direct fetch", not an error. Do this first if
pricing begins failing at construction after a template edit.

**Full retreat.** With both rolled back, the tier declines and the router falls
through exactly as it does today. Seller-facing behavior is unchanged and no
draft is lost.

Environment changes take effect on the next deployment/instance start; a running
instance keeps the values it booted with.

---

## Cost note (ADR-0001 operator-controlled activation gate)

**Basis.** The read-only Apify audit of 2026-08-11 (`/tmp/715-apify-audit.md`),
which used public Apify sources — the Actor's pricing page, its input/output
schema, and the Get Actor / Get Actor Build API contracts. No Actor was run and no
account was charged to produce these figures. The per-run request shape and the
expansion policy were re-verified against `src/lib/pricing/providers/apify-sold.ts`
in this branch.

### Path A — Apify, per priced item

Pay-per-event on the Free tier: $0.004 per result, plus $0.00005 per Actor-start
event, one such event per GB of Actor memory (public default 2 GB, which SnapList
does not override) with a minimum of one.

| Request | Result ceiling | Start ceiling | Per-run ceiling |
|---|---:|---:|---:|
| Initial 10 candidates | $0.04000 | $0.00010 | **$0.04010** |
| Optional 20-candidate expansion | $0.08000 | $0.00010 | **$0.08010** |
| Worst case, both run | $0.12000 | $0.00020 | **$0.12020** |

**Range: $0.04010 – $0.12020 per priced item.** The expansion only runs when fewer
than three canonical matches survive the matcher on the first pass, so the upper
bound applies to hard-to-match items, not to every run.

**The `$0.11` ceiling does not bound the pair.** SnapList passes
`maxTotalChargeUsd: 0.11` on *each* Actor start, and Apify applies that cap **per
run**, not as an aggregate across runs. Both the 10- and 20-result runs sit under
$0.11 individually, so neither is refused — and a two-run logical pass can
therefore total **$0.12020**, above the number the constant appears to promise.
Budget against $0.12020 per item, not $0.11.

### Account state

As reported by the audit (from a separately obtained authenticated read-only
receipt, not re-verified here): Free plan, $3.66 of $5.00 consumed, **no payment
method attached** — roughly $1.34 of free credit, about eleven worst-case runs.

Two consequences for the activation decision:

- Activation **does not require attaching a payment method today.** The remaining
  free credit covers a bounded canary.
- **When the free credit is exhausted with no payment method attached, Apify runs
  stop rather than silently billing.** The adapter treats that as an Actor
  failure: it declines, the circuit breaker opens after repeated failures, and
  `ebay-sold-public-page` serves the tier. Sellers still get a draft; SnapList
  silently reverts to the pre-activation quality. Watch
  `pricing.apify_sold.actor_failed` for the transition — the credit running out is
  not otherwise announced.

### Path B — proxy

**Not determined.** The template is vendor-neutral and no vendor is selected, so
there is no rate to quote. Whoever selects the proxy provider owns the cost note
for it. What *is* known: SnapList issues at most two page fetches per priced item
(the 10- and 20-result pages), so the per-item cost is two proxied requests times
the vendor's rate.

### What I could not determine

- **Expected cost, as opposed to the ceiling.** Pay-per-result means a run that
  returns 4 results costs less than one returning 10. The figures above are upper
  bounds; the real per-item average needs measurement from a canary and is not
  derivable from public pricing.
- **Current account balance and plan.** The $3.66/$5.00 figure is from
  2026-08-11 and can drift. Re-check before relying on the "eleven runs" estimate.
- **Whether pinned build `1.18.3` returns usable hero-domain evidence.** The audit
  proved the current public schema is compatible with the in-repo normalizer and
  that the pinned build exists and succeeded. It did not prove retrieval quality.
  That remains the separately authorized canary.
- **Any proxy vendor rate**, per above.

---

## Security note carried forward from the audit

The audit records that an unauthenticated public Apify build-metadata endpoint
returned a non-empty `ACTOR_DATA_API_TOKEN` value belonging to the Actor. No agent
used, validated, or copied it, and it is not reproduced anywhere in this repo, but
it may persist in that session's logs. That is a potential third-party credential
exposure. Rotation and disclosure are the Actor owner's call and require separate
owner authority; it is recorded here so activation does not proceed as though the
finding never happened.
