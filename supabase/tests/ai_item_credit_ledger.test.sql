begin;

select plan(35);

select ok(
  to_regclass('public.ai_item_allowance_periods') is not null,
  'AI-item allowance periods exist'
);
select ok(
  to_regclass('public.ai_item_credit_reservations') is not null,
  'AI-item credit reservations exist'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.ai_item_allowance_periods'::regclass),
  'allowance periods enforce RLS'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.ai_item_credit_reservations'::regclass),
  'credit reservations enforce RLS'
);

select ok(
  has_table_privilege('authenticated', 'public.ai_item_allowance_periods', 'select'),
  'authenticated sellers may read their RLS-scoped allowance periods'
);
select ok(
  has_table_privilege('authenticated', 'public.ai_item_credit_reservations', 'select'),
  'authenticated sellers may read their RLS-scoped reservations'
);
select ok(
  not has_table_privilege('authenticated', 'public.ai_item_allowance_periods', 'insert'),
  'sellers cannot forge allowance periods'
);
select ok(
  not has_table_privilege('authenticated', 'public.ai_item_allowance_periods', 'update'),
  'sellers cannot change verified period state'
);
select ok(
  not has_table_privilege('authenticated', 'public.ai_item_credit_reservations', 'insert'),
  'sellers cannot forge credit reservations'
);
select ok(
  not has_table_privilege('authenticated', 'public.ai_item_credit_reservations', 'update'),
  'sellers cannot settle or restore credits directly'
);
select ok(
  not has_table_privilege('service_role', 'public.ai_item_allowance_periods', 'insert'),
  'service role has no generic allowance-period insert authority'
);
select ok(
  not has_table_privilege('service_role', 'public.ai_item_credit_reservations', 'update'),
  'service role has no generic credit mutation authority'
);
select ok(
  has_table_privilege('service_role', 'public.ai_item_credit_reservations', 'delete'),
  'service role may remove tenant credit data during account deletion'
);
select ok(
  has_table_privilege('service_role', 'public.ai_item_allowance_periods', 'delete'),
  'service role may remove tenant periods during account deletion'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.record_verified_storekit_ai_item_period(text,text,text,timestamptz,timestamptz,text,timestamptz,integer,text,timestamptz)',
    'execute'
  ),
  'service role may record an already-verified StoreKit period through the fixed seam'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.record_verified_storekit_ai_item_period(text,text,text,timestamptz,timestamptz,text,timestamptz,integer,text,timestamptz)',
    'execute'
  ),
  'sellers cannot invoke the verified StoreKit period seam'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.authorize_ai_item_guided_correction(uuid,uuid)',
    'execute'
  ),
  'authenticated sellers may request the fixed same-item correction authorization'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.authorize_ai_item_guided_correction(uuid,uuid)',
    'execute'
  ),
  'anonymous callers cannot authorize a correction'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.regenerate_review_listing_with_credit(uuid,uuid,uuid,uuid,uuid,jsonb,text,jsonb,text,text,jsonb,numeric,jsonb,numeric,text,text,text,text,jsonb,boolean,boolean)',
    'execute'
  ),
  'authenticated sellers may atomically finish the authorized correction'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.regenerate_review_listing_with_credit(uuid,uuid,uuid,uuid,uuid,jsonb,text,jsonb,text,text,jsonb,numeric,jsonb,numeric,text,text,text,text,jsonb,boolean,boolean)',
    'execute'
  ),
  'anonymous callers cannot finish a correction'
);
select ok(
  not has_function_privilege(
    'service_role', 'private.reserve_ai_item_credit_for_pipeline_run()', 'execute'
  ),
  'service role cannot invoke the private reservation trigger helper directly'
);
select ok(
  not has_function_privilege(
    'service_role', 'private.settle_ai_item_credit(uuid)', 'execute'
  ),
  'service role cannot invoke the private settlement helper directly'
);

select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'ai_item_allowance_periods'
      and indexname = 'ai_item_allowance_periods_user_period_idx'
  ),
  'period selection is indexed by tenant and window'
);
select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'ai_item_credit_reservations'
      and indexname = 'ai_item_credit_reservations_user_state_idx'
  ),
  'tenant reservation reads are indexed'
);
select ok(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.pipeline_runs'::regclass
      and tgname = 'reserve_ai_item_credit_for_pipeline_run'
      and not tgisinternal
  ),
  'durable run creation owns the reservation trigger'
);
select ok(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.pipeline_runs'::regclass
      and tgname = 'finalize_ai_item_credit_from_pipeline_run'
      and not tgisinternal
  ),
  'durable terminal state owns settlement and restoration'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temp table ai_item_credit_test_runs (
  label text primary key,
  run_id uuid not null,
  allowance_period_id uuid,
  restored_at timestamptz
);

