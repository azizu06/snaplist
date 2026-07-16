# ADR-0004: Abuse & cost protection — rate limiting + spend guardrail

Status: accepted · Issue #58

## Context

The metered AI endpoints (vision + pricing + listing generation, buyer-reply drafting) cost real
money per call and are an abuse surface on a deployed, multi-tenant app. We need (a) request rate
limiting and (b) a spend guardrail that caps per-user daily usage and warns when the global model
budget is exceeded — with limits that billing (#64) can later gate by tier. Constraints: build offline
(no Upstash account required to develop/test), and no `node:`-deps package may reach a client bundle.

## Decision

Two primitives in `src/lib/abuse/`, both offline-safe and tier-aware (everyone `free` until #64).

- **Rate limiting — `@upstash/ratelimit` sliding window** on the metered entry points (per-minute,
  keyed by Clerk user id, IP fallback where a route provides it), `snaplist:rl` key prefix.
  `enforceRateLimit` returns a `429` with `Retry-After`; server actions redirect with an equivalent
  retry message. Applied to inbox `simulate`, foreground `sync`, approved `send`,
  follow-up send, and both explicit delivery-retry routes; the bulk-capture
  `POST /api/batch/item` run (one metered pipeline run per haul item, #100), seller-triggered review
  identity regeneration (#126), and eBay `publish` (external write). The ⌘K `search` route is
  **deliberately excluded** — it's a cheap RLS'd
  DB read fired on every keystroke; rate-limiting it would break the palette. The bulk-capture
  status poll (`GET /api/batch/status`) is likewise excluded — a cheap RLS'd read, not model work.
- **Spend guardrail — a per-day counter** (`incrDaily`: Redis `INCR`+expiry | in-memory):
  - **Per-user/day item cap** (the quota billing #64 gates) — checked in the upload action *and* the
    bulk-capture batch-item route (#100) *before* any photo upload or model call; over-cap redirects
    with a clear message (single-item) or returns a `quota` signal that blocks the rest of the batch
    (bulk), so a haul can't spend past the cap (friendlier limit UI is deferred to the frontend issue).
  - **Global OpenAI budget alert** (distinct; warns, never blocks) — counts model-backed pipeline runs
    app-wide per day, including accepted review identity regenerations, and fires a ONE-TIME alert
    (log + Sentry) on the exact first breach. Regenerations rejected by preflight do not consume the
    counter.
- **Offline-safe by construction.** `@upstash/ratelimit` and `@upstash/redis` are loaded ONLY via
  dynamic import (never static → never a client bundle, mirroring the Sentry pattern, ADR-0003). With
  no `UPSTASH_REDIS_REST_URL`/`_TOKEN`, an in-memory fallback keeps dev / the offline test suite fully
  working — per-instance, not shared across serverless invocations; production sets Upstash.
- **Everything env-tunable** (`RATE_LIMIT_*`, `QUOTA_*`, `OPENAI_DAILY_CALL_BUDGET`) with sensible
  defaults in `config.ts` (free: 20 req/min, 15 items/day; paid: 60, 200).

## Consequences

- Works with zero config offline; turning on real, cross-instance limiting is an Upstash env flip.
- The in-memory fallback does not share state across serverless instances (limits are softer in that
  mode) — acceptable for dev; production uses Upstash. Because a hard env assertion would trade a
  guardrail for an outage (and break the offline-build constraint), the "production sets Upstash"
  assumption is guarded by a ONE-TIME alert instead: the first production check that runs on the
  fallback emits `abuse.store.fallback-in-production` (log + Sentry, mirroring the budget alert).
- `resolveTier` is the single seam #64 (billing) flips to grant paid limits; nothing else changes.
- A 429/limit UI polish pass is deferred to the frontend issue (server returns the correct signals).
