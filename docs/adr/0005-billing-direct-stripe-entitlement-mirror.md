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

2. **Supabase is the entitlement source of truth; Stripe is the billing system of record.** An immutable,
   service-role-only `billing_customers` table maps one Clerk user to one Stripe Customer before Checkout
   opens; `subscriptions` mirrors each user's current Subscription state (`tier`, `status`,
   customer/subscription ids, `current_period_end`). The app reads tier with a fast, RLS-guarded query
   and **never calls Stripe on the request path**. Subscription RLS is **read-own**; there is **no
   client write policy** — a user cannot forge `paid`.

3. **The seam the app flips:** `async getEntitlement(userId)` reads the mirror and maps status → tier
   via the single rule `entitlementTierFromStatus` (`active`/`trialing` → `paid`, else `free`). It is
   **fail-safe** — any error/missing row resolves to `free`, so a billing hiccup never grants
   entitlement nor blocks a request. The pure `resolveTier` stays the default for can't-await/hot
   paths (the per-request rate limiter); the once-per-upload **quota check** resolves the real
   entitlement (`checkDailyItemQuota(userId, env, await getEntitlement(userId))`), so Pro actually
   gets the higher cap.

4. **Three endpoints, lifecycle-safe webhook.** `POST /api/billing/checkout` persists or reuses the
   Customer map, atomically claims one pending hosted Checkout (returning that same URL on retry), and
   routes a Customer with a non-terminal Subscription to Portal; `POST /api/billing/portal` uses that
   same map; `POST /api/webhooks/stripe` is signature-verified, raw-body, and Node runtime. Webhooks
   atomically claim `event.id` (`stripe_events`), map the signed event's Customer through the durable
   server map, retrieve the current Subscription from Stripe, reconcile a current non-terminal
   Subscription for that Customer, and use a monotonic observed-at upsert before completing the claim.
   That makes retries safe, prevents a late terminal event for an old subscription from restoring stale
   entitlement state, and keeps an unmapped legacy Checkout completion retryable rather than assigning
   it from metadata. Failed-invoice handling accepts Stripe's current nested Subscription reference
   as well as the legacy top-level shape. Status contract: 400 bad signature, 503 unconfigured, 500
   transient (Stripe retries), 200 processed/duplicate/ignored.

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
- **Negative / risks:** a failed first Customer-map write prevents Checkout from opening rather than
  risking a second Customer; ambiguous historical Customer ownership blocks the migration for human
  repair. The rate limiter stays on the pure `resolveTier` (free limits) to avoid a per-request DB
  read — paid gating applies to the per-upload quota (the real cost lever), not the per-minute rate
  limit. Live mode awaits Stripe account verification (a key swap).

## Docs touched

`.env.example` (Stripe test-mode block); the frontend handoff `docs/billing-plan.md` (PR #77) records
the UI side and the contract this backend implements.
