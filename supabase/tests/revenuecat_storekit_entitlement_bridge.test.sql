begin;

select plan(88);

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
  'rc-user-ledger',
  'rc-user-legacy',
  'rc-user-production-retry'
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
    'public.record_verified_revenuecat_ai_item_period(text,text,text,text,text,timestamptz,timestamptz,text,timestamptz,integer,text,text,timestamptz)',
    'execute'
  ),
  'service role may translate a verified provider event into the ledger'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.record_verified_revenuecat_ai_item_period(text,text,text,text,text,timestamptz,timestamptz,text,timestamptz,integer,text,text,timestamptz)',
    'execute'
  ),
  'sellers cannot call the verified provider event seam'
);
select ok(
  to_regprocedure(
    'public.record_verified_revenuecat_ai_item_period(text,text,text,text,timestamptz,timestamptz,text,timestamptz,integer,text,text,timestamptz)'
  ) is null,
  'the environment-blind period RPC signature no longer exists'
);
select ok(
  to_regprocedure(
    'public.require_revenuecat_reconciliation(text,text,text,text,text,timestamptz)'
  ) is null,
  'the environment-blind reconciliation RPC signature no longer exists'
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
    'rc-user-a', 'rc-user-a', 'PRODUCTION', 'rc-original-a:p1', 'rc-original-a',
    date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', 'active', null,
    24, 'rc-event-initial', 'INITIAL_PURCHASE', date_trunc('month', now()) + interval '1 minute'
  ),
  'an initial purchase creates one verified #168 period'
);
select is(
  (select event.environment from private.revenuecat_webhook_events event
   where event.event_id = 'rc-event-initial'),
  'PRODUCTION',
  'the signed environment is persisted with the RevenueCat event'
);
select is(
  (select event.outcome from private.revenuecat_webhook_events event
   where event.environment = 'PRODUCTION'
     and event.event_id = 'rc-event-initial'),
  'applied',
  'a production event still applies to the StoreKit allowance ledger'
);
select is(
  (select event.event_id from private.storekit_ai_item_period_events event
   where event.user_id = 'rc-user-a' and event.applied),
  'production:' || md5('rc-event-initial'),
  'downstream StoreKit idempotency includes the RevenueCat environment'
);
select is(
  (select period.state from public.ai_item_allowance_periods period
   where period.user_id = 'rc-user-a' and period.source = 'storekit'),
  'active',
  'the bridge writes the existing StoreKit ledger rather than another quota table'
);
select ok(
  not public.record_verified_revenuecat_ai_item_period(
    'rc-user-a', 'rc-user-a', 'PRODUCTION', 'rc-original-a:p1', 'rc-original-a',
    date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', 'active', null,
    24, 'rc-event-initial', 'INITIAL_PURCHASE', date_trunc('month', now()) + interval '1 minute'
  ),
  'an exact duplicate provider delivery is idempotent'
);
select throws_ok(
  $$
    select public.record_verified_revenuecat_ai_item_period(
      'rc-user-a', 'rc-user-a', 'TEST', 'rc-original-a:p1', 'rc-original-a',
      date_trunc('month', now()), date_trunc('month', now()) + interval '1 month',
      'active', null, 24, 'rc-event-invalid-environment', 'INITIAL_PURCHASE',
      date_trunc('month', now()) + interval '2 minutes'
    )
  $$,
  '22023',
  'Invalid RevenueCat environment',
  'the persisted boundary rejects an unknown environment'
);
select is(
  (select count(*)::integer from private.revenuecat_webhook_events event
   where event.event_id = 'rc-event-invalid-environment'),
  0,
  'an invalid environment creates no webhook idempotency row'
);
select throws_ok(
  $$
    select public.record_verified_revenuecat_ai_item_period(
      'rc-user-a', 'rc-user-a', null, 'rc-original-a:p1', 'rc-original-a',
      date_trunc('month', now()), date_trunc('month', now()) + interval '1 month',
      'active', null, 24, 'rc-event-missing-environment', 'INITIAL_PURCHASE',
      date_trunc('month', now()) + interval '2 minutes'
    )
  $$,
  '22023',
  'Invalid RevenueCat environment',
  'the persisted boundary rejects a missing environment'
);
select * from public.bind_revenuecat_customer(
  'rc-user-sandbox-event', 'rc-user-sandbox-event'
);
select * from public.resolve_revenuecat_customer(
  'rc-user-sandbox-event', 'rc-user-sandbox-event', 'rc-original-sandbox-event'
);
select ok(
  not public.record_verified_revenuecat_ai_item_period(
    'rc-user-sandbox-event', 'rc-user-sandbox-event', 'SANDBOX',
    'rc-original-sandbox-event:p2', 'rc-original-sandbox-event',
    date_trunc('month', now()) + interval '1 month',
    date_trunc('month', now()) + interval '2 months',
    'active', null, 24, 'rc-sandbox-new-period', 'RENEWAL',
    date_trunc('month', now()) + interval '1 month 2 minutes'
  ),
  'a sandbox event for a new period is audited without applying credit'
);
select is(
  (select count(*)::integer from public.ai_item_allowance_periods period
   where period.user_id = 'rc-user-sandbox-event'
     and period.source = 'storekit'
     and period.period_key = 'rc-original-sandbox-event:p2'),
  0,
  'a sandbox renewal cannot create a production-usable period'
);
select is(
  (select event.outcome from private.revenuecat_webhook_events event
   where event.environment = 'SANDBOX'
     and event.event_id = 'rc-sandbox-new-period'),
  'sandbox_ignored',
  'the rejected sandbox renewal remains auditable'
);
select is(
  (select count(*)::integer from private.storekit_ai_item_period_events event
   where event.event_id = 'sandbox:' || md5('rc-sandbox-new-period')),
  0,
  'a sandbox renewal never reaches StoreKit allowance persistence'
);

