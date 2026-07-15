# Spec — Extract the eBay Sold-Comps Scraper into a Go Worker (queue-backed)

> **Status: Superseded historical context.** ADR-0007 and epic #157 ratify a logged Supabase Basic
> Queue for the entire TypeScript listing-preparation pipeline. The former RabbitMQ/Go/EC2 proposal
> and its epic #65 were closed `wontfix`. This document is retained for its useful failure-mode,
> concurrency, idempotency, and observability analysis; it is not an implementation plan or dependency.

> **Historical audience:** the backend agent that would have implemented this. **Former status:** proposed; a few
> decisions (marked **DECIDE**) need Aziz's sign-off before building.
> **This is an architecture/build spec, not an ADR.** When a decision here is
> ratified, fold the durable ones into `docs/adr/`.
> The current app is vendor-neutral and direct-fetches by default; ScrapingBee
> below is a proposed worker choice, not a deployed requirement.

---

## 1. Why this exists (the one-paragraph version)

Today the whole pipeline runs **synchronously** inside the upload server action,
and the slowest, flakiest part of it is the **eBay sold-comps scrape** (network
fetch through direct or optional hosted egress + HTML parse). When a paid proxy
is selected, that step also has a request budget. It is the one piece that
genuinely wants: controlled concurrency (to protect the selected egress budget
and avoid eBay blocks), retries with backoff, and
non-blocking async UX. So we extract **only** that step into a standalone **Go
worker** behind a **RabbitMQ** work queue, deployed on **EC2**, with **Prometheus**
metrics. Everything else stays exactly where it is.

This is also a deliberate resume/showcase piece: "I split the scraping I/O into a
Go microservice behind a durable queue, with controlled concurrency, retries/DLQ,
a shared cache, and metrics." The architecture below is chosen so that story is
**true and defensible**, not cargo-culted.

---

## 2. Scope — what moves, what does NOT

### Moves to the Go worker
The worker owns **eBay sold-comps research only**: given an item signal, build the
sold-search URL, fetch the page through the selected direct or proxy egress, parse it, and
relevance-filter the rows. Its output is **exactly** the `EbaySoldComp[]` that the
existing TypeScript `synthesizeSoldResult()` already consumes.

The seam is literally an existing function input. In
`src/lib/pricing/providers/ebay-sold.ts` the current synchronous flow is:

```
fetchPage(url)            ─┐
parseSoldComps(html)       ├─ becomes the Go worker's job
filterRelevantComps(...)  ─┘
                          ────────────  network boundary  ────────────
synthesizeSoldResult(comps)   ← STAYS in TypeScript, unchanged
  (coreComps / MAD trim, median, range, comp agreement, tier, sources)
```

### Explicitly does NOT move (do **not** build these)
- **No user-photo / S3 image transfer.** The scraper has nothing to do with the
  seller's photos. Those already live in Supabase Storage (S3-compatible, RLS-
  scoped). Moving them to S3 is unrelated work that the original PR conflated;
  cut it. If anyone asks "why not S3 for images" the answer is: wrong problem,
  the scraper isn't an image service.
- **No vision / OpenAI extraction.** Stays in the app (fast-ish, needs the AI SDK).
- **No web-search pricing agent (Tavily/Exa tool-calling loop).** That's an LLM
  agent — keep it in TS where the Vercel AI SDK lives. Porting a tool-calling loop
  to Go is a big lift for no benefit.
- **No pricing synthesis / confidence composite / listing generation.** All tested
  TS logic; the network boundary is drawn precisely so none of it is rewritten.
  Re-implementing the MAD trim + confidence math in Go would duplicate logic and
  invite drift for zero gain.
- **No ISBN lookup, depreciation, or LLM-fallback tiers.** App-side, fast/free.

> **One-line boundary rule:** the worker is a *fetch-and-parse service for one
> source (eBay sold pages)*. If a change would make it know about confidence,
> tiers, listings, photos, or LLMs — it's in the wrong place.

---

## 3. Current state (grounded in the code)

