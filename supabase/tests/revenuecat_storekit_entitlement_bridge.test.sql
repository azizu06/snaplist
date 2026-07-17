begin;

select plan(33);

select ok(
  to_regclass('public.revenuecat_customer_bindings') is not null,
  'RevenueCat customer bindings exist'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.revenuecat_customer_bindings'::regclass),
  'RevenueCat customer bindings enforce RLS'
);
select ok(
  has_table_privilege('authenticated', 'public.revenuecat_customer_bindings', 'select'),
  'authenticated sellers may read their own provider status'
);
select ok(
  not has_table_privilege('authenticated', 'public.revenuecat_customer_bindings', 'insert'),
  'authenticated sellers cannot create provider identities'
);
select ok(
  not has_table_privilege('authenticated', 'public.revenuecat_customer_bindings', 'update'),
  'authenticated sellers cannot grant native entitlement'
);
select ok(
  not has_table_privilege('service_role', 'public.revenuecat_customer_bindings', 'insert'),
  'service role has no generic binding insert authority'
);
select ok(
  has_function_privilege('service_role', 'public.bind_revenuecat_customer(text,text)', 'execute'),
  'service role may call the narrow authenticated-customer binding seam'
);
select ok(
  not has_function_privilege('authenticated', 'public.bind_revenuecat_customer(text,text)', 'execute'),
  'sellers cannot invoke the binding seam'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.record_verified_revenuecat_ai_item_period(text,text,text,text,timestamptz,timestamptz,text,timestamptz,integer,text,text,timestamptz)',
    'execute'
  ),
  'service role may translate a verified provider event into the ledger'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.record_verified_revenuecat_ai_item_period(text,text,text,text,timestamptz,timestamptz,text,timestamptz,integer,text,text,timestamptz)',
    'execute'
  ),
  'sellers cannot call the verified provider event seam'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  (select binding.transition_state from public.bind_revenuecat_customer('rc-user-a', 'rc-user-a') binding),
  'not_required',
  'a seller without Stripe state binds without reconciliation'
);
select is(
  (select customer.user_id from public.resolve_revenuecat_customer('rc-user-a', 'rc-user-a', 'rc-original-a') customer),
  'rc-user-a',
  'verified provider identity resolves only through the server binding'
);
select ok(
  public.record_verified_revenuecat_ai_item_period(
    'rc-user-a', 'rc-user-a', 'rc-original-a:2026-07-01', 'rc-original-a',
    '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', 'active', null,
    24, 'rc-event-initial', 'INITIAL_PURCHASE', '2026-07-01T00:01:00Z'
  ),
  'an initial purchase creates one verified #168 period'
);
select is(
  (select period.state from public.ai_item_allowance_periods period
   where period.user_id = 'rc-user-a' and period.source = 'storekit'),
  'active',
  'the bridge writes the existing StoreKit ledger rather than another quota table'
);
select ok(
  not public.record_verified_revenuecat_ai_item_period(
    'rc-user-a', 'rc-user-a', 'rc-original-a:2026-07-01', 'rc-original-a',
    '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', 'active', null,
    24, 'rc-event-initial', 'INITIAL_PURCHASE', '2026-07-01T00:01:00Z'
  ),
  'an exact duplicate provider delivery is idempotent'
);
select ok(
  public.record_verified_revenuecat_ai_item_period(
    'rc-user-a', 'rc-user-a', 'rc-original-a:2026-07-01', 'rc-original-a',
    '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', 'grace', '2026-08-08T00:00:00Z',
    24, 'rc-event-grace', 'BILLING_ISSUE', '2026-08-01T00:01:00Z'
  ),
  'verified grace advances the same period without resetting allowance'
);
select is(
  (select count(*)::integer from public.ai_item_allowance_periods period
   where period.user_id = 'rc-user-a' and period.source = 'storekit'),
  1,
  'grace does not stack another monthly period'
);
select ok(
  not public.record_verified_revenuecat_ai_item_period(
    'rc-user-a', 'rc-user-a', 'rc-original-a:2026-07-01', 'rc-original-a',
    '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', 'expired', null,
    24, 'rc-event-late', 'EXPIRATION', '2026-07-31T23:59:00Z'
  ),
  'late out-of-order lifecycle delivery cannot roll state backward'
);
select is(
  (select period.state from public.ai_item_allowance_periods period
   where period.user_id = 'rc-user-a' and period.source = 'storekit'),
  'grace',
  'the later verified grace state remains authoritative'
);
select public.upsert_billing_subscription(
  'rc-user-a', 'cus_rc_conflict', 'sub_rc_conflict', 'active',
  statement_timestamp() + interval '30 days', statement_timestamp()
);
select is(
  (select binding.transition_state
   from public.bind_revenuecat_customer('rc-user-a', 'rc-user-a') binding),
  'required',
  'a later current Stripe source re-enters explicit reconciliation'
);
select is(
  (select period.state from public.ai_item_allowance_periods period
   where period.user_id = 'rc-user-a' and period.source = 'storekit'),
  'ambiguous',
  'source conflict blocks the existing StoreKit period before run reservation'
);
select * from public.bind_revenuecat_customer('rc-user-b', 'rc-user-b');
select throws_ok(
  $$ select * from public.resolve_revenuecat_customer('rc-user-b', 'rc-user-b', 'rc-original-a') $$,
  '23514',
  'RevenueCat original transaction is bound to another tenant',
  'cross-account restore cannot claim another tenant original transaction'
);
select throws_ok(
  $$
    select public.require_revenuecat_reconciliation(
      'rc-user-b', 'rc-original-a', 'rc-cross-tenant-reconcile',
      'PRODUCT_CHANGE', '2026-08-02T00:00:00Z'
    )
  $$,
  '23514',
  'RevenueCat reconciliation identity crosses tenant bindings',
  'an ambiguous lifecycle event cannot reconcile across tenant identities'
);