select * from public.bind_revenuecat_customer('rc-user-sandbox-rpc', 'rc-user-sandbox-rpc');
select * from public.resolve_revenuecat_customer(
  'rc-user-sandbox-rpc', 'rc-user-sandbox-rpc', 'rc-original-sandbox-rpc'
);
select ok(
  not public.record_verified_revenuecat_ai_item_period(
    'rc-user-sandbox-rpc', 'rc-user-sandbox-rpc', 'SANDBOX',
    'rc-original-sandbox-rpc:p1', 'rc-original-sandbox-rpc',
    date_trunc('month', now()), date_trunc('month', now()) + interval '1 month',
    'active', null, 24, 'rc-direct-sandbox', 'INITIAL_PURCHASE',
    date_trunc('month', now()) + interval '3 minutes'
  ),
  'a direct service-role sandbox RPC call cannot mint credit'
);
select is(
  (select count(*)::integer from public.ai_item_allowance_periods period
   where period.user_id = 'rc-user-sandbox-rpc'
     and period.source = 'storekit'),
  0,
  'the direct sandbox RPC leaves the shared allowance ledger unchanged'
);
select is(
  (select event.outcome from private.revenuecat_webhook_events event
   where event.environment = 'SANDBOX'
     and event.event_id = 'rc-direct-sandbox'),
  'sandbox_ignored',
  'the direct sandbox RPC denial remains auditable'
);

