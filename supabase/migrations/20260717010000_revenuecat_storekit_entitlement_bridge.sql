-- RevenueCat/StoreKit entitlement verification bridge (issue #173).
-- RevenueCat manages the native purchase lifecycle; this schema binds its
-- verified App Store events to Clerk tenants and delegates quota exclusively to
-- the authoritative #168 AI-item allowance-period ledger.

create table public.revenuecat_customer_bindings (
  user_id text primary key,
  revenuecat_app_user_id text not null unique,
  original_transaction_id text unique,
  transition_state text not null default 'not_required'
    check (transition_state in ('not_required', 'required', 'reconciled')),
  legacy_stripe_status text,
  lifecycle_state text not null default 'unverified'
    check (lifecycle_state in (
      'unverified', 'active', 'grace', 'billing_retry', 'expired', 'revoked',
      'refunded', 'ambiguous'
    )),
  renewal_state text not null default 'unknown'
    check (renewal_state in ('unknown', 'renewing', 'canceled')),
  last_event_id text,
  last_event_type text,
  last_event_created_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint revenuecat_customer_bindings_identity_check check (
    char_length(user_id) between 1 and 255
    and char_length(revenuecat_app_user_id) between 1 and 255
    and (
      original_transaction_id is null
      or char_length(original_transaction_id) between 1 and 255
    )
  )
);

comment on table public.revenuecat_customer_bindings is
  'Server-owned Clerk to RevenueCat/App Store identity binding. Native state is advisory until a verified event advances this row and the #168 period ledger.';
comment on column public.revenuecat_customer_bindings.transition_state is
  'required blocks StoreKit credit activation while legacy Stripe ownership or an ambiguous provider lifecycle change needs explicit server reconciliation.';

create index revenuecat_customer_bindings_lifecycle_idx
  on public.revenuecat_customer_bindings (user_id, lifecycle_state, updated_at desc);

alter table public.revenuecat_customer_bindings enable row level security;
revoke all on table public.revenuecat_customer_bindings
  from public, anon, authenticated, service_role;
grant select on table public.revenuecat_customer_bindings to authenticated;

create policy revenuecat_customer_bindings_select_own
  on public.revenuecat_customer_bindings
  for select
  to authenticated
  using ((select public.clerk_user_id()) = user_id);

create table private.revenuecat_webhook_events (
  event_id text primary key,
  user_id text,
  revenuecat_app_user_id text not null,
  original_transaction_id text not null,
  event_type text not null,
  event_created_at timestamptz not null,
  payload_fingerprint text not null,
  outcome text not null check (outcome in (
    'applied', 'duplicate', 'reconciliation_required',
    'unmapped_reconciliation'
  )),
  received_at timestamptz not null default statement_timestamp(),
  constraint revenuecat_webhook_events_identity_check check (
    char_length(event_id) between 1 and 255
    and char_length(revenuecat_app_user_id) between 1 and 255
    and char_length(original_transaction_id) between 1 and 255
    and char_length(event_type) between 1 and 100
  )
);

create index revenuecat_webhook_events_customer_created_idx
  on private.revenuecat_webhook_events (
    revenuecat_app_user_id, event_created_at desc
  );
revoke all on table private.revenuecat_webhook_events
  from public, anon, authenticated, service_role;

create or replace function public.bind_revenuecat_customer(
  p_user_id text,
  p_revenuecat_app_user_id text
)
returns table (transition_state text, legacy_stripe_status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stripe_status text;
  v_stripe_current boolean := false;
  v_stripe_observed_at timestamptz;
  v_prior_transition text;
  v_period public.ai_item_allowance_periods%rowtype;
  v_transition_state text;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'RevenueCat binding authorization is required';
  end if;
  if coalesce(char_length(p_user_id), 0) not between 1 and 255
    or p_revenuecat_app_user_id is distinct from p_user_id then
    raise exception using errcode = '22023', message = 'RevenueCat App User ID must equal the authenticated Clerk user ID';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('revenuecat-customer:' || p_user_id, 0)
  );

  select binding.transition_state into v_prior_transition
  from public.revenuecat_customer_bindings binding
  where binding.user_id = p_user_id;

  select
    subscription.status,
    subscription.status in ('active', 'trialing')
      and subscription.current_period_end > statement_timestamp(),
    subscription.stripe_observed_at
  into v_stripe_status, v_stripe_current, v_stripe_observed_at
  from public.subscriptions subscription
  where subscription.user_id = p_user_id;
  v_transition_state := case
    when v_stripe_current then 'required'
    else 'not_required'
  end;

  insert into public.revenuecat_customer_bindings (
    user_id, revenuecat_app_user_id, transition_state, legacy_stripe_status
  ) values (
    p_user_id, p_revenuecat_app_user_id, v_transition_state, v_stripe_status
  )
  on conflict (user_id) do update
    set legacy_stripe_status = excluded.legacy_stripe_status,
        transition_state = case
          when excluded.transition_state = 'required' then 'required'
          when public.revenuecat_customer_bindings.transition_state = 'reconciled'
            then 'reconciled'
          when public.revenuecat_customer_bindings.transition_state = 'required'
            then 'required'
          else 'not_required'
        end,
        updated_at = statement_timestamp()
  where public.revenuecat_customer_bindings.revenuecat_app_user_id
    = excluded.revenuecat_app_user_id;

  if not found then
    raise exception using errcode = '23514', message = 'RevenueCat customer binding conflicts with an existing tenant';
  end if;

  if v_transition_state = 'required'
    and coalesce(v_prior_transition, 'not_required') <> 'required' then
    select * into v_period
    from public.ai_item_allowance_periods period
    where period.user_id = p_user_id
      and period.source = 'storekit'
      and period.state not in ('revoked', 'refunded', 'ambiguous')
    order by period.period_start desc
    limit 1
    for update;
    if found then
      perform public.record_verified_storekit_ai_item_period(
        p_user_id,
        v_period.period_key,
        v_period.original_transaction_id,
        v_period.period_start,
        v_period.expires_date,
        'ambiguous',
        null,
        v_period.allowance,
        'billing-source-conflict:' || md5(
          p_user_id || ':' || coalesce(v_stripe_observed_at::text, '')
        ),
        greatest(
          statement_timestamp(),
          v_period.last_event_created_at + interval '1 microsecond'
        )
      );
    end if;
  end if;

  return query
  select binding.transition_state, binding.legacy_stripe_status
  from public.revenuecat_customer_bindings binding
  where binding.user_id = p_user_id;
end;
$$;

create or replace function private.enforce_revenuecat_stripe_conflict()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prior_transition text;
  v_period public.ai_item_allowance_periods%rowtype;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('revenuecat-customer:' || new.user_id, 0)
  );
  select binding.transition_state into v_prior_transition
  from public.revenuecat_customer_bindings binding
  where binding.user_id = new.user_id
  for update;
  if not found then return new; end if;

  update public.revenuecat_customer_bindings
  set legacy_stripe_status = new.status,
      transition_state = case
        when new.status in ('active', 'trialing')
          and new.current_period_end > statement_timestamp() then 'required'
        else transition_state
      end,
      updated_at = statement_timestamp()
  where user_id = new.user_id;

  if new.status in ('active', 'trialing')
    and new.current_period_end > statement_timestamp()
    and v_prior_transition <> 'required' then
    select * into v_period
    from public.ai_item_allowance_periods period
    where period.user_id = new.user_id
      and period.source = 'storekit'
      and period.state not in ('revoked', 'refunded', 'ambiguous')
    order by period.period_start desc
    limit 1
    for update;
    if found then
      perform public.record_verified_storekit_ai_item_period(
        new.user_id,
        v_period.period_key,
        v_period.original_transaction_id,
        v_period.period_start,
        v_period.expires_date,
        'ambiguous',
        null,
        v_period.allowance,
        'billing-source-conflict:' || md5(
          new.user_id || ':' || new.stripe_observed_at::text
        ),
        greatest(
          statement_timestamp(),
          v_period.last_event_created_at + interval '1 microsecond'
        )
      );
    end if;
  end if;
  return new;
