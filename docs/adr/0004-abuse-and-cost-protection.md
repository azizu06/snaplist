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

- **Rate limiting — `@upstash/ratelimit` sliding window** on the metered routes (per-minute, keyed by
  Clerk user id, IP fallback), `snaplist:rl` key prefix. `enforceRateLimit` returns a `429` with
  `Retry-After`. Applied to the AI/metered routes: inbox `simulate` + `send` (model calls) and eBay
  `publish` (external write). The ⌘K `search` route is **deliberately excluded** — it's a cheap RLS'd
  DB read fired on every keystroke; rate-limiting it would break the palette.
- **Spend guardrail — a per-day counter** (`incrDaily`: Redis `INCR`+expiry | in-memory):
  - **Per-user/day item cap** (the quota billing #64 gates) — checked in the upload action *before*
    any photo upload or model call; over-cap redirects with a clear message (friendlier limit UI is
    deferred to the frontend issue).
  - **Global OpenAI budget alert** (distinct; warns, never blocks) — counts model-backed pipeline runs
    app-wide per day and fires a ONE-TIME alert (log + Sentry) on the exact first breach.
- **Offline-safe by construction.** `@upstash/ratelimit` and `@upstash/redis` are loaded ONLY via
  dynamic import (never static → never a client bundle, mirroring the Sentry pattern, ADR-0003). With
  no `UPSTASH_REDIS_REST_URL`/`_TOKEN`, an in-memory fallback keeps dev / the offline test suite fully
  working — per-instance, not shared across serverless invocations; production sets Upstash.
- **Everything env-tunable** (`RATE_LIMIT_*`, `QUOTA_*`, `OPENAI_DAILY_CALL_BUDGET`) with sensible
  defaults in `config.ts` (free: 20 req/min, 15 items/day; paid: 60, 200).

## Consequences

- Works with zero config offline; turning on real, cross-instance limiting is an Upstash env flip.
- The in-memory fallback does not share state across serverless instances (limits are softer in that
  mode) — acceptable for dev; production uses Upstash.
- `resolveTier` is the single seam #64 (billing) flips to grant paid limits; nothing else changes.
- A 429/limit UI polish pass is deferred to the frontend issue (server returns the correct signals).