select * from public.bind_revenuecat_customer(
  'rc-user-sandbox-reconcile', 'rc-user-sandbox-reconcile'
);
select * from public.resolve_revenuecat_customer(
  'rc-user-sandbox-reconcile', 'rc-user-sandbox-reconcile',
  'rc-original-sandbox-reconcile'
);
select ok(
  public.record_verified_revenuecat_ai_item_period(
    'rc-user-sandbox-reconcile', 'rc-user-sandbox-reconcile', 'PRODUCTION',
    'rc-original-sandbox-reconcile:p1', 'rc-original-sandbox-reconcile',
    date_trunc('month', now()), date_trunc('month', now()) + interval '1 month',
    'active', null, 24, 'rc-sandbox-reconcile-production', 'INITIAL_PURCHASE',
    date_trunc('month', now()) + interval '1 minute'
  ),
  'the sandbox reconciliation fixture begins with verified production authority'
);
select ok(
  not public.require_revenuecat_reconciliation(
    'rc-user-sandbox-reconcile', 'rc-user-sandbox-reconcile',
    'rc-original-sandbox-reconcile', 'SANDBOX', 'rc-sandbox-product-change',
    'PRODUCT_CHANGE', date_trunc('month', now()) + interval '2 minutes'
  ),
  'a direct service-role sandbox reconciliation call is audit-only'
);
select is(
  (select binding.transition_state
   from public.revenuecat_customer_bindings binding
   where binding.user_id = 'rc-user-sandbox-reconcile'),
  'not_required',
  'sandbox reconciliation leaves the production transition flag unchanged'
);
select is(
  (select binding.lifecycle_state
   from public.revenuecat_customer_bindings binding
   where binding.user_id = 'rc-user-sandbox-reconcile'),
  'active',
  'sandbox reconciliation leaves the production lifecycle state unchanged'
);
select is(
  (select binding.last_event_id
   from public.revenuecat_customer_bindings binding
   where binding.user_id = 'rc-user-sandbox-reconcile'),
  'rc-sandbox-reconcile-production',
  'sandbox reconciliation leaves the production binding cursor unchanged'
);
select is(
  (select event.outcome
   from private.revenuecat_webhook_events event
   where event.environment = 'SANDBOX'
     and event.event_id = 'rc-sandbox-product-change'),
  'sandbox_ignored',
  'sandbox reconciliation is audited as sandbox_ignored'
);
select lives_ok(
  $$
    select public.record_verified_revenuecat_ai_item_period(
      'rc-user-sandbox-reconcile', 'rc-user-sandbox-reconcile', 'PRODUCTION',
      'rc-original-sandbox-reconcile:p2', 'rc-original-sandbox-reconcile',
      date_trunc('month', now()) + interval '1 month',
      date_trunc('month', now()) + interval '2 months',
      'active', null, 24, 'rc-sandbox-reconcile-renewal', 'RENEWAL',
      date_trunc('month', now()) + interval '1 month 1 minute'
    )
  $$,
  'a later verified production renewal remains unblocked'
);
select is(
  (select count(*)::integer
   from public.ai_item_allowance_periods period
   where period.user_id = 'rc-user-sandbox-reconcile'
     and period.source = 'storekit'
     and period.period_key = 'rc-original-sandbox-reconcile:p2'
     and period.state = 'active'),
  1,
  'the production renewal creates its verified active period'
);
select ok(
  public.record_verified_revenuecat_ai_item_period(
    'rc-user-a', 'rc-user-a', 'PRODUCTION', 'rc-original-a:p1', 'rc-original-a',
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
    'rc-user-a', 'rc-user-a', 'PRODUCTION', 'rc-original-a:p1', 'rc-original-a',
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
      'rc-user-b', 'rc-user-b', 'rc-original-a', 'PRODUCTION', 'rc-cross-tenant-reconcile',
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
      'rc-user-b', 'rc-user-a', 'rc-original-b', 'PRODUCTION', 'rc-original-user-mismatch',
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
  'rc-user-late', 'rc-user-late', 'PRODUCTION', 'rc-original-late:p1',
  'rc-original-late', date_trunc('month', now()), date_trunc('month', now()) + interval '1 month',
  'active', null, 2, 'rc-late-active', 'INITIAL_PURCHASE',
  date_trunc('month', now()) + interval '2 minutes'
);
select ok(
  public.require_revenuecat_reconciliation(
    'rc-user-late', 'rc-user-late', 'rc-original-late', 'PRODUCTION', 'rc-late-reconcile',
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
      'rc-user-late', 'rc-user-late', 'PRODUCTION', 'rc-original-late:p2',
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
      'rc-user-stripe', 'rc-user-stripe', 'PRODUCTION', 'rc-original-stripe:p1',
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
    'rc-user-stripe', 'rc-user-stripe', 'PRODUCTION', 'rc-original-stripe:p1',
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
-- The reservation below only lands while this StoreKit span actually covers
-- now. Every span in this file is anchored to date_trunc('month', now()) for
-- that reason -- now() is frozen at BEGIN, so all of them agree on one instant.
select public.record_verified_revenuecat_ai_item_period(
  'rc-user-ledger', 'rc-user-ledger', 'PRODUCTION', 'rc-original-ledger:p1',
  'rc-original-ledger', date_trunc('month', now()), date_trunc('month', now()) + interval '1 month',
  'active', null, 2, 'rc-ledger-active', 'INITIAL_PURCHASE',
  date_trunc('month', now()) + interval '1 minute'
);
select ok(
  public.require_revenuecat_reconciliation(
    'rc-user-ledger', 'rc-user-ledger', 'rc-original-ledger', 'PRODUCTION',
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

select * from public.bind_revenuecat_customer(
  'rc-user-production-retry', 'rc-user-production-retry'
);
select * from public.resolve_revenuecat_customer(
  'rc-user-production-retry', 'rc-user-production-retry',
  'rc-original-production-retry'
);
select public.record_verified_revenuecat_ai_item_period(
  'rc-user-production-retry', 'rc-user-production-retry', 'PRODUCTION',
  'rc-original-production-retry:p1', 'rc-original-production-retry',
  date_trunc('month', now()), date_trunc('month', now()) + interval '1 month',
  'active', null, 2, 'rc-production-retry-active', 'INITIAL_PURCHASE',
  date_trunc('month', now()) + interval '1 minute'
);
create temp table rc_production_retry_runs (
  sequence integer primary key,
  run_id uuid not null
);
grant select on rc_production_retry_runs to authenticated;
insert into rc_production_retry_runs (sequence, run_id)
select 1, staged.run_id
from public.stage_pipeline_batch(
  'rc-user-production-retry',
  '17300000-0000-4000-8000-000000000004'::uuid,
  jsonb_build_array(jsonb_build_object(
    'idempotency_key', 'rc-production-retry-included',
    'source', 'single',
    'autopilot_enabled', false,
    'photo_paths', jsonb_build_array('rc-user-production-retry/included.jpg'),
    'cost_basis', null
  )),
  100,
  100
) staged;
insert into rc_production_retry_runs (sequence, run_id)
select 2, staged.run_id
from public.stage_pipeline_batch(
  'rc-user-production-retry',
  '17300000-0000-4000-8000-000000000005'::uuid,
  jsonb_build_array(jsonb_build_object(
    'idempotency_key', 'rc-production-retry-storekit',
    'source', 'single',
    'autopilot_enabled', false,
    'photo_paths', jsonb_build_array('rc-user-production-retry/storekit.jpg'),
    'cost_basis', null
  )),
  100,
  100
) staged;
update public.pipeline_runs
set status = 'running',
    stage = 'pricing',
    attempt_count = 1,
    started_at = statement_timestamp(),
    last_attempted_at = statement_timestamp(),
    lease_token = '17310000-0000-4000-8000-000000000001',
    lease_expires_at = statement_timestamp() + interval '1 minute'
where id = (select run_id from rc_production_retry_runs where sequence = 2);
update public.pipeline_runs
set status = 'failed',
    failure_code = 'attempts_exhausted',
    safe_failure_message = 'The production-backed retry fixture failed.',
    completed_at = statement_timestamp(),
    lease_token = null,
    lease_expires_at = null
where id = (select run_id from rc_production_retry_runs where sequence = 2);
select is(
  (select period.source
   from rc_production_retry_runs run
   join public.ai_item_credit_reservations reservation
     on reservation.pipeline_run_id = run.run_id
   join public.ai_item_allowance_periods period
     on period.id = reservation.allowance_period_id
   where run.sequence = 2),
  'storekit',
  'the production retry fixture is backed by verified StoreKit credit'
);
select is(
  (select reservation.state
   from rc_production_retry_runs run
   join public.ai_item_credit_reservations reservation
     on reservation.pipeline_run_id = run.run_id
   where run.sequence = 2),
  'restored',
  'the production-backed failed run restores its retry reservation'
);
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"rc-user-production-retry","role":"authenticated"}',
  true
);
select is(
  public.apply_mobile_run_operation(
    (select run_id from rc_production_retry_runs where sequence = 2),
    'retry',
    '17320000-0000-4000-8000-000000000001'::uuid
  ) #>> '{status}',
  'queued',
  'a production-backed restored reservation can still reclaim for retry'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select reservation.retry_reservation_count
   from rc_production_retry_runs run
   join public.ai_item_credit_reservations reservation
     on reservation.pipeline_run_id = run.run_id
   where run.sequence = 2),
  1,
  'the production-backed retry records one reclaim'
);

-- Upgrade-state proof: this reproduces the state left by the old
-- environment-blind RevenueCat RPC, then runs the migration quarantine seam.
select * from public.bind_revenuecat_customer('rc-user-legacy', 'rc-user-legacy');
select * from public.resolve_revenuecat_customer(
  'rc-user-legacy', 'rc-user-legacy', 'rc-original-legacy'
);
select public.record_verified_storekit_ai_item_period(
  'rc-user-legacy', 'rc-original-legacy:p1', 'rc-original-legacy',
  date_trunc('month', now()), date_trunc('month', now()) + interval '1 month',
  'grace', date_trunc('month', now()) + interval '1 month 7 days', 2,
  'rc-legacy-sandbox-event', date_trunc('month', now()) + interval '1 minute'
);
insert into private.revenuecat_webhook_events (
  environment, event_id, user_id, revenuecat_app_user_id,
  original_transaction_id, event_type, event_created_at,
  payload_fingerprint, outcome
) values (
  'LEGACY_UNKNOWN', 'rc-legacy-sandbox-event', 'rc-user-legacy',
  'rc-user-legacy', 'rc-original-legacy', 'INITIAL_PURCHASE',
  date_trunc('month', now()) + interval '1 minute', md5('legacy-sandbox-payload'),
  'applied'
);
create temp table rc_legacy_runs (
  sequence integer primary key,
  run_id uuid not null
);
grant select on rc_legacy_runs to authenticated;
insert into rc_legacy_runs (sequence, run_id)
select 1, staged.run_id
from public.stage_pipeline_batch(
  'rc-user-legacy',
  '17300000-0000-4000-8000-000000000003'::uuid,
  jsonb_build_array(jsonb_build_object(
    'idempotency_key', 'rc-legacy-included',
    'source', 'single',
    'autopilot_enabled', false,
    'photo_paths', jsonb_build_array('rc-user-legacy/included.jpg'),
    'cost_basis', null
  )),
  100,
  100
) staged;
select is(
  (select entitlement.remaining_items
   from public.get_verified_ai_item_entitlement('rc-user-legacy') entitlement),
  2,
  'a pre-migration sandbox-minted grace period would grant paid credit'
);
insert into rc_legacy_runs (sequence, run_id)
select 2, staged.run_id
from public.stage_pipeline_batch(
  'rc-user-legacy',
  '17300000-0000-4000-8000-000000000006'::uuid,
  jsonb_build_array(jsonb_build_object(
    'idempotency_key', 'rc-legacy-storekit',
    'source', 'single',
    'autopilot_enabled', false,
    'photo_paths', jsonb_build_array('rc-user-legacy/storekit.jpg'),
    'cost_basis', null
  )),
  100,
  100
) staged;
update public.pipeline_runs
set status = 'running',
    stage = 'pricing',
    attempt_count = 1,
    started_at = statement_timestamp(),
    last_attempted_at = statement_timestamp(),
    lease_token = '17310000-0000-4000-8000-000000000002',
    lease_expires_at = statement_timestamp() + interval '1 minute'
where id = (select run_id from rc_legacy_runs where sequence = 2);
update public.pipeline_runs
set status = 'failed',
    failure_code = 'attempts_exhausted',
    safe_failure_message = 'The legacy-backed retry fixture failed.',
    completed_at = statement_timestamp(),
    lease_token = null,
    lease_expires_at = null
where id = (select run_id from rc_legacy_runs where sequence = 2);
select is(
  (select period.source
   from rc_legacy_runs run
   join public.ai_item_credit_reservations reservation
     on reservation.pipeline_run_id = run.run_id
   join public.ai_item_allowance_periods period
     on period.id = reservation.allowance_period_id
   where run.sequence = 2),
  'storekit',
  'the legacy retry fixture is backed by the pre-migration StoreKit period'
);
select is(
  (select reservation.state
   from rc_legacy_runs run
   join public.ai_item_credit_reservations reservation
     on reservation.pipeline_run_id = run.run_id
   where run.sequence = 2),
  'restored',
  'the legacy-backed failed run begins with a reclaimable restored reservation'
);
select is(
  private.quarantine_legacy_revenuecat_allowances(),
  1,
  'the upgrade quarantines the allowance backed by a legacy RevenueCat event'
);
select is(
  (select period.state from public.ai_item_allowance_periods period
   where period.user_id = 'rc-user-legacy'
     and period.period_key = 'rc-original-legacy:p1'),
  'ambiguous',
  'the legacy-backed allowance becomes ambiguous'
);
select is(
  (select period.grace_expires_date from public.ai_item_allowance_periods period
   where period.user_id = 'rc-user-legacy'
     and period.period_key = 'rc-original-legacy:p1'),
  null,
  'the legacy-backed allowance loses its unverified grace timestamp'
);
select is(
  (select entitlement.remaining_items
   from public.get_verified_ai_item_entitlement('rc-user-legacy') entitlement),
  0,
  'the quarantined legacy allowance cannot grant another credit'
);
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"rc-user-legacy","role":"authenticated"}',
  true
);
select is(
  public.apply_mobile_run_operation(
    (select run_id from rc_legacy_runs where sequence = 2),
    'retry',
    '17320000-0000-4000-8000-000000000002'::uuid
  ) #>> '{mobileRunOperationError,code}',
  '55000',
  'a quarantined-period-backed reservation cannot reclaim through manual retry'
);
select is(
  public.apply_mobile_run_operation(
    (select run_id from rc_legacy_runs where sequence = 2),
    'retry',
    '17320000-0000-4000-8000-000000000002'::uuid
  ) #>> '{mobileRunOperationError,message}',
  'AI-item credit allowance period is ambiguous',
  'the retry denial reports the quarantined allowance authority'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select status
   from public.pipeline_runs
   where id = (select run_id from rc_legacy_runs where sequence = 2)),
  'failed',
  'the quarantined retry leaves the failed run stopped'
);
select is(
  (select reservation.retry_reservation_count
   from rc_legacy_runs run
   join public.ai_item_credit_reservations reservation
     on reservation.pipeline_run_id = run.run_id
   where run.sequence = 2),
  0,
  'the quarantined retry leaves reconciliation counters untouched'
);
select ok(
  not public.record_verified_revenuecat_ai_item_period(
    'rc-user-legacy', 'rc-user-legacy', 'SANDBOX',
    'rc-original-legacy:p1', 'rc-original-legacy',
    date_trunc('month', now()), date_trunc('month', now()) + interval '1 month',
    'active', null, 2, 'rc-legacy-sandbox-refresh', 'RENEWAL',
    date_trunc('month', now()) + interval '2 minutes'
  ),
  'a fresh sandbox event cannot reauthorize a quarantined allowance'
);
select is(
  (select period.state from public.ai_item_allowance_periods period
   where period.user_id = 'rc-user-legacy'
     and period.period_key = 'rc-original-legacy:p1'),
  'ambiguous',
  'sandbox refresh leaves the quarantined allowance ambiguous'
);
select ok(
  public.record_verified_revenuecat_ai_item_period(
    'rc-user-legacy', 'rc-user-legacy', 'PRODUCTION',
    'rc-original-legacy:p1', 'rc-original-legacy',
    date_trunc('month', now()), date_trunc('month', now()) + interval '1 month',
    'active', null, 2, 'rc-legacy-production-refresh', 'RENEWAL',
    date_trunc('month', now()) + interval '3 minutes'
  ),
  'a fresh production event re-establishes allowance authority'
);
select is(
  (select period.state from public.ai_item_allowance_periods period
   where period.user_id = 'rc-user-legacy'
     and period.period_key = 'rc-original-legacy:p1'),
  'active',
  'the production event reactivates the same verified period'
);
select is(
  (select entitlement.remaining_items
   from public.get_verified_ai_item_entitlement('rc-user-legacy') entitlement),
  2,
  'production verification restores the quarantined allowance remainder'
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
