-- Stripe lifecycle hardening (issue #152).
--
-- A Stripe Customer is the durable tenant anchor for both Checkout retries and
-- webhook lifecycle events. It is intentionally separate from `subscriptions`:
-- a Customer exists before a seller completes Checkout, while `subscriptions`
-- remains the entitlement mirror written from the current Stripe Subscription.

create table public.billing_customers (
  user_id            text primary key,
  stripe_customer_id text not null unique,
  created_at         timestamptz not null default now()
);

comment on table public.billing_customers is
  'Immutable SnapList Clerk-user to Stripe-Customer mapping (issue #152). Service-role server paths only; never client-readable or client-writable.';

alter table public.billing_customers enable row level security;

-- No user policy or authenticated-table grant: route handlers and Stripe webhooks
-- use the server-only service-role client after authenticating the Clerk user.
revoke all on table public.billing_customers from anon, authenticated;
revoke all on table public.stripe_events from anon, authenticated;

-- Keep the entitlement contract explicit even in databases whose default grants
-- differ: users may read only their RLS-scoped mirror, never mutate it.
revoke all on table public.subscriptions from anon;
revoke insert, update, delete on table public.subscriptions from authenticated;
grant select on table public.subscriptions to authenticated;

-- Existing users who already have a webhook-mirrored Customer retain their stable
-- mapping. Abort rather than arbitrarily assigning a shared historical Customer
-- to one tenant: that must be investigated before a migration can proceed.
do $$
declare
  conflicting_customer_id text;
begin
  select stripe_customer_id
    into conflicting_customer_id
    from public.subscriptions
   where stripe_customer_id is not null
   group by stripe_customer_id
  having count(*) > 1
   limit 1;

  if conflicting_customer_id is not null then
    raise exception using
      errcode = '23514',
      message = 'Cannot backfill billing_customers: one Stripe Customer maps to multiple SnapList users.';
  end if;
end;
$$;

insert into public.billing_customers (user_id, stripe_customer_id)
select user_id, stripe_customer_id
  from public.subscriptions
 where stripe_customer_id is not null
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------
-- Checkout reservation: one live hosted Checkout per Customer.
-- ---------------------------------------------------------------------

create table public.billing_checkout_reservations (
  user_id                    text primary key,
  stripe_customer_id         text not null references public.billing_customers(stripe_customer_id),
  idempotency_key            uuid not null,
  claim_token                uuid not null,
  stripe_checkout_session_id text unique,
  checkout_url               text,
  expires_at                 timestamptz,
  claimed_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

alter table public.billing_checkout_reservations enable row level security;
revoke all on table public.billing_checkout_reservations from anon, authenticated;

create trigger billing_checkout_reservations_set_updated_at
  before update on public.billing_checkout_reservations
  for each row execute function public.set_updated_at();

-- Atomically either returns a live Checkout URL, grants this server process the
-- right to create one, or reports a very recent in-flight claim. Reclaiming a
-- stalled no-URL reservation keeps the same Stripe idempotency key, so a crash
-- between Stripe creation and database completion cannot create a second session.
create or replace function public.claim_billing_checkout(
  p_user_id text,
  p_stripe_customer_id text
)
returns table (
  state text,
  idempotency_key uuid,
  claim_token uuid,
  checkout_url text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.billing_checkout_reservations%rowtype;
  v_now timestamptz := now();
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Service-role authorization is required.';
  end if;

  select * into v_row
    from public.billing_checkout_reservations
   where user_id = p_user_id
   for update;

  if not found then
    insert into public.billing_checkout_reservations (
      user_id, stripe_customer_id, idempotency_key, claim_token, claimed_at
    ) values (
      p_user_id, p_stripe_customer_id, gen_random_uuid(), gen_random_uuid(), v_now
    ) on conflict (user_id) do nothing
    returning * into v_row;

    if found then
      return query select 'claim', v_row.idempotency_key, v_row.claim_token, null::text, null::timestamptz;
      return;
    end if;

    -- Another concurrent first request inserted the reservation after our first
    -- select. Lock and inspect that row instead of surfacing a unique violation.
    select * into v_row
      from public.billing_checkout_reservations
     where user_id = p_user_id
     for update;
  end if;

  if v_row.stripe_customer_id <> p_stripe_customer_id then
    raise exception using errcode = '23514', message = 'Billing Checkout Customer mapping mismatch.';
  end if;

  if v_row.checkout_url is not null and v_row.expires_at > v_now then
    return query select 'ready', v_row.idempotency_key, v_row.claim_token, v_row.checkout_url, v_row.expires_at;
    return;
  end if;

  if v_row.checkout_url is null and v_row.claimed_at > v_now - interval '30 seconds' then
    return query select 'in_progress', v_row.idempotency_key, v_row.claim_token, null::text, null::timestamptz;
    return;
  end if;

  update public.billing_checkout_reservations
     set idempotency_key = case when v_row.checkout_url is null then v_row.idempotency_key else gen_random_uuid() end,
         claim_token = gen_random_uuid(),
         stripe_checkout_session_id = null,
         checkout_url = null,
         expires_at = null,
         claimed_at = v_now
   where user_id = p_user_id
   returning * into v_row;

  return query select 'claim', v_row.idempotency_key, v_row.claim_token, null::text, null::timestamptz;
end;
$$;

create or replace function public.complete_billing_checkout_claim(
  p_user_id text,
  p_claim_token uuid,
  p_checkout_session_id text,
  p_checkout_url text,
  p_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Service-role authorization is required.';
  end if;

  update public.billing_checkout_reservations
     set stripe_checkout_session_id = p_checkout_session_id,
         checkout_url = p_checkout_url,
         expires_at = p_expires_at
   where user_id = p_user_id
     and claim_token = p_claim_token;
  return found;
end;
$$;

create or replace function public.release_billing_checkout_claim(
  p_user_id text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Service-role authorization is required.';
  end if;

  update public.billing_checkout_reservations
     set claimed_at = now() - interval '31 seconds'
   where user_id = p_user_id
     and claim_token = p_claim_token
     and checkout_url is null;
  return found;
end;
$$;

create or replace function public.clear_billing_checkout_reservation(
  p_user_id text,
  p_stripe_customer_id text,
  p_checkout_session_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Service-role authorization is required.';
  end if;

  delete from public.billing_checkout_reservations
   where user_id = p_user_id
     and stripe_customer_id = p_stripe_customer_id
     and stripe_checkout_session_id = p_checkout_session_id;
  return found;
end;
$$;

revoke all on function public.claim_billing_checkout(text, text) from public, anon, authenticated;
revoke all on function public.complete_billing_checkout_claim(text, uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.release_billing_checkout_claim(text, uuid) from public, anon, authenticated;
revoke all on function public.clear_billing_checkout_reservation(text, text, text) from public, anon, authenticated;
grant execute on function public.claim_billing_checkout(text, text) to service_role;
grant execute on function public.complete_billing_checkout_claim(text, uuid, text, text, timestamptz) to service_role;
grant execute on function public.release_billing_checkout_claim(text, uuid) to service_role;
grant execute on function public.clear_billing_checkout_reservation(text, text, text) to service_role;

-- ---------------------------------------------------------------------
-- Webhook claim + monotonic mirror observation.
-- ---------------------------------------------------------------------

alter table public.stripe_events
  add column status text not null default 'processed' check (status in ('processing', 'processed')),
  add column claim_token uuid,
  add column processing_started_at timestamptz;

alter table public.subscriptions
  add column stripe_observed_at timestamptz not null default now();

create or replace function public.claim_stripe_event(
  p_event_id text,
  p_type text
)
returns table (state text, claim_token uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.stripe_events%rowtype;
  v_token uuid := gen_random_uuid();
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Service-role authorization is required.';
  end if;

  insert into public.stripe_events (event_id, type, status, claim_token, processing_started_at)
  values (p_event_id, p_type, 'processing', v_token, now())
  on conflict (event_id) do nothing;

  if found then
    return query select 'claimed', v_token;
    return;
  end if;

  select * into v_row from public.stripe_events where event_id = p_event_id for update;
  if v_row.status = 'processed' then
    return query select 'duplicate', null::uuid;
    return;
  end if;

  if v_row.processing_started_at > now() - interval '2 minutes' then
    return query select 'in_progress', null::uuid;
    return;
  end if;

  update public.stripe_events
     set type = p_type,
         status = 'processing',
         claim_token = v_token,
         processing_started_at = now()
   where event_id = p_event_id;
  return query select 'claimed', v_token;
end;
$$;

create or replace function public.complete_stripe_event_claim(
  p_event_id text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Service-role authorization is required.';
  end if;

  update public.stripe_events
     set status = 'processed',
         claim_token = null,
         processing_started_at = null
   where event_id = p_event_id
     and status = 'processing'
     and claim_token = p_claim_token;
  return found;
end;
$$;

create or replace function public.release_stripe_event_claim(
  p_event_id text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Service-role authorization is required.';
  end if;

  delete from public.stripe_events
   where event_id = p_event_id
     and status = 'processing'
     and claim_token = p_claim_token;
  return found;
end;
$$;

create or replace function public.upsert_billing_subscription(
  p_user_id text,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_status text,
  p_current_period_end timestamptz,
  p_stripe_observed_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Service-role authorization is required.';
  end if;

  insert into public.subscriptions (
    user_id, stripe_customer_id, stripe_subscription_id, status, tier,
    current_period_end, stripe_observed_at
  ) values (
    p_user_id, p_stripe_customer_id, p_stripe_subscription_id, p_status,
    case when p_status in ('active', 'trialing') then 'paid' else 'free' end,
    p_current_period_end, p_stripe_observed_at
  )
  on conflict (user_id) do update
    set stripe_customer_id = excluded.stripe_customer_id,
        stripe_subscription_id = excluded.stripe_subscription_id,
        status = excluded.status,
        tier = excluded.tier,
        current_period_end = excluded.current_period_end,
        stripe_observed_at = excluded.stripe_observed_at
  where public.subscriptions.stripe_observed_at <= excluded.stripe_observed_at;
  return found;
end;
$$;

revoke all on function public.claim_stripe_event(text, text) from public, anon, authenticated;
revoke all on function public.complete_stripe_event_claim(text, uuid) from public, anon, authenticated;
revoke all on function public.release_stripe_event_claim(text, uuid) from public, anon, authenticated;
revoke all on function public.upsert_billing_subscription(text, text, text, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_stripe_event(text, text) to service_role;
grant execute on function public.complete_stripe_event_claim(text, uuid) to service_role;
grant execute on function public.release_stripe_event_claim(text, uuid) to service_role;
grant execute on function public.upsert_billing_subscription(text, text, text, text, timestamptz, timestamptz) to service_role;
