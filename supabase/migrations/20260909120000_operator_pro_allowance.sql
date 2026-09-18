-- Issue #1077: operator SnapList Pro for the App Review demo account and the
-- owner, without a purchase.
--
-- The grant is a THIRD allowance source alongside the included first-run offer
-- and verified StoreKit periods. It is deliberately not a StoreKit period and
-- not a RevenueCat customer: the webhook path, the customer-binding resolver
-- and the legacy-environment quarantine all filter on `source = 'storekit'`,
-- so reconciliation can never mistake an operator row for a purchase, and
-- there is no transaction span to reconcile in the first place.
--
-- Membership is decided above this migration, in `getProOperatorUserIds`,
-- against the authenticated Clerk subject. The database is the second fence,
-- not the first: it accepts only an exact Clerk subject shape from a
-- service-role caller, so a guest principal, an email or a wildcard is refused
-- here too.
--
-- The ledger keeps recording every run. An operator reservation is an ordinary
-- `ai_item_credit_reservations` row against the operator period, so the eval
-- harness and the settle/restore lifecycle see reviewer runs exactly as they
-- see paid ones.

alter table public.ai_item_allowance_periods
  drop constraint ai_item_allowance_periods_source_check;
alter table public.ai_item_allowance_periods
  add constraint ai_item_allowance_periods_source_check check (
    source in ('included', 'operator', 'storekit')
  );

alter table public.ai_item_allowance_periods
  drop constraint ai_item_allowance_periods_source_identity_check;
alter table public.ai_item_allowance_periods
  add constraint ai_item_allowance_periods_source_identity_check check (
    (
      source = 'included'
      and period_key = 'included-first-run'
      and original_transaction_id is null
      and state = 'active'
      and allowance = 1
    )
    or (
      -- One stable identity per operator, so a repeat grant updates the same
      -- row instead of accumulating windows. There is no transaction to point
      -- at, and the row is only ever active: an operator grant is withdrawn by
      -- removing the account from the environment and deleting the row, never
      -- by expiring it like a subscription.
      source = 'operator'
      and period_key = 'operator-pro-grant'
      and original_transaction_id is null
      and state = 'active'
    )
    or (
      source = 'storekit'
      and coalesce(char_length(period_key), 0) between 1 and 255
      and coalesce(char_length(original_transaction_id), 0) between 1 and 255
    )
  );

alter table public.ai_item_allowance_periods
  drop constraint ai_item_allowance_periods_event_check;
alter table public.ai_item_allowance_periods
  add constraint ai_item_allowance_periods_event_check check (
    (
      last_event_id is null and last_event_created_at is null
      and source in ('included', 'operator')
    )
    or (
      coalesce(char_length(last_event_id), 0) between 1 and 255
      and last_event_created_at is not null
      and source = 'storekit'
    )
  );

comment on constraint ai_item_allowance_periods_source_check
  on public.ai_item_allowance_periods is
  'included = the one free run that comes with an account; storekit = a server-verified Apple period; operator = an env-gated grant for the App Review account and the owner (#1077), never a purchase.';

