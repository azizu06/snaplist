begin;

select plan(28);

select extensions.ok(
  to_regclass('private.mobile_run_operation_replays') is not null,
  'mobile run replay receipts stay in the private schema'
);
select extensions.has_column(
  'private',
  'mobile_run_operation_replays',
  'requested_run_id',
  'replay receipts preserve untrusted requested target identity separately'
);
select extensions.ok(
  (
    select column_info.is_nullable = 'NO'
    from information_schema.columns column_info
    where column_info.table_schema = 'private'
      and column_info.table_name = 'mobile_run_operation_replays'
      and column_info.column_name = 'run_id'
  ),
  'durable receipts require a verified tenant-owned run identity'
);
select extensions.has_function(
  'public',
  'apply_mobile_run_operation',
  array['uuid', 'text', 'uuid'],
  'one authenticated mobile run operation wrapper exists'
);
select extensions.ok(
  has_function_privilege(
    'authenticated',
    'public.apply_mobile_run_operation(uuid,text,uuid)',
    'execute'
  ),
  'authenticated sellers may invoke the fixed wrapper'
);
select extensions.ok(
  not has_function_privilege(
    'anon',
    'public.apply_mobile_run_operation(uuid,text,uuid)',
    'execute'
  ),
  'anonymous callers cannot mutate a durable run'
);
select extensions.ok(
  not has_table_privilege(
    'authenticated',
    'private.mobile_run_operation_replays',
    'select'
  ),
  'sellers cannot read private replay receipts'
);

insert into public.items (id, user_id, photos)
values
  ('24110000-0000-4000-8000-000000000001', 'mobile-run-a', array['mobile-run-a/cancel.jpg']),
  ('24110000-0000-4000-8000-000000000002', 'mobile-run-a', array['mobile-run-a/retry.jpg']),
  ('24110000-0000-4000-8000-000000000003', 'mobile-run-b', array['mobile-run-b/foreign.jpg']),
  ('24110000-0000-4000-8000-000000000004', 'mobile-run-a', array['mobile-run-a/restored.jpg']);

insert into public.pipeline_runs (id, user_id, item_id, idempotency_key)
values
  ('24120000-0000-4000-8000-000000000001', 'mobile-run-a', '24110000-0000-4000-8000-000000000001', 'mobile-cancel'),
  ('24120000-0000-4000-8000-000000000002', 'mobile-run-a', '24110000-0000-4000-8000-000000000002', 'mobile-retry'),
  ('24120000-0000-4000-8000-000000000003', 'mobile-run-b', '24110000-0000-4000-8000-000000000003', 'mobile-foreign'),
  ('24120000-0000-4000-8000-000000000004', 'mobile-run-a', '24110000-0000-4000-8000-000000000004', 'mobile-restored');

update public.pipeline_runs
set status = 'running',
    stage = 'pricing',
    attempt_count = 1,
    started_at = statement_timestamp(),
    last_attempted_at = statement_timestamp(),
    lease_token = '24130000-0000-4000-8000-000000000001',
    lease_expires_at = statement_timestamp() + interval '1 minute'
where id = '24120000-0000-4000-8000-000000000002';

update public.pipeline_runs
set status = 'running',
    stage = 'pricing',
    attempt_count = 1,
    started_at = statement_timestamp(),
    last_attempted_at = statement_timestamp(),
    lease_token = '24130000-0000-4000-8000-000000000003',
    lease_expires_at = statement_timestamp() + interval '1 minute'
where id = '24120000-0000-4000-8000-000000000004';
update public.pipeline_runs
set status = 'failed',
    failure_code = 'attempts_exhausted',
    safe_failure_message = 'The credited attempt failed.',
    completed_at = statement_timestamp(),
    lease_token = null,
    lease_expires_at = null
where id = '24120000-0000-4000-8000-000000000004';

