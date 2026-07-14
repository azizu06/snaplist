# Billing — freemium subscriptions via direct Stripe (implementation plan, #64)

> **Status:** frontend landed (this PR); backend is the remaining work and needs a human for the
> Stripe account + keys. Test mode only. This doc is the handoff spec for the backend slice.

## Why this doc
Issue [#64](https://github.com/azizu06/snaplist/issues/64) is `ready-for-human` because it needs a
Stripe account and keys in env. The **frontend** is independent of that and is done here, so the
backend can land as a clean follow-up. This plan records the decisions, the data model, the
endpoints, and — most importantly — **the one seam the backend flips** so nothing else has to change.

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
- **The tier seam:** `src/lib/abuse/config.ts` — `type Tier = "free" | "paid"`,
  `tierLimits(tier)` (env-configurable: free = 15 items/day · 20 req/min; paid = 200 · 60), and
  `resolveTier(userId)` which **currently returns `"free"` for everyone**. Its own comment says it is
  "the single seam that issue [#64] will set; nothing else changes." That is literally the plan.
- **Marketing `/pricing`** (`src/app/(marketing)/pricing/page.tsx`) — Beta `$0` live card + a
  "Seller Pro · $TBD · Coming soon" card with a disabled "Notify me" button, plus a billing FAQ.
- **In-app Plan & billing** (this PR) — a settings card that reads `resolveTier`/`tierLimits` and
  shows the live plan + real daily allowance. Free shows **See plans → `/pricing`**; the paid branch
  shows **Manage billing → `/api/billing/portal`** (the route this backend adds). The paid branch is
  dead today (everyone is free) and is the shape the backend lights up.

## The seam the backend flips
Today:
```ts
export function resolveTier(_userId: string): Tier { return "free"; }
```
Target: resolve from the entitlement mirror. `resolveTier` is **sync + pure** and is called on the
abuse/rate-limit hot path, so don't make it do I/O. Instead:
1. Add `async getEntitlement(userId): Promise<Tier>` that reads the `subscriptions` table (below) and
   maps Stripe status → tier (`active`/`trialing` → `paid`, else `free`).
2. Callers that already `await` (the settings page, the abuse check entry points) use
   `getEntitlement`; keep `resolveTier` as the pure default/fallback for places that can't await.
3. `tierLimits` stays pure and unchanged — the number shown in the UI is the number enforced.

The settings page already does `const tier = resolveTier(userId)`; swapping that one line to
`await getEntitlement(userId)` is the entire frontend change once the backend lands.

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

## Frontend already in place (so the backend is a clean drop-in)
- Settings **Plan & billing** card: live tier + real allowance, free → `/pricing`, paid →
  `/api/billing/portal`. Preview fixture covers it.
- When the backend lands: (a) point the free CTA at `POST /api/billing/checkout`; (b) flip the
  `/pricing` "Seller Pro · Coming soon / Notify me" card to a real checkout CTA and a concrete price;
  (c) change the settings page's one `resolveTier` line to `await getEntitlement(userId)`.

## Out of scope
Buyer/marketplace payments (stay on eBay), Clerk Billing, annual plans, proration UI, multiple paid
tiers (one `paid` tier for now — `tierLimits` already models exactly free vs paid).
