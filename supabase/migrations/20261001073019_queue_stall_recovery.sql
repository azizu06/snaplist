-- Recovery preserves every durable claim and the single-writer rendezvous.
-- FIFO-by-id reopens an abandoned head forever when the minute cadence exceeds
-- its 35s deferral. Select the oldest eligibility time instead: deferred work
-- moves behind sellers already waiting, while SKIP LOCKED keeps claims atomic.
create or replace function public.claim_included_offer_message(
  p_visibility_timeout_seconds integer
)
returns table (message_id bigint, read_count bigint, envelope jsonb)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_included_offer_authority();
  if p_visibility_timeout_seconds is null
    or p_visibility_timeout_seconds not between 1 and 3600 then
    raise exception using errcode = '22023',
      message = 'Invalid included-offer queue claim bounds';
  end if;
  return query
  with candidate as (
    select queued.msg_id
    from pgmq.q_included_offer_redemption queued
    where queued.vt <= clock_timestamp()
    order by queued.vt, queued.msg_id
    limit 1
    for update skip locked
  )
  update pgmq.q_included_offer_redemption queued
  set vt = clock_timestamp() + make_interval(secs => p_visibility_timeout_seconds),
      read_ct = queued.read_ct + 1
  from candidate
  where queued.msg_id = candidate.msg_id
  returning queued.msg_id, queued.read_ct::bigint, queued.message;
end;
$$;
revoke all on function public.claim_included_offer_message(integer)
  from public, anon, authenticated;
grant execute on function public.claim_included_offer_message(integer)
  to service_role;

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
  v_operator public.ai_item_allowance_periods%rowtype;
  v_storekit public.ai_item_allowance_periods%rowtype;
  v_binding public.revenuecat_customer_bindings%rowtype;
  v_remaining integer;
  v_paid_precedes_included boolean := false;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Verified entitlement authorization is required';
  end if;
  if coalesce(char_length(p_user_id), 0) not between 1 and 255 then
    raise exception using errcode = '22023', message = 'Invalid entitlement user';
  end if;

  select * into v_binding
  from public.revenuecat_customer_bindings binding
  where binding.user_id = p_user_id;

  -- Issue #1077: an operator is Pro for as long as the row exists, so Settings
  -- shows the existing active state through the unchanged envelope. The
  -- ±infinity bounds arrive at the client as null dates, which is why no
  -- period row is drawn for a grant that has no billing period.
  select * into v_operator
  from public.ai_item_allowance_periods period
  where period.user_id = p_user_id
    and period.source = 'operator'
    and period.state = 'active'
  limit 1;

  if found then
    select greatest(
      v_operator.allowance - count(*) filter (
        where reservation.state <> 'restored'
          or reservation.retry_reservation_count
            > reservation.retry_restore_count
      )::integer,
      0
    ) into v_remaining
    from public.ai_item_credit_reservations reservation
    where reservation.allowance_period_id = v_operator.id;

    return query select
      'included'::text,
      'active'::text,
      v_remaining,
      v_operator.period_start,
      v_operator.expires_date,
      null::timestamptz,
      v_binding.transition_state,
      v_binding.legacy_stripe_status;
    return;
  end if;

  -- An unredeemed device claim cannot fund the next run. A verified paid
  -- period must therefore become visible after purchase, matching reservation
  -- precedence, rather than leaving the Pro gate on an unreachable free offer.
  if not (
    p_user_id ~ '^guest_[0-9a-f]{48}$'
    or exists (
      select 1 from public.included_offer_device_claims claim
      where claim.user_id = p_user_id
        and (claim.consumed_at is not null
          or (claim.state = 'reserved' and claim.consumed_at is null))
    )
  ) then
    select * into v_storekit
    from public.ai_item_allowance_periods period
    where period.user_id = p_user_id
      and period.source = 'storekit'
      and period.period_start <= statement_timestamp()
    order by period.period_start desc, period.expires_date desc
    limit 1;
    v_paid_precedes_included := found and (
      (v_storekit.state = 'active'
        and v_storekit.expires_date > statement_timestamp())
      or (v_storekit.state = 'grace'
        and v_storekit.grace_expires_date > statement_timestamp())
    );
  end if;

  select * into v_included
  from public.ai_item_allowance_periods period
  where period.user_id = p_user_id
    and period.source = 'included'
  order by period.created_at
  limit 1;

  if not found and not v_paid_precedes_included then
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
        or reservation.retry_reservation_count
          > reservation.retry_restore_count
    )::integer,
    0
  ) into v_remaining
  from public.ai_item_credit_reservations reservation
  where reservation.allowance_period_id = v_included.id;
  if v_remaining > 0 and not v_paid_precedes_included then
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

  if not v_paid_precedes_included then
    select * into v_storekit
    from public.ai_item_allowance_periods period
    where period.user_id = p_user_id
      and period.source = 'storekit'
    order by period.period_start desc, period.created_at desc
    limit 1;
  end if;
  if v_storekit.id is null then
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
        or reservation.retry_reservation_count
          > reservation.retry_restore_count
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
revoke all on function public.get_verified_ai_item_entitlement(text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_verified_ai_item_entitlement(text)
  to service_role;