insert into public.ai_item_allowance_periods (
  id,
  user_id,
  source,
  period_key,
  period_start,
  expires_date,
  state,
  allowance
) values (
  '24150000-0000-4000-8000-000000000001',
  'mobile-run-a',
  'included',
  'included-first-run',
  statement_timestamp() - interval '1 day',
  statement_timestamp() + interval '1 year',
  'active',
  1
);
insert into public.ai_item_credit_reservations (
  user_id,
  pipeline_run_id,
  item_id,
  allowance_period_id,
  logical_run_key,
  photo_set_fingerprint,
  state,
  restored_at
) values (
  'mobile-run-a',
  '24120000-0000-4000-8000-000000000004',
  '24110000-0000-4000-8000-000000000004',
  '24150000-0000-4000-8000-000000000001',
  'mobile-restored',
  repeat('0', 64),
  'restored',
  statement_timestamp()
);
update public.pipeline_runs
set status = 'failed',
    failure_code = 'attempts_exhausted',
    safe_failure_message = 'The first attempt failed.',
    completed_at = statement_timestamp(),
    lease_token = null,
    lease_expires_at = null
where id = '24120000-0000-4000-8000-000000000002';

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"mobile-run-a","role":"authenticated"}',
  true
);

select extensions.is(
  public.apply_mobile_run_operation(
    '24120000-0000-4000-8000-000000000001',
    'cancel',
    '24140000-0000-4000-8000-000000000001'
  ) #>> '{status}',
  'canceled',
  'the first cancel applies through #161'
);

reset role;
select extensions.is(
  (
    select replay.run_id::text
    from private.mobile_run_operation_replays replay
    where replay.user_id = 'mobile-run-a'
      and replay.idempotency_key = '24140000-0000-4000-8000-000000000001'
  ),
  '24120000-0000-4000-8000-000000000001',
  'a successful receipt records the verified tenant-owned run'
);
set local role authenticated;
select extensions.is(
  public.apply_mobile_run_operation(
    '24120000-0000-4000-8000-000000000001',
    'cancel',
    '24140000-0000-4000-8000-000000000001'
  ) #>> '{status}',
  'canceled',
  'an immediate cancel replay returns the stored receipt'
);

reset role;
update public.pipeline_runs
set status = 'queued', completed_at = null
where id = '24120000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"mobile-run-a","role":"authenticated"}',
  true
);
select public.apply_mobile_run_operation(
  '24120000-0000-4000-8000-000000000001',
  'cancel',
  '24140000-0000-4000-8000-000000000001'
);
select extensions.is(
  (select status from public.pipeline_runs where id = '24120000-0000-4000-8000-000000000001'),
  'queued',
  'a delayed cancel replay cannot cancel later work'
);
select extensions.is(
  public.apply_mobile_run_operation(
    '24120000-0000-4000-8000-000000000001',
    'cancel',
    '24140000-0000-4000-8000-000000000002'
  ) #>> '{status}',
  'canceled',
  'a new cancel intent can apply to the later state'
);

select extensions.is(
  public.apply_mobile_run_operation(
    '24120000-0000-4000-8000-000000000002',
    'cancel',
    '24140000-0000-4000-8000-000000000007'
  ) #>> '{mobileRunOperationError,code}',
  '55000',
  'an illegal cancel binds its key to a stable rejection receipt'
);

select extensions.is(
  public.apply_mobile_run_operation(
    '24120000-0000-4000-8000-000000000002',
    'retry',
    '24140000-0000-4000-8000-000000000003'
  ) #>> '{status}',
  'queued',
  'the first retry applies through #161'
);
select extensions.is(
  public.apply_mobile_run_operation(
    '24120000-0000-4000-8000-000000000002',
    'cancel',
    '24140000-0000-4000-8000-000000000007'
  ) #>> '{mobileRunOperationError,code}',
  '55000',
  'a delayed rejected cancel replay returns the original rejection'
);
select extensions.is(
  (select status from public.pipeline_runs where id = '24120000-0000-4000-8000-000000000002'),
  'queued',
  'a delayed rejected cancel replay cannot cancel later work'
);

reset role;
update public.pipeline_runs
set status = 'running',
    stage = 'pricing',
    attempt_count = attempt_count + 1,
    started_at = statement_timestamp(),
    last_attempted_at = statement_timestamp(),
    lease_token = '24130000-0000-4000-8000-000000000002',
    lease_expires_at = statement_timestamp() + interval '1 minute'
