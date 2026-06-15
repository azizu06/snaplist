# ADR-0005 — Freemium billing via direct Stripe, with a Supabase entitlement mirror

- **Status:** Accepted (2026-06-15)
- **Deciders:** Aziz
- **Implemented by:** issue #64 — frontend slice (PR #77, settings card + `docs/billing-plan.md`),
  backend slice (this ADR: data model, adapter, endpoints, webhook, the `getEntitlement` seam).

## Context

SnapList needs freemium subscription billing **for the app itself** (sellers pay for SnapList; buyer
checkout/shipping stay on eBay). Two cross-cutting constraints:

- The **quota tiers already exist** (`src/lib/abuse/config.ts`, #58): `Tier = "free" | "paid"`,
  `tierLimits` (free = 15 items/day · 20 req/min; paid = 200 · 60), and `resolveTier(userId)` which
  returns `"free"` for everyone — its comment names #64 as the issue that sets it. Billing only has to
  flip that seam, not invent tiers.
- It must run **offline and test-mode**: the Stripe account is sandbox-only (live access under review),
  and the offline test suite must not need a key.

## Decision

1. **Direct Stripe SDK, not Clerk Billing.** Clerk stays auth-only; we want the real
   webhook/lifecycle surface as a showcase skill. The SDK lives behind a `StripeBillingAdapter`
   interface (mirroring the eBay adapter), lazy-imported so the offline path never loads it; tests use
   `MockStripeBillingAdapter`. Going live is a key swap, no code change.

2. **Supabase is the entitlement source of truth; Stripe is the billing system of record.** A
   `subscriptions` table mirrors each user's state (`tier`, `status`, customer/subscription ids,
   `current_period_end`). The app reads tier with a fast, RLS-guarded query and **never calls Stripe
   on the request path**. RLS is **read-own**; there is **no client write policy** — the webhook
   writes with the service role, so a user cannot forge `paid`.

3. **The seam the app flips:** `async getEntitlement(userId)` reads the mirror and maps status → tier
   via the single rule `entitlementTierFromStatus` (`active`/`trialing` → `paid`, else `free`). It is
   **fail-safe** — any error/missing row resolves to `free`, so a billing hiccup never grants
   entitlement nor blocks a request. The pure `resolveTier` stays the default for can't-await/hot
   paths (the per-request rate limiter); the once-per-upload **quota check** resolves the real
   entitlement (`checkDailyItemQuota(userId, env, await getEntitlement(userId))`), so Pro actually
   gets the higher cap.

4. **Three endpoints, idempotent webhook.** `POST /api/billing/checkout` (subscription Checkout
   Session), `POST /api/billing/portal` (Billing Portal), `POST /api/webhooks/stripe`
   (signature-verified, raw body, Node runtime). Webhooks are **at-least-once**, so handling is
   idempotent: dedupe on `event.id` (a `stripe_events` ledger) **and** a state-upsert keyed by
   `user_id` — and the row is upserted **before** the event is marked processed, so a mid-flight
   failure re-processes (the upsert is idempotent) rather than being dropped. Status contract: 400
   bad signature, 503 unconfigured, 500 transient (Stripe retries), 200 processed/duplicate/ignored.

5. **Test mode, env-gated.** `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PRICE_PRO` are
   optional; unset → the routes 503 and everyone is `free`. Redirect URLs derive from the request
   origin (no app-URL env).

## Alternatives considered

- **Clerk Billing** — rejected: hides the webhook/lifecycle engineering that is the point of the
  showcase; couples billing to the auth vendor.
- **Read the tier from Stripe on each request** — rejected: a Stripe round-trip on the hot path is
  slow and a availability coupling. The mirror is the standard pattern.
- **Trust the webhook without an idempotency ledger** — rejected: at-least-once delivery would
  double-process; the state-upsert alone converges but the ledger avoids needless reprocessing.

## Consequences

- **Positive:** real Stripe lifecycle + idempotent webhooks as a portfolio skill; entitlement is
  un-forgeable (service-role writes, RLS read-own); fully offline-testable behind the adapter; flips
  the existing tier seam with no quota re-design.
- **Negative / risks:** a fresh checkout that never completes can create an unused Stripe customer
  (test-mode, negligible); the rate limiter stays on the pure `resolveTier` (free limits) to avoid a
  per-request DB read — paid gating applies to the per-upload quota (the real cost lever), not the
  per-minute rate limit. Live mode awaits Stripe account verification (a key swap).

## Docs touched

`.env.example` (Stripe test-mode block); the frontend handoff `docs/billing-plan.md` (PR #77) records
the UI side and the contract this backend implements.