select public.upsert_billing_subscription(
  'rc-user-stripe', 'cus_rc_stripe', 'sub_rc_stripe', 'active',
  statement_timestamp() + interval '30 days', statement_timestamp()
);
select is(
  (select binding.transition_state from public.bind_revenuecat_customer('rc-user-stripe', 'rc-user-stripe') binding),
  'required',
  'current legacy Stripe state requires explicit source reconciliation'
);
select is(
  (select binding.legacy_stripe_status from public.revenuecat_customer_bindings binding
   where binding.user_id = 'rc-user-stripe'),
  'active',
  'legacy Stripe status remains visibly distinct on the native binding'
);
select * from public.resolve_revenuecat_customer(
  'rc-user-stripe', 'rc-user-stripe', 'rc-original-stripe'
);
select throws_ok(
  $$
    select public.record_verified_revenuecat_ai_item_period(
      'rc-user-stripe', 'rc-user-stripe', 'rc-original-stripe:2026-07-01',
      'rc-original-stripe', '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z',
      'active', null, 24, 'rc-stripe-before-reconcile', 'INITIAL_PURCHASE',
      '2026-07-01T00:01:00Z'
    )
  $$,
  '23514',
  'Billing-source reconciliation is required',
  'verified native events cannot stack with an unreconciled Stripe source'
);
select ok(
  public.reconcile_revenuecat_billing_source(
    'rc-user-stripe', 'rc-original-stripe'
  ),
  'the server must explicitly reconcile the verified billing identity'
);
select ok(
  public.record_verified_revenuecat_ai_item_period(
    'rc-user-stripe', 'rc-user-stripe', 'rc-original-stripe:2026-07-01',
    'rc-original-stripe', '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z',
    'active', null, 24, 'rc-stripe-after-reconcile', 'INITIAL_PURCHASE',
    '2026-07-01T00:01:00Z'
  ),
  'verified native allowance starts only after explicit reconciliation'
);

select * from public.bind_revenuecat_customer('rc-user-ledger', 'rc-user-ledger');
select * from public.resolve_revenuecat_customer(
  'rc-user-ledger', 'rc-user-ledger', 'rc-original-ledger'
);
select public.record_verified_revenuecat_ai_item_period(
  'rc-user-ledger', 'rc-user-ledger', 'rc-original-ledger:2026-07-01',
  'rc-original-ledger', '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z',
  'active', null, 2, 'rc-ledger-active', 'INITIAL_PURCHASE',
  '2026-07-01T00:01:00Z'
);
create temp table rc_bridge_runs (
  sequence integer primary key,
  run_id uuid not null
);
insert into rc_bridge_runs (sequence, run_id)
select 1, staged.run_id
from public.stage_pipeline_batch(
  'rc-user-ledger',
  '17300000-0000-4000-8000-000000000001'::uuid,
  jsonb_build_array(jsonb_build_object(
    'idempotency_key', 'rc-ledger-first',
    'source', 'single',
    'autopilot_enabled', false,
    'photo_paths', jsonb_build_array('rc-user-ledger/first.jpg'),
    'cost_basis', null
  )),
  100,
  100
) staged;
insert into rc_bridge_runs (sequence, run_id)
select 2, staged.run_id
from public.stage_pipeline_batch(
  'rc-user-ledger',
  '17300000-0000-4000-8000-000000000002'::uuid,
  jsonb_build_array(jsonb_build_object(
    'idempotency_key', 'rc-ledger-second',
    'source', 'single',
    'autopilot_enabled', false,
    'photo_paths', jsonb_build_array('rc-user-ledger/second.jpg'),
    'cost_basis', null
  )),
  100,
  100
) staged;
select is(
  (select period.source
   from rc_bridge_runs run
   join public.ai_item_credit_reservations reservation
     on reservation.pipeline_run_id = run.run_id
   join public.ai_item_allowance_periods period
     on period.id = reservation.allowance_period_id
   where run.sequence = 1),
  'included',
  'the first complete AI item still consumes the one included allowance'
);
select is(
  (select period.source
   from rc_bridge_runs run
   join public.ai_item_credit_reservations reservation
     on reservation.pipeline_run_id = run.run_id
   join public.ai_item_allowance_periods period
     on period.id = reservation.allowance_period_id
   where run.sequence = 2),
  'storekit',
  'run two gates at #168 reservation time and uses the verified StoreKit period'
);
select is(
  (select entitlement.remaining_items
   from public.get_verified_ai_item_entitlement('rc-user-ledger') entitlement),
  1,
  'the verified status reads the same monthly ledger without stacking credits'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"rc-user-a","role":"authenticated"}',
  true
);
select is(
  (select count(*)::integer from public.revenuecat_customer_bindings
   where user_id = 'rc-user-a'),
  1,
  'the authenticated tenant can read its own provider binding'
);
select is(
  (select count(*)::integer from public.revenuecat_customer_bindings
   where user_id = 'rc-user-b'),
  0,
  'RLS hides another tenant provider binding'
);

select * from finish();
rollback;