end;
$$;

create trigger subscriptions_enforce_revenuecat_stripe_conflict
after insert or update of status, current_period_end, stripe_observed_at
on public.subscriptions
for each row execute function private.enforce_revenuecat_stripe_conflict();

create or replace function public.resolve_revenuecat_customer(
  p_revenuecat_app_user_id text,
  p_original_app_user_id text,
  p_original_transaction_id text
)
returns table (user_id text, transition_state text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_binding public.revenuecat_customer_bindings%rowtype;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'RevenueCat resolution authorization is required';
  end if;
  if coalesce(char_length(p_revenuecat_app_user_id), 0) not between 1 and 255
    or coalesce(char_length(p_original_app_user_id), 0) not between 1 and 255
    or coalesce(char_length(p_original_transaction_id), 0) not between 1 and 255 then
    raise exception using errcode = '22023', message = 'Invalid RevenueCat customer identity';
  end if;
  if p_original_app_user_id is distinct from p_revenuecat_app_user_id then
    raise exception using errcode = '23514', message = 'RevenueCat original App User ID conflicts with the customer binding';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('revenuecat-transaction:' || p_original_transaction_id, 0)
  );

  select * into v_binding
  from public.revenuecat_customer_bindings binding
  where binding.revenuecat_app_user_id = p_revenuecat_app_user_id
  for update;
  if not found then return; end if;

  if v_binding.original_transaction_id is not null
    and v_binding.original_transaction_id <> p_original_transaction_id then
    raise exception using errcode = '23514', message = 'RevenueCat original transaction conflicts with the customer binding';
  end if;
  if exists (
    select 1 from public.revenuecat_customer_bindings binding
    where binding.original_transaction_id = p_original_transaction_id
      and binding.user_id <> v_binding.user_id
  ) then
    raise exception using errcode = '23514', message = 'RevenueCat original transaction is bound to another tenant';
  end if;

  update public.revenuecat_customer_bindings
  set original_transaction_id = coalesce(
        original_transaction_id, p_original_transaction_id
      ),
      updated_at = statement_timestamp()
  where public.revenuecat_customer_bindings.user_id = v_binding.user_id;

  return query select v_binding.user_id, v_binding.transition_state;