-- The narrow capability the server uses to materialize an operator period.
-- It cannot read or write any other tenant row, and only the service role may
-- call it: the allowlist itself lives in `SNAPLIST_PRO_OPERATOR_USER_IDS`.
create or replace function public.grant_operator_ai_item_allowance(
  p_user_id text,
  p_allowance integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Operator allowance authorization is required';
  end if;
  -- An operator is always a Clerk account. A `guest_…` App Attest principal,
  -- an email address and a wildcard all fail this, so a mistake in the
  -- environment cannot become a grant even if the layer above it were skipped.
  if coalesce(p_user_id, '') !~ '^user_[A-Za-z0-9]{1,120}$' then
    raise exception using
      errcode = '22023',
      message = 'Operator allowance requires an exact Clerk subject';
  end if;
  if p_allowance is null or p_allowance not between 1 and 10000 then
    raise exception using
      errcode = '22023',
      message = 'Invalid operator allowance';
  end if;

  insert into public.ai_item_allowance_periods (
    user_id,
    source,
    period_key,
    period_start,
    expires_date,
    state,
    allowance
  ) values (
    p_user_id,
    'operator',
    'operator-pro-grant',
    '-infinity'::timestamptz,
    'infinity'::timestamptz,
    'active',
    p_allowance
  )
  on conflict (user_id, source, period_key) do update
    set allowance = excluded.allowance,
        state = 'active',
        updated_at = statement_timestamp();
  return true;
end;
$$;

revoke all on function public.grant_operator_ai_item_allowance(text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.grant_operator_ai_item_allowance(text, integer)
  to service_role;

comment on function public.grant_operator_ai_item_allowance(text, integer) is
  'Materializes the #1077 operator SnapList Pro period. Idempotent per user; service-role only; never writes a RevenueCat or StoreKit row.';

-- Restated from 20260731190000_included_offer_device_fence.sql. The only
-- change is the operator branch: it sits after the included offer declines and
-- before the StoreKit lookup, so an operator never reaches the paywall and
-- every other seller keeps the exact denial they had before.
create or replace function private.reserve_ai_item_credit_for_pipeline_run()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_photo_paths text[];
  v_photo_set_fingerprint text;
  v_period public.ai_item_allowance_periods%rowtype;
  v_used integer;
  v_existing public.ai_item_credit_reservations%rowtype;
  v_claim public.included_offer_device_claims%rowtype;
  v_device_denied boolean := false;
  v_uses_included boolean := false;
  v_now timestamptz := statement_timestamp();
begin
  if new.capture_input is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('ai-item-credit:' || new.user_id, 0)
  );

  select item.photos into v_photo_paths
  from public.items item
  where item.id = new.item_id
    and item.user_id = new.user_id
  for update;
  if not found or cardinality(v_photo_paths) not between 1 and 5 then
    raise exception using
      errcode = '23503',
      message = 'AI-item credit run has no owned immutable photo set';
  end if;
  v_photo_set_fingerprint := encode(
    sha256(convert_to(array_to_json(v_photo_paths)::text, 'UTF8')),
    'hex'
  );

  insert into public.ai_item_allowance_periods (
    user_id,
    source,
    period_key,
    period_start,
    expires_date,
    state,
    allowance
  ) values (
    new.user_id,
    'included',
    'included-first-run',
    '-infinity'::timestamptz,
    'infinity'::timestamptz,
    'active',
    1
  )
  on conflict (user_id, source, period_key) do nothing;

  select * into v_period
  from public.ai_item_allowance_periods period
  where period.user_id = new.user_id
    and period.source = 'included'
    and period.period_key = 'included-first-run'
  for update;

  select count(*) into v_used
  from public.ai_item_credit_reservations reservation
  where reservation.allowance_period_id = v_period.id
    and (
      reservation.state in ('reserved', 'settled')
      or (
        reservation.state = 'restored'
        and reservation.retry_reservation_count > reservation.retry_restore_count
      )
    );

  -- Issue #524: the included promotion additionally requires that this physical
  -- Apple device has not already consumed it. #332 verified-guest principals are
  -- fenced by their own App Attest-backed allowance and are out of scope here.
  --
  -- The fence is evaluated before the paid fallback rather than after it,
  -- because a denied device is a reason to *skip* the included period, not a
  -- reason to refuse the account. Acceptance criteria 7 and 8: only the
  -- promotion is denied, and the seller stays usable on every paid path.
  if v_used < v_period.allowance then
    if new.user_id ~ '^guest_[0-9a-f]{48}$'
      or exists (
        -- A technical retry after a restored credit reuses the account's
        -- already spent claim; the device is not asked to pay twice for one
        -- account.
        select 1
        from public.included_offer_device_claims spent
        where spent.user_id = new.user_id
          and spent.consumed_at is not null
      )
    then
      v_uses_included := true;
    else
      select * into v_claim
      from public.included_offer_device_claims claim
      where claim.user_id = new.user_id
        and claim.state = 'reserved'
        and claim.consumed_at is null
      order by claim.created_at
      limit 1
      for update;

      -- No reserved claim means the redemption never completed, or Apple
      -- reported this device's `bit0` already set. Either way the account keeps
      -- its unspent included period and falls through to the paid path below;
      -- the audited one-time support override is the only way back to it.
      v_uses_included := found;
      v_device_denied := not found;
    end if;
  end if;

  if not v_uses_included then
    -- Issue #1077. An operator period exists only for an account the server
    -- environment named, and it is written by a service-role capability, never
    -- by a client. It is consulted before StoreKit so the App Review account
    -- reaches run #2 without a purchase, and it is skipped entirely for
    -- everyone else, whose denials below are unchanged.
    select * into v_period
    from public.ai_item_allowance_periods period
    where period.user_id = new.user_id
      and period.source = 'operator'
      and period.state = 'active'
    limit 1
    for update;

    if found then
      select count(*) into v_used
      from public.ai_item_credit_reservations reservation
      where reservation.allowance_period_id = v_period.id
        and (
          reservation.state in ('reserved', 'settled')
          or (
            reservation.state = 'restored'
            and reservation.retry_reservation_count > reservation.retry_restore_count
          )
        );
      -- The allowance is large enough that a reviewer cannot reach it, but it
      -- is still an allowance: an exhausted operator falls to the ordinary
      -- refusal rather than to an unbounded bypass.
      if v_used >= v_period.allowance then
        raise exception using
          errcode = 'P0001',
          message = 'AI item credit unavailable: monthly-allowance-reached';
      end if;
    else
      select * into v_period
      from public.ai_item_allowance_periods period
      where period.user_id = new.user_id
        and period.source = 'storekit'
        and period.period_start <= v_now
      order by period.period_start desc, period.expires_date desc
      limit 1
      for update;

      -- A seller with no paid period at all is told about the fence rather than
      -- about the subscription, because the included run is what they are
      -- entitled to and cannot reach. That override stops here. Every
      -- authenticated seller who has not consumed the promotion is device-denied
      -- by construction — a web seller can never consume it — so carrying the
      -- override into the branches below would tell a paying subscriber whose
      -- monthly allowance is exhausted to go buy the subscription they already
      -- have. Those branches report their own true reason.
      if not found then
        raise exception using
          errcode = 'P0001',
          message = case when v_device_denied
            then 'AI item credit unavailable: device-fence-required'
            else 'AI item credit unavailable: snaplist-pro-required'
          end;
      end if;
      if not (
        (v_period.state = 'active' and v_now < v_period.expires_date)
        or (
          v_period.state = 'grace'
          and v_period.grace_expires_date is not null
          and v_now < v_period.grace_expires_date
        )
      ) then
        raise exception using
          errcode = 'P0001',
          message = 'AI item credit unavailable: storekit-entitlement-unavailable';
      end if;

      select count(*) into v_used
      from public.ai_item_credit_reservations reservation
      where reservation.allowance_period_id = v_period.id
        and (
          reservation.state in ('reserved', 'settled')
          or (
            reservation.state = 'restored'
            and reservation.retry_reservation_count > reservation.retry_restore_count
          )
        );
      if v_used >= v_period.allowance then
        raise exception using
          errcode = 'P0001',
          message = 'AI item credit unavailable: monthly-allowance-reached';
      end if;
    end if;
  elsif v_claim.claim_id is not null then
    update public.included_offer_device_claims
    set consumed_at = v_now,
        pipeline_run_id = new.id
    where claim_id = v_claim.claim_id;
  end if;

  insert into public.ai_item_credit_reservations (
    user_id,
    pipeline_run_id,
    item_id,
    allowance_period_id,
    logical_run_key,
    photo_set_fingerprint
  ) values (
    new.user_id,
    new.id,
    new.item_id,
    v_period.id,
    new.idempotency_key,
    v_photo_set_fingerprint
  )
  on conflict (pipeline_run_id) do nothing;

  select * into v_existing
  from public.ai_item_credit_reservations reservation
  where reservation.pipeline_run_id = new.id;
  if not found
    or v_existing.user_id is distinct from new.user_id
    or v_existing.item_id is distinct from new.item_id
    or v_existing.logical_run_key is distinct from new.idempotency_key
    or v_existing.photo_set_fingerprint is distinct from v_photo_set_fingerprint then
    raise exception using
      errcode = '23514',
      message = 'AI-item credit reservation identity conflicts';
  end if;
  return new;
end;
$$;

revoke all on function private.reserve_ai_item_credit_for_pipeline_run()
  from public, anon, authenticated, service_role;

-- Restated from 20260720003000_manual_retry_credit_reconciliation.sql. The only
-- change is the operator projection.
--
-- The shipped client decodes `billing_source` as a strict Swift enum of
-- included | storekit | none, and `ios/` is out of scope for this issue, so the
-- operator period reports the non-purchase value `included` with an `active`
-- status. That is the literally true reading of the row — this allowance comes
-- with the account and no Apple transaction exists — and `storekit` would be
-- the lie. The durable operator marker that reconciliation actually reads is
-- `ai_item_allowance_periods.source`, which nothing here overwrites.
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
        or reservation.retry_reservation_count
          > reservation.retry_restore_count
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
