begin;

select plan(45);

-- Issue #524 fences the included first AI run by physical device, so every
-- non-guest tenant here needs the reserved claim a real redemption would have
-- produced before it can stage a run.
insert into public.included_offer_device_claims
  (claim_id, user_id, idempotency_key, app_attest_key_id, state)
select
  gen_random_uuid(),
  tenant,
  gen_random_uuid()::text,
  'pgtap-key-' || tenant,
  'reserved'
from unnest(array[
  'rc-user-ledger'
]) as tenant;

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
select has_trigger(
  'public',
  'subscriptions',
  'subscriptions_enforce_revenuecat_stripe_conflict',
  'Stripe lifecycle writes immediately enforce the non-stacking bridge'
);
select ok(
  not has_function_privilege(
    'service_role',
    'private.enforce_revenuecat_stripe_conflict()',
    'execute'
  ),
  'the Stripe conflict trigger is not a directly callable service capability'
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
    'rc-user-a', 'rc-user-a', 'rc-original-a:p1', 'rc-original-a',
    date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', 'active', null,
    24, 'rc-event-initial', 'INITIAL_PURCHASE', date_trunc('month', now()) + interval '1 minute'
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
    'rc-user-a', 'rc-user-a', 'rc-original-a:p1', 'rc-original-a',
    date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', 'active', null,
    24, 'rc-event-initial', 'INITIAL_PURCHASE', date_trunc('month', now()) + interval '1 minute'
  ),
  'an exact duplicate provider delivery is idempotent'
);
select ok(
  public.record_verified_revenuecat_ai_item_period(
    'rc-user-a', 'rc-user-a', 'rc-original-a:p1', 'rc-original-a',
    date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', 'grace', date_trunc('month', now()) + interval '1 month 7 days',
    24, 'rc-event-grace', 'BILLING_ISSUE', date_trunc('month', now()) + interval '1 month 1 minute'
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
    'rc-user-a', 'rc-user-a', 'rc-original-a:p1', 'rc-original-a',
    date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', 'expired', null,
    24, 'rc-event-late', 'EXPIRATION', date_trunc('month', now()) + interval '1 month' - interval '1 minute'
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
  $$ select * from public.resolve_revenuecat_customer('rc-user-b', 'rc-user-a', 'rc-original-b') $$,
  '23514',
  'RevenueCat original App User ID conflicts with the customer binding',
  'a signed event cannot select a tenant when its original App User ID disagrees'
);
select throws_ok(
  $$
    select public.require_revenuecat_reconciliation(
      'rc-user-b', 'rc-user-b', 'rc-original-a', 'rc-cross-tenant-reconcile',
      'PRODUCT_CHANGE', date_trunc('month', now()) + interval '1 month 1 day'
    )
  $$,
  '23514',
  'RevenueCat reconciliation identity crosses tenant bindings',
  'an ambiguous lifecycle event cannot reconcile across tenant identities'
);
select throws_ok(
  $$
    select public.require_revenuecat_reconciliation(
      'rc-user-b', 'rc-user-a', 'rc-original-b', 'rc-original-user-mismatch',
      'PRODUCT_CHANGE', date_trunc('month', now()) + interval '1 month 1 day'
    )
  $$,
  '23514',
  'RevenueCat original App User ID conflicts with the customer binding',
  'reconciliation cannot ignore a mismatched original App User ID'
);

select * from public.bind_revenuecat_customer('rc-user-late', 'rc-user-late');
select * from public.resolve_revenuecat_customer(
  'rc-user-late', 'rc-user-late', 'rc-original-late'
);
select public.record_verified_revenuecat_ai_item_period(
  'rc-user-late', 'rc-user-late', 'rc-original-late:p1',
  'rc-original-late', date_trunc('month', now()), date_trunc('month', now()) + interval '1 month',
  'active', null, 2, 'rc-late-active', 'INITIAL_PURCHASE',
  date_trunc('month', now()) + interval '2 minutes'
);
select ok(
  public.require_revenuecat_reconciliation(
    'rc-user-late', 'rc-user-late', 'rc-original-late', 'rc-late-reconcile',
    'PRODUCT_CHANGE', date_trunc('month', now()) + interval '1 minute'
  ),
  'a late ambiguous event is recorded for explicit reconciliation'
);
select is(
  (select binding.transition_state from public.revenuecat_customer_bindings binding
   where binding.user_id = 'rc-user-late'),
  'required',
  'late ambiguity blocks any entitlement advance until reconciliation'
);
select is(
  (select period.state from public.ai_item_allowance_periods period
   where period.user_id = 'rc-user-late' and period.source = 'storekit'),
  'active',
  'late ambiguity preserves the last verified period remainder'
);
select throws_ok(
  $$
    select public.record_verified_revenuecat_ai_item_period(
      'rc-user-late', 'rc-user-late', 'rc-original-late:p2',
      'rc-original-late', date_trunc('month', now()) + interval '1 month', date_trunc('month', now()) + interval '2 months',
      'active', null, 2, 'rc-late-renewal', 'RENEWAL', date_trunc('month', now()) + interval '1 month 1 minute'
    )
  $$,
  '23514',
  'Billing-source reconciliation is required',
  'an ambiguous event cannot advance the allowance to a new period'
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
      'rc-user-stripe', 'rc-user-stripe', 'rc-original-stripe:p1',
      'rc-original-stripe', date_trunc('month', now()), date_trunc('month', now()) + interval '1 month',
      'active', null, 24, 'rc-stripe-before-reconcile', 'INITIAL_PURCHASE',
      date_trunc('month', now()) + interval '1 minute'
    )
  $$,
  '23514',
  'Billing-source reconciliation is required',
  'verified native events cannot stack with an unreconciled Stripe source'
);
select ok(
  not public.reconcile_revenuecat_billing_source(
    'rc-user-stripe', 'rc-original-stripe'
  ),
  'reconciliation cannot succeed while the verified Stripe mirror is current'
);
select public.upsert_billing_subscription(
  'rc-user-stripe', 'cus_rc_stripe', 'sub_rc_stripe', 'canceled',
  statement_timestamp() - interval '1 day', statement_timestamp() + interval '1 second'
);
select * from public.bind_revenuecat_customer('rc-user-stripe', 'rc-user-stripe');
select ok(
  public.reconcile_revenuecat_billing_source(
    'rc-user-stripe', 'rc-original-stripe'
  ),
  'the server must explicitly reconcile the verified billing identity'
);
select ok(
  public.record_verified_revenuecat_ai_item_period(
    'rc-user-stripe', 'rc-user-stripe', 'rc-original-stripe:p1',
    'rc-original-stripe', date_trunc('month', now()), date_trunc('month', now()) + interval '1 month',
    'active', null, 24, 'rc-stripe-after-reconcile', 'INITIAL_PURCHASE',
    date_trunc('month', now()) + interval '1 minute'
  ),
  'verified native allowance starts only after explicit reconciliation'
);
select public.upsert_billing_subscription(
  'rc-user-stripe', 'cus_rc_stripe', 'sub_rc_stripe', 'active',
  statement_timestamp() + interval '30 days', statement_timestamp() + interval '2 seconds'
);
select is(
  (select binding.transition_state from public.revenuecat_customer_bindings binding
   where binding.user_id = 'rc-user-stripe'),
  'required',
  'a Stripe lifecycle update immediately re-enters conflict after reconciliation'
);
select is(
  (select period.state from public.ai_item_allowance_periods period
   where period.user_id = 'rc-user-stripe' and period.source = 'storekit'),
  'ambiguous',
  'later Stripe reactivation invalidates StoreKit reservation authority'
);

select * from public.bind_revenuecat_customer('rc-user-ledger', 'rc-user-ledger');
select * from public.resolve_revenuecat_customer(
  'rc-user-ledger', 'rc-user-ledger', 'rc-original-ledger'
);
select public.record_verified_revenuecat_ai_item_period(
  'rc-user-ledger', 'rc-user-ledger', 'rc-original-ledger:p1',
  'rc-original-ledger', date_trunc('month', now()), date_trunc('month', now()) + interval '1 month',
  'active', null, 2, 'rc-ledger-active', 'INITIAL_PURCHASE',
  date_trunc('month', now()) + interval '1 minute'
);
select ok(
  public.require_revenuecat_reconciliation(
    'rc-user-ledger', 'rc-user-ledger', 'rc-original-ledger',
    'rc-ledger-ambiguous', 'PRODUCT_CHANGE', date_trunc('month', now()) + interval '30 seconds'
  ),
  'ambiguous delivery preserves the verified ledger while blocking period advance'
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
