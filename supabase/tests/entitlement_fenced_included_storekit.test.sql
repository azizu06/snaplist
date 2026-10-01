begin;

select plan(12);

-- The reservation trigger skips the included first run when the device fence
-- has not reserved it (`private.reserve_ai_item_credit_for_pipeline_run`), so a
-- device-denied seller's next run spends their StoreKit period. The verified
-- entitlement must report the same truth, or a seller who subscribed at the
-- Pro gate keeps reading `included` and the paywall never resumes the item.

-- Only `ent-reachable-paid` holds the reserved claim a completed redemption
-- would have produced; every other tenant here is device-denied.
insert into public.included_offer_device_claims
  (claim_id, user_id, idempotency_key, app_attest_key_id, state)
values (
  gen_random_uuid(),
  'ent-reachable-paid',
  'ent-reachable-paid-key',
  'pgtap-key-ent-reachable-paid',
  'reserved'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
begin
  perform public.record_verified_storekit_ai_item_period(
    tenant,
    tenant || '-period',
    tenant || '-transaction',
    statement_timestamp() - interval '1 day',
    statement_timestamp() + interval '29 days',
    'active',
    null,
    24,
    tenant || '-event',
    statement_timestamp()
  )
  from unnest(array['ent-fenced-paid', 'ent-reachable-paid']) as tenant;

  perform public.record_verified_storekit_ai_item_period(
    'ent-fenced-expired',
    'ent-fenced-expired-period',
    'ent-fenced-expired-transaction',
    statement_timestamp() - interval '40 days',
    statement_timestamp() - interval '10 days',
    'expired',
    null,
    24,
    'ent-fenced-expired-event',
    statement_timestamp()
  );
end;
$$;
-- `reset role` keeps the transaction-local service-role claim the entitlement
-- reader checks, while the fixture inserts below run as the test owner.
reset role;

select is(
  (select row(billing_source, status, remaining_items)::text
   from public.get_verified_ai_item_entitlement('ent-fenced-paid')),
  '(storekit,active,24)',
  'a device-denied subscriber reads the StoreKit period their next run will spend'
);
select is(
  (select period_end > statement_timestamp()
   from public.get_verified_ai_item_entitlement('ent-fenced-paid')),
  true,
  'the device-denied subscriber sees the live StoreKit period end'
);
select is(
  (select row(billing_source, status, remaining_items)::text
   from public.get_verified_ai_item_entitlement('ent-fenced-free')),
  '(included,included,1)',
  'a device-denied seller without a subscription keeps the unchanged included reading'
);
select is(
  (select row(billing_source, status, remaining_items)::text
   from public.get_verified_ai_item_entitlement('ent-reachable-paid')),
  '(included,included,1)',
  'a reachable included run still reads first, matching the reservation order'
);
select is(
  (select row(billing_source, status, remaining_items)::text
   from public.get_verified_ai_item_entitlement('ent-fenced-expired')),
  '(included,included,1)',
  'an expired StoreKit period never displaces the included reading'
);

-- A queued claim is not a reserved one: the redemption has not completed, so
-- the reservation trigger would still skip the included run.
insert into public.included_offer_device_claims
  (claim_id, user_id, idempotency_key, app_attest_key_id, state)
values (
  gen_random_uuid(),
  'ent-fenced-paid',
  'ent-fenced-paid-key',
  'pgtap-key-ent-fenced-paid',
  'queued'
);
select is(
  (select billing_source
   from public.get_verified_ai_item_entitlement('ent-fenced-paid')),
  'storekit',
  'a queued device claim does not make the included run reachable'
);

-- Guests are fenced by their own App Attest allowance, so the included run is
-- always theirs to spend first.
set local role service_role;
do $$
begin
  perform public.record_verified_storekit_ai_item_period(
    'guest_' || repeat('a', 48),
    'ent-guest-period',
    'ent-guest-transaction',
    statement_timestamp() - interval '1 day',
    statement_timestamp() + interval '29 days',
    'active',
    null,
    24,
    'ent-guest-event',
    statement_timestamp()
  );
end;
$$;
reset role;
select is(
  (select billing_source
   from public.get_verified_ai_item_entitlement('guest_' || repeat('a', 48))),
  'included',
  'a verified guest keeps reading the included run first'
);

select ok(
  has_function_privilege(
    'service_role', 'public.get_verified_ai_item_entitlement(text)', 'execute'
  ),
  'service role can still read the verified entitlement'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.get_verified_ai_item_entitlement(text)', 'execute'
  ),
  'authenticated callers still cannot read the verified entitlement directly'
);

insert into public.ai_item_allowance_periods (
  user_id, source, period_key, period_start, expires_date, state, allowance
) values (
  'ent-fenced-paid', 'included', 'included-first-run',
  '-infinity', 'infinity', 'active', 1
);
select is(
  (select billing_source from public.get_verified_ai_item_entitlement('ent-fenced-paid')),
  'storekit',
  'an existing unspent included row also yields to reachable paid credits'
);
set local role service_role;
select public.record_verified_storekit_ai_item_period(
  'ent-fenced-grace', 'ent-grace-period', 'ent-grace-transaction',
  statement_timestamp() - interval '31 days', statement_timestamp() - interval '1 day',
  'grace', statement_timestamp() + interval '2 days', 24,
  'ent-grace-event', statement_timestamp()
);
reset role;
select is(
  (select row(billing_source, status, remaining_items)::text
   from public.get_verified_ai_item_entitlement('ent-fenced-grace')),
  '(storekit,grace,24)',
  'verified unexpired grace also resumes the paid path'
);
insert into public.included_offer_device_claims (
  claim_id, user_id, idempotency_key, app_attest_key_id, state, consumed_at
) values (
  gen_random_uuid(), 'ent-fenced-paid', 'ent-consumed-claim',
  'pgtap-key-consumed', 'reserved', statement_timestamp()
);
select is(
  (select billing_source from public.get_verified_ai_item_entitlement('ent-fenced-paid')),
  'included',
  'a consumed claim keeps the restored included retry ahead of paid credits'
);

select * from finish();
rollback;