- **Entry seam:** `uploadAndProcess()` in `src/app/(app)/upload/actions.ts` runs
  auth → daily-item quota (`checkDailyItemQuota`) → store photos → `recordPipelineRunAndMaybeAlert`
  → `createVisionPipeline({ supabase })` → `runPipelineAndPersist(...)` → `redirect("/review/:id")`.
  **The user waits for the entire run, scrape included, before the redirect.**
- **Scraper:** `createDefaultFetchPage()` in `ebay-sold.ts` direct-fetches by
  default. Optional `EBAY_SOLD_PROXY_TEMPLATE` routes the validated eBay target
  through operator-selected hosted egress; malformed templates fail before any
  request. Parser: `parseSoldComps` (cheerio) → `filterRelevantComps`.
- **Cache:** `src/lib/pricing/comp-cache.ts` — a dual-backend TTL cache
  (`createInMemoryTtlCache` default / `createUpstashTtlCache` when `UPSTASH_REDIS_REST_*`
  is set). **This dual-backend pattern is the template for the transport** (see §5).
- **Budget/abuse:** `src/lib/abuse` — per-user daily item quota + global OpenAI
  call budget. If ScrapingBee is selected for the proposed worker, its credit
  budget is implicit until the worker makes it an explicit, enforced gate (§7).
- **Realtime:** Supabase Realtime is already in the stack (PRD: buyer-message
  inbox). We reuse it to push the async price result to the review page (§6).

---

## 4. Target architecture

```
┌─────────────────────────────── Vercel (Next.js app) ───────────────────────────────┐
│ upload action                                                                       │
│   vision (sync, OpenAI) ──▶ ItemSignal                                              │
│   ISBN fast-path? ──yes──▶ finish sync (no scrape)                                  │
│   else: persist item as `pricing_pending`, publish ScrapeJob, redirect to /review  │
│   /review subscribes via Supabase Realtime ──────────────┐                          │
│   /api/pricing/finalize  ◀── worker callback ── runs synthesizeSoldResult + listing │
└───────────────┬─────────────────────────────────────────┴──────────────────────────┘
                │ publish ScrapeJob (RabbitMQ work queue)        ▲ result
                ▼                                                │
┌──────────────────────────── EC2 ────────────────────────────┐ │
│ RabbitMQ  ──▶  Go worker pool (N consumers, prefetch=N)      │ │
│                 • Upstash comp-cache check (shared w/ app)   │ │
│                 • optional egress-provider budget guard      │ │
│                 • build URL → fetch (direct/proxy) → parse   │ │
│                 • relevance filter → EbaySoldComp[]          │ │
│                 • retries+backoff; exhausted → DLQ           │ │
│                 • Prometheus /metrics                        │ │
│                 └──── deliver result back to app ───────────┼─┘
└─────────────────────────────────────────────────────────────┘
```