end;
$$;

create or replace function public.record_verified_revenuecat_ai_item_period(
  p_user_id text,
  p_revenuecat_app_user_id text,
  p_period_key text,
  p_original_transaction_id text,
  p_period_start timestamptz,
  p_expires_date timestamptz,
  p_state text,
  p_grace_expires_date timestamptz,
  p_allowance integer,
  p_event_id text,
  p_event_type text,
  p_event_created_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fingerprint text;
  v_existing private.revenuecat_webhook_events%rowtype;
  v_applied boolean;
  v_transition_state text;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'RevenueCat period authorization is required';
  end if;
  v_fingerprint := md5(jsonb_build_object(
    'user_id', p_user_id,
    'app_user_id', p_revenuecat_app_user_id,
    'period_key', p_period_key,
    'original_transaction_id', p_original_transaction_id,
    'period_start', p_period_start,
    'expires_date', p_expires_date,
    'state', p_state,
    'grace_expires_date', p_grace_expires_date,
    'allowance', p_allowance,
    'event_type', p_event_type,
    'event_created_at', p_event_created_at
  )::text);

  perform pg_advisory_xact_lock(
    hashtextextended('revenuecat-customer:' || p_user_id, 0)
  );
  select binding.transition_state into v_transition_state
  from public.revenuecat_customer_bindings binding
  where binding.user_id = p_user_id
    and binding.revenuecat_app_user_id = p_revenuecat_app_user_id
    and binding.original_transaction_id = p_original_transaction_id
  for update;
  if not found then
    raise exception using errcode = '23514', message = 'RevenueCat customer binding does not match the verified period';
  end if;
  if v_transition_state = 'required' then
    raise exception using errcode = '23514', message = 'Billing-source reconciliation is required';
  end if;

  select * into v_existing
  from private.revenuecat_webhook_events event
  where event.event_id = p_event_id
  for update;
  if found then
    if v_existing.payload_fingerprint <> v_fingerprint then
      raise exception using errcode = '23514', message = 'RevenueCat event identity conflicts';
    end if;
    return false;
  end if;

  v_applied := public.record_verified_storekit_ai_item_period(
    p_user_id,
    p_period_key,
    p_original_transaction_id,
    p_period_start,
    p_expires_date,
    p_state,
    p_grace_expires_date,
    p_allowance,
    p_event_id,
    p_event_created_at
  );

  insert into private.revenuecat_webhook_events (
    event_id, user_id, revenuecat_app_user_id, original_transaction_id,
    event_type, event_created_at, payload_fingerprint, outcome
  ) values (
    p_event_id, p_user_id, p_revenuecat_app_user_id,
    p_original_transaction_id, p_event_type, p_event_created_at, v_fingerprint,
    case when v_applied then 'applied' else 'duplicate' end
  );

  update public.revenuecat_customer_bindings
  set lifecycle_state = p_state,
      renewal_state = case
        when p_event_type = 'CANCELLATION' then 'canceled'
        when p_state in ('active', 'grace') then 'renewing'
        else renewal_state
      end,
      last_event_id = p_event_id,
      last_event_type = p_event_type,
      last_event_created_at = p_event_created_at,
      updated_at = statement_timestamp()
  where user_id = p_user_id
    and (
      last_event_created_at is null
      or last_event_created_at < p_event_created_at
    );
  return v_applied;
end;
$$;

create or replace function public.require_revenuecat_reconciliation(
  p_revenuecat_app_user_id text,
  p_original_app_user_id text,
  p_original_transaction_id text,
  p_event_id text,
  p_event_type text,
  p_event_created_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text;
  v_app_binding public.revenuecat_customer_bindings%rowtype;
  v_transaction_binding public.revenuecat_customer_bindings%rowtype;
  v_app_found boolean;
  v_transaction_found boolean;
  v_fingerprint text := md5(jsonb_build_object(
    'app_user_id', p_revenuecat_app_user_id,
    'original_app_user_id', p_original_app_user_id,
    'original_transaction_id', p_original_transaction_id,
    'event_id', p_event_id,
    'event_type', p_event_type,
    'event_created_at', p_event_created_at
  )::text);
  v_existing private.revenuecat_webhook_events%rowtype;
  v_effective_event_created_at timestamptz;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'RevenueCat reconciliation authorization is required';
  end if;
  if coalesce(char_length(p_revenuecat_app_user_id), 0) not between 1 and 255
    or coalesce(char_length(p_original_app_user_id), 0) not between 1 and 255
    or coalesce(char_length(p_original_transaction_id), 0) not between 1 and 255 then
    raise exception using errcode = '22023', message = 'Invalid RevenueCat reconciliation identity';
  end if;
  if p_original_app_user_id is distinct from p_revenuecat_app_user_id then
    raise exception using errcode = '23514', message = 'RevenueCat original App User ID conflicts with the customer binding';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('revenuecat-transaction:' || p_original_transaction_id, 0)
  );

  select * into v_existing
  from private.revenuecat_webhook_events event
  where event.event_id = p_event_id
  for update;
  if found then
    if v_existing.payload_fingerprint <> v_fingerprint then
      raise exception using errcode = '23514', message = 'RevenueCat reconciliation event identity conflicts';
    end if;
    return false;
  end if;

  select * into v_app_binding
  from public.revenuecat_customer_bindings binding
  where binding.revenuecat_app_user_id = p_revenuecat_app_user_id
  for update;
  v_app_found := found;

  select * into v_transaction_binding
  from public.revenuecat_customer_bindings binding
  where binding.original_transaction_id = p_original_transaction_id
  for update;
  v_transaction_found := found;

  if v_app_found and v_transaction_found
    and v_app_binding.user_id <> v_transaction_binding.user_id then
    raise exception using errcode = '23514', message = 'RevenueCat reconciliation identity crosses tenant bindings';
  end if;
  if v_app_found
    and v_app_binding.original_transaction_id is not null
    and v_app_binding.original_transaction_id <> p_original_transaction_id then
    raise exception using errcode = '23514', message = 'RevenueCat reconciliation transaction conflicts with the customer binding';
  end if;
  if v_transaction_found
    and v_transaction_binding.revenuecat_app_user_id <> p_revenuecat_app_user_id then
    raise exception using errcode = '23514', message = 'RevenueCat reconciliation customer conflicts with the transaction binding';
  end if;

  v_user_id := case
    when v_app_found then v_app_binding.user_id
    when v_transaction_found then v_transaction_binding.user_id
    else null
  end;

  if v_user_id is not null then
    v_effective_event_created_at := greatest(
      p_event_created_at,
      statement_timestamp(),
      coalesce(
        v_app_binding.last_event_created_at + interval '1 microsecond',
        p_event_created_at
      ),
      coalesce(
        v_transaction_binding.last_event_created_at + interval '1 microsecond',
        p_event_created_at
      )
    );
    update public.revenuecat_customer_bindings
    set transition_state = 'required',
        lifecycle_state = 'ambiguous',
        last_event_id = p_event_id,
        last_event_type = p_event_type,
        last_event_created_at = v_effective_event_created_at,
        updated_at = statement_timestamp()
    where user_id = v_user_id;
  end if;

  insert into private.revenuecat_webhook_events (
    event_id, user_id, revenuecat_app_user_id, original_transaction_id,
    event_type, event_created_at, payload_fingerprint, outcome
  ) values (
    p_event_id, v_user_id, p_revenuecat_app_user_id,
    p_original_transaction_id, p_event_type, p_event_created_at, v_fingerprint,
    case when v_user_id is null
      then 'unmapped_reconciliation'
      else 'reconciliation_required'
    end
  );
  return true;
end;
$$;

create or replace function public.get_verified_ai_item_entitlement(
  p_user_id text
)
returns table (
  billing_source text,
  status text,
  remaining_items integer,
  period_start timestamptz,
  period_end timestamptz,
  grace_period_end timestamptz,
  transition_state text,
  legacy_stripe_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_included public.ai_item_allowance_periods%rowtype;
  v_storekit public.ai_item_allowance_periods%rowtype;
  v_binding public.revenuecat_customer_bindings%rowtype;
  v_remaining integer;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Verified entitlement authorization is required';
  end if;
  if coalesce(char_length(p_user_id), 0) not between 1 and 255 then
    raise exception using errcode = '22023', message = 'Invalid entitlement user';
  end if;

  select * into v_binding
  from public.revenuecat_customer_bindings binding
  where binding.user_id = p_user_id;

  select * into v_included
  from public.ai_item_allowance_periods period
  where period.user_id = p_user_id
    and period.source = 'included'
  order by period.created_at
  limit 1;

  if not found then
    return query select
      'included'::text,
      'included'::text,
      1,
      null::timestamptz,
      null::timestamptz,
      null::timestamptz,
      v_binding.transition_state,
      v_binding.legacy_stripe_status;
    return;
  end if;

  select greatest(
    v_included.allowance - count(*) filter (
      where reservation.state <> 'restored'
    )::integer,
    0
  ) into v_remaining
  from public.ai_item_credit_reservations reservation
  where reservation.allowance_period_id = v_included.id;
  if v_remaining > 0 then
    return query select
      'included'::text,
      'included'::text,
      v_remaining,
      v_included.period_start,
      v_included.expires_date,
      null::timestamptz,
      v_binding.transition_state,
      v_binding.legacy_stripe_status;
    return;
  end if;

  select * into v_storekit
  from public.ai_item_allowance_periods period
  where period.user_id = p_user_id
    and period.source = 'storekit'
  order by period.period_start desc, period.created_at desc
  limit 1;
  if not found then
    return query select
      'included'::text,
      'included'::text,
      0,
      v_included.period_start,
      v_included.expires_date,
      null::timestamptz,
      v_binding.transition_state,
      v_binding.legacy_stripe_status;
    return;
  end if;

  select greatest(
    v_storekit.allowance - count(*) filter (
      where reservation.state <> 'restored'
    )::integer,
    0
  ) into v_remaining
  from public.ai_item_credit_reservations reservation
  where reservation.allowance_period_id = v_storekit.id;

  return query select
    'storekit'::text,
    v_storekit.state,
    case
      when v_storekit.state = 'active'
        and v_storekit.expires_date > statement_timestamp() then v_remaining
      when v_storekit.state = 'grace'
        and v_storekit.grace_expires_date > statement_timestamp() then v_remaining
      else 0
    end,
    v_storekit.period_start,
    v_storekit.expires_date,
    v_storekit.grace_expires_date,
    v_binding.transition_state,
    v_binding.legacy_stripe_status;
end;
$$;

create or replace function public.reconcile_revenuecat_billing_source(
  p_user_id text,
  p_expected_original_transaction_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Billing-source reconciliation authorization is required';
  end if;
  if coalesce(char_length(p_user_id), 0) not between 1 and 255
    or coalesce(char_length(p_expected_original_transaction_id), 0) not between 1 and 255 then
    raise exception using errcode = '22023', message = 'Invalid billing-source reconciliation identity';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('revenuecat-customer:' || p_user_id, 0)
  );
  update public.revenuecat_customer_bindings
  set transition_state = 'reconciled',
      updated_at = statement_timestamp()
  where user_id = p_user_id
    and original_transaction_id = p_expected_original_transaction_id
    and transition_state = 'required'
    and not exists (
      select 1
      from public.subscriptions subscription
      where subscription.user_id = p_user_id
        and subscription.status in ('active', 'trialing')
        and subscription.current_period_end > statement_timestamp()
    );
  return found;
end;
$$;

revoke all on function public.bind_revenuecat_customer(text, text)
  from public, anon, authenticated;
revoke all on function public.resolve_revenuecat_customer(text, text, text)
  from public, anon, authenticated;
revoke all on function public.record_verified_revenuecat_ai_item_period(
  text, text, text, text, timestamptz, timestamptz, text, timestamptz,
  integer, text, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.require_revenuecat_reconciliation(
  text, text, text, text, text, timestamptz
) from public, anon, authenticated;
revoke all on function private.enforce_revenuecat_stripe_conflict()
  from public, anon, authenticated, service_role;
revoke all on function public.reconcile_revenuecat_billing_source(text, text)
  from public, anon, authenticated;
revoke all on function public.get_verified_ai_item_entitlement(text)
  from public, anon, authenticated;

grant execute on function public.bind_revenuecat_customer(text, text)
  to service_role;
grant execute on function public.resolve_revenuecat_customer(text, text, text)
  to service_role;
grant execute on function public.record_verified_revenuecat_ai_item_period(
  text, text, text, text, timestamptz, timestamptz, text, timestamptz,
  integer, text, text, timestamptz
) to service_role;
grant execute on function public.require_revenuecat_reconciliation(
  text, text, text, text, text, timestamptz
) to service_role;
grant execute on function public.reconcile_revenuecat_billing_source(text, text)
  to service_role;
grant execute on function public.get_verified_ai_item_entitlement(text)
  to service_role;
