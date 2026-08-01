begin;

select plan(7);

-- Issue #524. The device fence is enforced inside
-- `private.reserve_ai_item_credit_for_pipeline_run`, the only place an account
-- can begin spending the included first AI run. These contracts run in CI,
-- where the RLS integration suites for this fence do not: that job starts the
-- database container alone, so anything asserted only through PostgREST skips.
--
-- Acceptance criteria 7 and 8 are the load-bearing ones here: a device that has
-- already consumed the promotion denies *only* the promotion. The account stays
-- usable on the paid path.

-- A device-denied account is one with no reserved claim: the redemption either
-- never ran, or Apple reported `bit0` already set for this physical device.
insert into public.included_offer_device_claims
  (claim_id, user_id, idempotency_key, app_attest_key_id, state)
values (
  gen_random_uuid(),
  'device-fence-included',
  'device-fence-included-key',
  'pgtap-key-device-fence-included',
  'reserved'
);

-- The paid seller's housemate consumed this device, so no claim exists for
-- them — but they subscribed to SnapList Pro.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
begin
  perform public.record_verified_storekit_ai_item_period(
    'device-fence-paid',
    'device-fence-paid-period',
    'device-fence-paid-transaction',
    statement_timestamp() - interval '1 day',
    statement_timestamp() + interval '29 days',
    'active',
    null,
    1,
    'device-fence-paid-event',
    statement_timestamp()
  );
end;
$$;
reset role;

create temporary table included_offer_fence_runs (
  label text primary key,
  run_id uuid not null
) on commit drop;

insert into included_offer_fence_runs (label, run_id)
select 'included', staged.run_id
from public.stage_pipeline_batch(
  'device-fence-included',
  '91000000-0000-4000-8000-000000000001'::uuid,
  jsonb_build_array(jsonb_build_object(
    'idempotency_key', 'device-fence-included-run',
    'source', 'single',
    'autopilot_enabled', false,
    'photo_paths', jsonb_build_array('device-fence-included/pgtap/front.jpg'),
    'cost_basis', null
  )),
  100,
  100
) staged;

select is(
  (
    select period.source
    from public.ai_item_allowance_periods period
    join public.ai_item_credit_reservations reservation
      on reservation.allowance_period_id = period.id
    join included_offer_fence_runs staged on staged.run_id = reservation.pipeline_run_id
    where staged.label = 'included'
  ),
  'included',
  'a reserved device claim lets the account spend the included first run'
);
select ok(
  (
    select claim.consumed_at is not null and claim.pipeline_run_id = staged.run_id
    from public.included_offer_device_claims claim
    join included_offer_fence_runs staged on staged.label = 'included'
    where claim.user_id = 'device-fence-included'
  ),
  'spending the included run consumes that account''s device claim exactly once'
);

-- AC7/AC8. The seller below has no device claim at all. Before this contract
-- existed the fence raised `device-fence-required` here and the paid path was
-- unreachable, so a SnapList Pro subscriber whose device was already consumed
-- could never run another item — while the redemption API kept reporting
-- `paidPathAvailable: true`.
insert into included_offer_fence_runs (label, run_id)
select 'paid', staged.run_id
from public.stage_pipeline_batch(
  'device-fence-paid',
  '91000000-0000-4000-8000-000000000002'::uuid,
  jsonb_build_array(jsonb_build_object(
    'idempotency_key', 'device-fence-paid-run',
    'source', 'single',
    'autopilot_enabled', false,
    'photo_paths', jsonb_build_array('device-fence-paid/pgtap/front.jpg'),
    'cost_basis', null
  )),
  100,
  100
) staged;

select is(
  (
    select period.source
    from public.ai_item_allowance_periods period
    join public.ai_item_credit_reservations reservation
      on reservation.allowance_period_id = period.id
    join included_offer_fence_runs staged on staged.run_id = reservation.pipeline_run_id
    where staged.label = 'paid'
  ),
  'storekit',
  'a device-denied account still reserves against its verified paid period'
);
select is(
  (
    select count(*)
    from public.ai_item_credit_reservations reservation
    join public.ai_item_allowance_periods period
      on period.id = reservation.allowance_period_id
    where period.user_id = 'device-fence-paid'
      and period.source = 'included'
  ),
  0::bigint,
  'the denied promotion is left unspent rather than silently consumed'
);
select ok(
  (
    select not exists (
      select 1
      from public.included_offer_device_claims claim
      where claim.user_id = 'device-fence-paid'
    )
  ),
  'the paid path mints no device claim of its own'
);

-- The promotion is denied, not the account: only once the paid period is also
-- exhausted does the seller hit a wall, and the wall names the fence rather
-- than the allowance, because the support override is the remedy that would
-- actually give this seller their included run back.
select throws_ok(
  $$
    select *
    from public.stage_pipeline_batch(
      'device-fence-paid',
      '91000000-0000-4000-8000-000000000003'::uuid,
      jsonb_build_array(jsonb_build_object(
        'idempotency_key', 'device-fence-paid-second-run',
        'source', 'single',
        'autopilot_enabled', false,
        'photo_paths', jsonb_build_array('device-fence-paid/pgtap/second.jpg'),
        'cost_basis', null
      )),
      100,
      100
    )
  $$,
  'P0001',
  'AI item credit unavailable: device-fence-required',
  'an exhausted paid period reports the fence, whose override is the remedy'
);

select throws_ok(
  $$
    select *
    from public.stage_pipeline_batch(
      'device-fence-blocked',
      '91000000-0000-4000-8000-000000000004'::uuid,
      jsonb_build_array(jsonb_build_object(
        'idempotency_key', 'device-fence-blocked-run',
        'source', 'single',
        'autopilot_enabled', false,
        'photo_paths', jsonb_build_array('device-fence-blocked/pgtap/front.jpg'),
        'cost_basis', null
      )),
      100,
      100
    )
  $$,
  'P0001',
  'AI item credit unavailable: device-fence-required',
  'no claim and no paid entitlement still denies before any provider spend'
);

select * from finish();

rollback;
