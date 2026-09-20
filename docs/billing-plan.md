# Billing — freemium subscriptions via direct Stripe (implementation plan, #64)

> **Status:** historical. This doc's original "frontend landed, backend remaining" plan predates
> `src/lib/billing/` and the Stripe/RevenueCat backend that has since shipped, and predates the web
> `(app)` dashboard's retirement under #598. See "Current state" below for what actually exists
> today; do not use the original frontend/backend split as a work plan.

## Why this doc
Issue [#64](https://github.com/azizu06/snaplist/issues/64) originally proposed a direct-Stripe
billing surface. This plan recorded the decisions, the data model, the endpoints, and — most
importantly — **the one seam the backend flips** so nothing else has to change. Kept for the data
model and endpoint design record; see "Current state" for what actually shipped.

## Non-negotiables (from PRD / AGENTS, don't relitigate)
- **Direct Stripe SDK, not Clerk Billing.** Clerk stays **auth-only**. We want the real
  webhook/lifecycle surface as a showcase skill.
- **Supabase is the entitlement source of truth.** Stripe is the system of record for *billing*;
  webhooks mirror entitlement into Postgres so the app reads tier with a fast, RLS-guarded query and
  never calls Stripe on the request path.
- **Test mode (free).** All keys are Stripe **test-mode**; `EBAY`-style env flip to live later.
- **Buyer payments never touch SnapList.** This bills *sellers* for the app. Item checkout/shipping
  stay on eBay. (Underwriting framing: software subscription, not a marketplace.)
- **Stripe behind an adapter interface**, mirroring the eBay adapter, so the pipeline stays
  offline-testable against a fake.

## Current state (what already exists — build on these, don't duplicate)
- **The tier seam:** `src/lib/abuse/config.ts` — `type Tier = "free" | "paid"` and
  `tierLimits(tier)` (env-configurable: free = 15 items/day · 20 req/min; paid = 200 · 60).
  `resolveTier(userId)` still returns `"free"` for everyone; it is not this plan's authority for
  SnapList Pro entitlement (see below).
- **This plan's Stripe backend has shipped**, in `src/lib/billing/{adapter,entitlement,lifecycle,
  webhook}.ts` plus `src/app/api/billing/{checkout,portal}/route.ts` and
  `src/app/api/webhooks/stripe/route.ts`, matching the endpoints and idempotency design below. No
  client surface calls these routes today — see the next point.
- **No `/pricing` page and no web settings surface exist.** The `(app)` web dashboard route group,
  including any "Plan & billing" settings card, was retired under #598 (see
  `src/app/retired-web-dashboard-copy.test.ts`); `/pricing` is a permanent redirect to `/`
  (`next.config.ts`). The web app is marketing + auth only.
- **SnapList Pro entitlement in the shipped native app runs through RevenueCat/StoreKit** (issue
  #173), not this doc's Stripe checkout/portal flow — see
  `docs/revenuecat-storekit-operator-runbook.md` and `src/lib/billing/revenuecat*.ts`. This plan's
  Stripe backend remains unused by any current client.

## The seam the backend flips
`resolveTier(_userId) { return "free"; }` stays the pure sync default for callers that can't
await. `getEntitlement(userId)` (async, reads the `subscriptions` mirror) has shipped and is the
seam this Stripe plan's own item-run policy actually reads (`src/lib/billing/item-run-policy.ts`);
`tierLimits` stays pure and unchanged. There is no settings-page caller to flip — SnapList Pro
gating in the shipped app goes through the RevenueCat/StoreKit path described above instead.

## Data model
`billing_customers` is an immutable, server-only Customer map (one row per Clerk user):

| column | type | notes |
| --- | --- | --- |
| `user_id` | text (PK) | Clerk id, mapped by an authenticated server route before Checkout |
| `stripe_customer_id` | text (unique) | one durable Stripe Customer per seller; no client policy/grant |

`subscriptions` is the entitlement mirror (one row per user; RLS read-own, writes service-role only):

| column | type | notes |
|---|---|---|
| `user_id` | text (PK) | Clerk id, like every domain table |
| `stripe_customer_id` | text | created on first checkout |
| `stripe_subscription_id` | text null | current subscription |
| `tier` | text | `free` \| `paid`, derived from status |
| `status` | text | raw Stripe status (`active`, `past_due`, `canceled`, …) |
| `current_period_end` | timestamptz null | for "renews/ends on" copy |
| `updated_at` | timestamptz | last webhook write |

- **RLS:** `select` where `user_id = public.clerk_user_id()`; no client `insert/update/delete`.
- Optional `stripe_events(event_id PK, type, received_at)` table for webhook idempotency (below).

## Endpoints
All under the app's existing route conventions; validate payloads with **Zod**; structured-log via
`src/lib/observability.ts`.

1. **`POST /api/billing/checkout`** — auth required. Persist-or-reuse the durable Customer mapping,
   then query Stripe for a non-terminal Subscription. Route an existing Subscription to Portal;
   otherwise atomically claim one pending Checkout reservation and create it with the reservation's
   Stripe idempotency key. Retries return the same unexpired hosted URL rather than creating a second
   session/subscription.
2. **`POST /api/billing/portal`** — auth required. Resolve the same Customer map and create a Billing
   Portal session, returning `{ url }`. This is the target the settings "Manage billing" button names.
3. **`POST /api/webhooks/stripe`** — **no auth**, **signature-verified** with
   `STRIPE_WEBHOOK_SECRET` (raw body — disable body parsing / use the raw route). Handle:
   `checkout.session.completed`, `customer.subscription.created|updated|deleted`,
   `invoice.payment_failed`. Each handler **upserts** the `subscriptions` row from the Stripe object.

### Idempotency (acceptance calls this out explicitly)
Webhooks are at-least-once. Make handlers idempotent:
- Atomically claim `event.id` in `stripe_events` (a concurrent in-progress delivery stays retryable), **and**
- Resolve the signed event's Stripe Customer through `billing_customers`, retrieve the current
  Subscription from Stripe, reconcile a current non-terminal Subscription for that Customer, then
  state-upsert it keyed by `user_id` only if its observation is at least as new as the stored one. This
  makes replayed and out-of-order events converge without trusting session or invoice metadata; a
  late terminal event for an old subscription cannot displace a newer active one. A signed legacy
  Checkout completion with no Customer map stays retryable for safe manual reconciliation rather than
  being assigned from client metadata. For `invoice.payment_failed`, accept Stripe's current
  `parent.subscription_details.subscription` reference as well as the older top-level shape.

## Env (test mode)
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO` (the Pro price id), and an app base
URL for redirects (reuse the existing one). Add to `src/lib/env.ts` lazily (build must stay
secret-free). Quota numbers stay on the existing `QUOTA_*` / `RATE_LIMIT_*` env from #58.