**Asymmetry to respect:** the app is a great RabbitMQ **producer** (publishing is
stateless, fits serverless) but a poor **consumer** (Vercel functions are short-
lived; they can't hold a long-running queue subscription). So inbound is a queue;
the result comes **back** via a worker→app HTTP callback or by the worker writing
Supabase (which Realtime then pushes). See **DECIDE-2**.

---

## 5. Transport: mirror the dual-backend cache pattern (the key non-breaking move)

Do **not** make RabbitMQ a hard dependency of the app or the test suite. Introduce
a `SoldCompsTransport` interface with two backends, exactly like `comp-cache.ts`:

- **`inproc` (default)** — calls the existing TS fetch+parse in-process. This is
  today's behavior. Keeps the **offline test suite, dev, and CI green with no
  broker**, and means the migration ships behind a flag instead of a big-bang cut.
- **`queue`** — publishes a `ScrapeJob` to RabbitMQ and resolves when the worker's
  result arrives. Selected in production via env (e.g. `SOLD_COMPS_TRANSPORT=queue`).

This single decision is what makes the whole thing safe: nothing breaks until you
flip the flag, and you can flip it per-environment.

---

## 6. Message / API contracts

**ScrapeJob (app → worker, RabbitMQ):**
```jsonc
{
  "requestId": "uuid",          // idempotency key (see §7)
  "itemId": "uuid",             // for the result callback + RLS scoping
  "userId": "clerk-user-id",    // RLS scoping on any DB write
  "signal": {                   // exactly the ItemSignal the scraper needs
    "brand": "Sony",
    "model": "WH-1000XM4",
    "category": "electronics",
    "isbn": null,
    "upc": null
  },
  "attempt": 1
}
```

**ScrapeResult (worker → app):** the contract is the existing `EbaySoldComp[]`,
plus envelope metadata — nothing more.
```jsonc
{
  "requestId": "uuid",
  "itemId": "uuid",
  "status": "ok",               // ok | empty | blocked | error
  "comps": [
    { "url": "https://www.ebay.com/itm/...", "price": 168.0,
      "title": "Sony WH-1000XM4 ... Used", "condition": "Pre-Owned" }
  ],
  "meta": { "fetchedAt": "iso8601", "cached": false, "providerUnitsSpent": 1 }
}
```

The app's `/api/pricing/finalize` receives this, hands `comps` straight to
`synthesizeSoldResult()`, runs the rest of the pricing pipeline + listing
generation, writes `items` / `listings` / `prediction_logs`, and the review page
updates via Realtime. **No synthesis code changes** — `comps` is the same shape it
already expects.

---

## 7. Reliability, concurrency, and the credit budget (the real performance story)

- **Controlled concurrency:** worker pool of `N` consumers with `prefetch=N` so at
  most `N` eBay fetches are ever in flight. This is the core protection: bursts of
  uploads queue and drain at a safe rate instead of firing dozens of simultaneous
  egress requests (→ blocks and, for a metered proxy, blown budget).
- **Conditional egress-provider budget guard:** when proxy egress is metered,
  check/decrement a global request/unit counter (Upstash, shared) before each
  fetch. When exhausted, stop scraping and
  return `status:"blocked"` so the app degrades gracefully (§ below) — never
  silently overspend. This makes the budget a first-class, enforced limit (today
  it remains implicit in this proposed worker design).
- **Shared comp-cache:** the worker checks the **same** Upstash cache the app uses
  (`snaplist:cache:...`) before fetching — repeated identities require no egress.
  Cache stays "never the authority" per the PRD (TTL + age-decay on read).
- **Retries:** transient failures (timeout, 429, direct/proxy egress error) retry `K` times with
  exponential backoff (requeue with incremented `attempt`).
- **DLQ + graceful degradation:** after `K` exhausted attempts, route to a
  dead-letter queue **and** return `status:"error"`/`"blocked"` so the app falls
  through to a lower TS tier (web-search or depreciation). The seller still gets a
  price — this matches the PRD's tier-fallthrough ethos; the scrape failing must
  never strand an item.
- **Idempotency:** `requestId` is the dedupe key. RabbitMQ is at-least-once, so the
  worker (and `/finalize`) must tolerate redelivery — keep finalize a write-once
  upsert keyed by `itemId`.

---

## 8. Prometheus metrics (expose on the worker's `/metrics`)

- `sold_scrape_duration_seconds` (histogram)
- `sold_scrapes_total{result="ok|empty|blocked|error"}` (counter)
- `sold_scrape_queue_depth` (gauge)
- `sold_scrape_cache_hits_total` / `..._misses_total`
- `sold_egress_provider_units_spent_total` (counter) — zero/unset for direct egress
- `sold_scrape_retries_total`, `sold_scrape_dlq_total`
- `sold_scrape_inflight` (gauge — should never exceed `N`)

(Grafana over these is the obvious dashboard; Prometheus fits because the worker is
a **long-running process** — it would not fit the serverless app.)

---

## 9. Repo structure & deploy

- **Monorepo (recommended for a solo dev).** Keep the worker as a top-level
  `worker/` (Go) alongside the existing Next.js app. One repo, one place, shared
  docs/CI. Splitting into a second repo is "textbook microservices" but adds
  overhead you don't need yet. → **DECIDE-3.**
- **Deploy:** CI builds the `worker/` Docker image → registry (ECR or Docker Hub)
  → EC2 pulls & runs it. RabbitMQ runs on the **same EC2** for v1 (simplest; one
  box) — or CloudAMQP if you'd rather not self-manage the broker.
- **The app stays on Vercel.** It only *publishes* to RabbitMQ and exposes
  `/api/pricing/finalize`. It is never a long-running consumer.
- **Local dev:** `docker-compose.yml` with `rabbitmq` + `worker` so the full loop
  runs locally. With `SOLD_COMPS_TRANSPORT=inproc` (default) you need **none** of
  it — the app and tests behave exactly as today.
- **Secrets (do NOT commit):** worker needs the Upstash creds, RabbitMQ URL, and a
  shared secret for the `/finalize` callback; `EBAY_SOLD_PROXY_TEMPLATE` is needed
  only when proxy egress is selected. Record *where* they live, never the values.

---

## 10. Sync → async pipeline change (the actual behavioral diff)

**Before:** `uploadAndProcess` blocks on the full run; user waits ~5–10s.

**After:**
1. vision runs sync → `ItemSignal`.
2. **ISBN fast-path:** if an ISBN resolves a high-confidence price, finish
   synchronously (no scrape, no queue) and redirect as today. → **DECIDE-1.**
3. otherwise: persist the item as `pricing_pending`, publish a `ScrapeJob`, and
   redirect to `/review/:id` showing a "researching price…" state.
4. worker scrapes → posts `ScrapeResult` to `/api/pricing/finalize`.
5. `/finalize` runs the existing TS synthesis + listing generation, writes the
   result, and Supabase Realtime flips the review page from pending → priced.

The user gets a responsive redirect instead of a 10s block; the work still happens,
just off the request path with retries and concurrency control.

---

## 11. Decisions needing Aziz's sign-off

- **DECIDE-1 — keep the ISBN fast-path synchronous?** *Recommend yes.* ISBN is fast
  and free; queueing it adds latency for the easiest case.
- **DECIDE-2 — result delivery: worker→app HTTP callback vs. worker writes Supabase
  + Realtime (no callback).** *Recommend the HTTP callback to `/api/pricing/finalize`
  for v1* — it keeps 100% of synthesis in one TS place and is the simplest mental
  model. (Pure "result queue both ways" is more textbook but the app can't consume a
  queue on Vercel; the callback is the pragmatic equivalent.)
- **DECIDE-3 — monorepo vs. separate repo for `worker/`.** *Recommend monorepo.*
- **DECIDE-4 — broker hosting: RabbitMQ on the app EC2 vs. CloudAMQP.** *Recommend
  self-hosted on EC2 for the learning value* (you want to be able to say "I ran the
  broker"); CloudAMQP if you'd rather not.

---

## 12. Definition of done

- [ ] `SoldCompsTransport` interface with `inproc` (default) + `queue` backends;
      existing tests pass untouched with `inproc`.
- [ ] Go worker: consume `ScrapeJob` → cache check → conditional provider-budget guard → build/fetch/
      parse/filter → return `EbaySoldComp[]`; concurrency-capped; retries + DLQ.
- [ ] Worker output proven equal to the TS parser on saved fixtures (golden test —
      the offline HTML fixtures are the shared contract; no live egress performed).
- [ ] `/api/pricing/finalize` runs the unchanged synthesis + listing and upserts
      write-once by `itemId`; review page updates via Realtime.
- [ ] Prometheus `/metrics` exposes §8; a Grafana board reads them.
- [ ] `docker-compose` runs app + rabbitmq + worker locally; EC2 deploy documented.
- [ ] Graceful degradation verified: a forced scrape failure falls through to a
      lower TS tier, never strands an item.

## 13. Suggested build order (tracer-bullet, per AGENTS.md)

1. `SoldCompsTransport` interface + `inproc` backend (pure refactor, no behavior
   change, tests stay green). **Ship this first — everything else is behind it.**
2. Go worker that parses **saved fixtures** to `EbaySoldComp[]`; golden test vs. the
   TS parser. (No broker, no egress.)
3. RabbitMQ locally (docker-compose) + the `queue` transport + `/finalize`; prove
   the round trip end-to-end with `SOLD_COMPS_TRANSPORT=queue` locally.
4. Concurrency cap, conditional provider-budget guard, cache reuse, retries/DLQ.
5. Prometheus + Grafana.
6. EC2 deploy + the production flag flip.
