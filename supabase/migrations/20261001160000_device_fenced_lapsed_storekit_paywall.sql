-- Restated from 20260909120000_operator_pro_allowance.sql. The only change is
-- which denial a device-denied seller with a lapsed StoreKit period receives.
--
-- `get_verified_ai_item_entitlement` reports the included run to a seller
-- whose device fence has not reserved it and whose StoreKit period is neither
-- active nor in grace (20261001073019). This trigger told that same seller
-- `storekit-entitlement-unavailable`, which the app renders as "Your SnapList
-- Pro subscription is not active" behind a Settings link, while the
-- entitlement read had just told the app the free listing was available. Both
-- readings now agree with the no-period case: the included run is out of reach
-- and no paid period can fund the run, so the denial is
-- `device-fence-required` and the app opens the Pro offer.
--
-- Nothing about the fence changes. The included run is still spent only with a
-- reserved device claim, and active, grace and exhausted-allowance subscribers
-- keep the exact denial they had before.
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
        -- A lapsed period funds nothing, so a device-denied seller is in the
        -- same position as one with no period at all, and the entitlement read
        -- says so by reporting the included run. Only a seller the fence never
        -- applied to is told about the subscription's own state.
        raise exception using
          errcode = 'P0001',
          message = case when v_device_denied
            then 'AI item credit unavailable: device-fence-required'
            else 'AI item credit unavailable: storekit-entitlement-unavailable'
          end;
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