where id = '24120000-0000-4000-8000-000000000002';
update public.pipeline_runs
set status = 'failed',
    failure_code = 'attempts_exhausted',
    safe_failure_message = 'A later attempt failed.',
    completed_at = statement_timestamp(),
    lease_token = null,
    lease_expires_at = null
where id = '24120000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"mobile-run-a","role":"authenticated"}',
  true
);
select extensions.is(
  public.apply_mobile_run_operation(
    '24120000-0000-4000-8000-000000000002',
    'retry',
    '24140000-0000-4000-8000-000000000003'
  ) #>> '{status}',
  'queued',
  'a delayed retry replay returns the original receipt'
);
select extensions.is(
  (select status from public.pipeline_runs where id = '24120000-0000-4000-8000-000000000002'),
  'failed',
  'a delayed retry replay cannot requeue a later failure'
);
select extensions.is(
  public.apply_mobile_run_operation(
    '24120000-0000-4000-8000-000000000002',
    'retry',
    '24140000-0000-4000-8000-000000000004'
  ) #>> '{status}',
  'queued',
  'a new retry intent can apply to the later failure'
);

select extensions.throws_ok(
  $$select public.apply_mobile_run_operation(
    '24120000-0000-4000-8000-000000000002',
    'cancel',
    '24140000-0000-4000-8000-000000000001'
  )$$,
  '23514',
  'The Idempotency-Key is already bound to another run operation',
  'one key cannot be rebound to a different operation or run'
);

select extensions.is(
  public.apply_mobile_run_operation(
    '24120000-0000-4000-8000-000000000004',
    'retry',
    '24140000-0000-4000-8000-000000000006'
  ) #>> '{status}',
  'queued',
  'the mobile seam composes with #278 restored-credit reclaim'
);
select extensions.is(
  (
    select reservation.retry_reservation_count
    from public.ai_item_credit_reservations reservation
    where reservation.pipeline_run_id = '24120000-0000-4000-8000-000000000004'
  ),
  1,
  '#278 remains the authority that records the manual retry reclaim'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"mobile-run-b","role":"authenticated"}',
  true
);
select extensions.is(
  public.apply_mobile_run_operation(
    '24120000-0000-4000-8000-000000000002',
    'retry',
    '24140000-0000-4000-8000-000000000005'
  ) #>> '{mobileRunOperationError,code}',
  'P0002',
  'another tenant cannot mutate the seller run'
);

reset role;

select extensions.is(
  (
    select count(*)::integer
    from private.mobile_run_operation_replays replay
    where replay.user_id = 'mobile-run-b'
      and replay.idempotency_key = '24140000-0000-4000-8000-000000000005'
  ),
  0,
  'a foreign target leaves no private replay receipt'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"mobile-run-a","role":"authenticated"}',
  true
);
select extensions.is(
  public.apply_mobile_run_operation(
    '24120000-0000-4000-8000-000000000009',
    'retry',
    '24140000-0000-4000-8000-000000000008'
  ) #>> '{mobileRunOperationError,code}',
  'P0002',
  'a genuinely absent target returns the tenant-safe missing-run receipt'
);
select extensions.is(
  public.apply_mobile_run_operation(
    '24120000-0000-4000-8000-000000000009',
    'retry',
    '24140000-0000-4000-8000-000000000008'
  ) #>> '{mobileRunOperationError,code}',
  'P0002',
  'an absent-target replay returns the same tenant-safe result'
);

reset role;

select extensions.is(
  (
    select count(*)::integer
    from private.mobile_run_operation_replays replay
    where replay.user_id = 'mobile-run-a'
      and replay.idempotency_key = '24140000-0000-4000-8000-000000000008'
      and replay.requested_run_id = '24120000-0000-4000-8000-000000000009'
      and replay.run_id is null
  ),
  0,
  'an absent target leaves no private replay receipt'
);

select extensions.is(
  (
    select count(*)::integer
    from private.mobile_run_operation_replays
    where user_id = 'mobile-run-a'
  ),
  6,
  'only six verified owner-bound intents were recorded across success and stable rejection paths'
);

select * from finish();
rollback;