insert into ai_item_credit_test_runs (label, run_id)
select 'first', staged.run_id
from public.stage_pipeline_batch(
  'credit_pgtap_user',
  '11111111-1111-4111-8111-111111111111'::uuid,
  jsonb_build_array(jsonb_build_object(
    'idempotency_key', 'credit-pgtap-first',
    'source', 'single',
    'autopilot_enabled', false,
    'photo_paths', jsonb_build_array('credit_pgtap_user/pgtap/first.jpg'),
    'cost_basis', null
  )),
  100,
  100
) staged;

update ai_item_credit_test_runs state
set allowance_period_id = reservation.allowance_period_id
from public.ai_item_credit_reservations reservation
where state.label = 'first'
  and reservation.pipeline_run_id = state.run_id;

select is(
  (
    select reservation.state
    from public.ai_item_credit_reservations reservation
    join ai_item_credit_test_runs state on state.run_id = reservation.pipeline_run_id
    where state.label = 'first'
  ),
  'reserved',
  'staging reserves one credit before provider-backed work'
);
select is(
  (
    select period.source
    from public.ai_item_allowance_periods period
    join ai_item_credit_test_runs state on state.allowance_period_id = period.id
    where state.label = 'first'
  ),
  'included',
  'the first complete run uses the included first-run period'
);

update public.pipeline_runs run
set status = 'canceled',
    completed_at = statement_timestamp()
from ai_item_credit_test_runs state
where state.label = 'first'
  and run.id = state.run_id;

update ai_item_credit_test_runs state
set restored_at = reservation.restored_at
from public.ai_item_credit_reservations reservation
where state.label = 'first'
  and reservation.pipeline_run_id = state.run_id;

select is(
  (
    select reservation.state
    from public.ai_item_credit_reservations reservation
    join ai_item_credit_test_runs state on state.run_id = reservation.pipeline_run_id
    where state.label = 'first'
  ),
  'restored',
  'cancel before usable output restores the credit'
);
select ok(
  (select restored_at is not null from ai_item_credit_test_runs where label = 'first'),
  'restoration records one durable terminal timestamp'
);

update public.pipeline_runs run
set status = 'canceled'
from ai_item_credit_test_runs state
where state.label = 'first'
  and run.id = state.run_id;

select is(
  (
    select reservation.restored_at
    from public.ai_item_credit_reservations reservation
    join ai_item_credit_test_runs state on state.run_id = reservation.pipeline_run_id
    where state.label = 'first'
  ),
  (select restored_at from ai_item_credit_test_runs where label = 'first'),
  'repeated terminal delivery does not restore twice'
);

select throws_ok(
  $$
    update public.ai_item_credit_reservations reservation
    set state = 'reserved',
        restored_at = null
    from ai_item_credit_test_runs state
    where state.label = 'first'
      and reservation.pipeline_run_id = state.run_id
  $$,
  '23514',
  'Illegal AI-item credit transition: restored -> reserved',
  'restored reservations cannot move backward'
);

insert into ai_item_credit_test_runs (label, run_id)
select 'second', staged.run_id
from public.stage_pipeline_batch(
  'credit_pgtap_user',
  '22222222-2222-4222-8222-222222222222'::uuid,
  jsonb_build_array(jsonb_build_object(
    'idempotency_key', 'credit-pgtap-second',
    'source', 'single',
    'autopilot_enabled', false,
    'photo_paths', jsonb_build_array('credit_pgtap_user/pgtap/second.jpg'),
    'cost_basis', null
  )),
  100,
  100
) staged;

update ai_item_credit_test_runs state
set allowance_period_id = reservation.allowance_period_id
from public.ai_item_credit_reservations reservation
where state.label = 'second'
  and reservation.pipeline_run_id = state.run_id;

select is(
  (
    select reservation.state
    from public.ai_item_credit_reservations reservation
    join ai_item_credit_test_runs state on state.run_id = reservation.pipeline_run_id
    where state.label = 'second'
  ),
  'reserved',
  'a new logical run may reuse a restored credit'
);
select is(
  (select allowance_period_id from ai_item_credit_test_runs where label = 'second'),
  (select allowance_period_id from ai_item_credit_test_runs where label = 'first'),
  'restored usage remains in the same allowance window without a reset'
);
select is(
  (
    select count(*)::integer
    from public.ai_item_credit_reservations reservation
    join ai_item_credit_test_runs state
      on state.allowance_period_id = reservation.allowance_period_id
    where state.label = 'first'
      and reservation.state in ('reserved', 'settled')
  ),
  1,
  'only the active reservation consumes the included allowance'
);

select * from finish();
rollback;