## Testing (tracer-bullet, highest seam)
- **Stripe behind an interface** (`createStripeAdapter`), like the eBay adapter — unit-test checkout
  and portal session creation against a **fake**, no live calls.
- **Webhook idempotency** — replay the same event twice → exactly one entitlement state; assert
  signature rejection on a bad signature.
- **Entitlement mapping** — `getEntitlement` maps each Stripe status to the right `Tier` (pure,
  table-driven test).
- **RLS** — a user cannot read another user's `subscriptions` row (mirrors the existing tenancy
  suite), cannot write either entitlement row, and cannot read the server-only Customer map.
- **Bounded test-mode E2E** — `docs/billing-test-mode-e2e.md` covers abandoned Checkout → retry →
  signed webhook → entitlement → Portal → cancellation using one seller and no live charges.

## No web frontend for this plan
There is no `/pricing` page and no web settings surface (see "Current state" above); this Stripe
backend has no client calling it. If this seam is revived, it needs a client, not just a backend
drop-in — evaluate against the shipped RevenueCat/StoreKit entitlement path first rather than
building a second one.

## Out of scope
Buyer/marketplace payments (stay on eBay), Clerk Billing, annual plans, proration UI, multiple paid
tiers (one `paid` tier for now — `tierLimits` already models exactly free vs paid).
