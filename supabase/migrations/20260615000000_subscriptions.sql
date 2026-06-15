-- Billing entitlement mirror (issue #64) — freemium subscriptions via direct Stripe.
--
-- DESIGN (see docs/billing-plan.md):
-- Stripe is the system of record for BILLING; Supabase is the entitlement source of
-- truth the APP reads. Stripe webhooks mirror each user's subscription state into
-- `subscriptions` so the request path resolves the tier with a fast, RLS-guarded
-- query and NEVER calls Stripe inline. Buyers never touch this — it bills SELLERS
-- for the app (item checkout/shipping stay on eBay).
--
-- Tenancy follows the post-#41 pattern: text user_id = Clerk id, RLS keyed on
-- public.clerk_user_id(). A user may READ ONLY THEIR OWN row; there is NO client
-- insert/update/delete policy — the webhook handler writes with the service role
-- (which bypasses RLS), exactly like the eBay account-deletion handler. So a user
-- can never forge their own entitlement.

-- =====================================================================
-- subscriptions — one row per user, the entitlement mirror.
-- =====================================================================
create table public.subscriptions (
  user_id                text primary key,
  -- The Stripe customer, created on first checkout.
  stripe_customer_id     text,
  -- The current subscription (null before first checkout / after hard delete).
  stripe_subscription_id text,
  -- Derived entitlement: 'free' | 'paid' (maps the Stripe status; see
  -- src/lib/billing/config.ts entitlementTierFromStatus). The app reads THIS.
  tier                   text not null default 'free' check (tier in ('free', 'paid')),
  -- Raw Stripe status ('active', 'trialing', 'past_due', 'canceled', …) for "renews/
  -- ends on" copy and debugging — the tier is derived from it, not the other way round.
  status                 text,
  -- End of the current period, for the UI's renews/ends-on line.
  current_period_end     timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table public.subscriptions is
  'Per-user billing entitlement mirror (issue #64). Written ONLY by the Stripe webhook (service role); RLS lets a user read only their own row. Stripe is the billing system of record; this is what the app reads for tier.';

-- The webhook upserts by stripe_customer_id / stripe_subscription_id when mapping a
-- Stripe object back to a user; index them for those lookups (service-role path).
create index subscriptions_stripe_customer_id_idx on public.subscriptions (stripe_customer_id);
create index subscriptions_stripe_subscription_id_idx on public.subscriptions (stripe_subscription_id);

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

alter table public.subscriptions enable row level security;

-- Read-own ONLY. No insert/update/delete policy: entitlement is set exclusively by
-- the webhook on the service-role client, so a user cannot grant themselves 'paid'.
create policy subscriptions_select_own on public.subscriptions
  for select to authenticated using (public.clerk_user_id() = user_id);

-- =====================================================================
-- stripe_events — webhook idempotency ledger (at-least-once delivery).
-- =====================================================================
-- Stripe delivers each event AT LEAST once. The handler inserts the event id here
-- first; a duplicate insert (unique-violation) means "already processed" → ack and
-- skip. This is infra, not user data: RLS is ENABLED with NO policy, so only the
-- service-role webhook path (which bypasses RLS) can ever touch it.
create table public.stripe_events (
  event_id    text primary key,
  type        text,
  received_at timestamptz not null default now()
);

comment on table public.stripe_events is
  'Stripe webhook idempotency ledger (issue #64): one row per processed event id. Service-role only; RLS enabled with no policy.';

alter table public.stripe_events enable row level security;
