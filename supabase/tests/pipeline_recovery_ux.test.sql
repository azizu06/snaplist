begin;

select plan(22);

select extensions.has_column(
  'public',
  'notifications',
  'source_pipeline_run_id',
  'notifications identify their durable pipeline source'
);
select extensions.has_function(
  'public',
  'retry_pipeline_run',
  array['uuid'],
  'tenant retry transition exists'
);
select extensions.has_function(
  'public',
  'cancel_pipeline_run',
  array['uuid'],
  'tenant cancel transition exists'
);

insert into public.items (id, user_id, photos)
values
  ('71000000-0000-4000-8000-000000000001', 'pipeline-recovery-a', array['pipeline-recovery-a/ready.jpg']),
  ('71000000-0000-4000-8000-000000000002', 'pipeline-recovery-a', array['pipeline-recovery-a/failed.jpg']),
  ('71000000-0000-4000-8000-000000000003', 'pipeline-recovery-a', array['pipeline-recovery-a/cancel.jpg']),
  ('71000000-0000-4000-8000-000000000004', 'pipeline-recovery-b', array['pipeline-recovery-b/foreign.jpg']);

insert into public.pipeline_runs (id, user_id, item_id, idempotency_key)
values
  ('72000000-0000-4000-8000-000000000001', 'pipeline-recovery-a', '71000000-0000-4000-8000-000000000001', 'recovery-ready'),
  ('72000000-0000-4000-8000-000000000002', 'pipeline-recovery-a', '71000000-0000-4000-8000-000000000002', 'recovery-failed'),
  ('72000000-0000-4000-8000-000000000003', 'pipeline-recovery-a', '71000000-0000-4000-8000-000000000003', 'recovery-cancel'),
  ('72000000-0000-4000-8000-000000000004', 'pipeline-recovery-b', '71000000-0000-4000-8000-000000000004', 'recovery-foreign');

-- A durable success emits one listing_ready row, even if a later harmless
-- update re-enters the trigger.
update public.pipeline_runs
set status = 'running',
    stage = 'identifying',
    attempt_count = 1,
    started_at = statement_timestamp(),
    last_attempted_at = statement_timestamp(),
    lease_token = '73000000-0000-4000-8000-000000000001',
    lease_expires_at = statement_timestamp() + interval '1 minute'
where id = '72000000-0000-4000-8000-000000000001';

update public.pipeline_runs
set status = 'succeeded',
    stage = 'completed',
    completed_at = statement_timestamp(),
    lease_token = null,
    lease_expires_at = null
where id = '72000000-0000-4000-8000-000000000001';

update public.pipeline_runs
set updated_at = statement_timestamp()
where id = '72000000-0000-4000-8000-000000000001';

select extensions.is(
  (
    select count(*)::integer
    from public.notifications
    where source_pipeline_run_id = '72000000-0000-4000-8000-000000000001'
      and kind = 'listing_ready'
  ),
  1,
  'durable success emits exactly one listing_ready notification'
);
select extensions.is(
  (
    select href
    from public.notifications
    where source_pipeline_run_id = '72000000-0000-4000-8000-000000000001'
  ),
  '/review/71000000-0000-4000-8000-000000000001?ready=1',
  'listing_ready links to the normal review surface'
);
select extensions.ok(
  (
    select body
    from public.notifications
    where source_pipeline_run_id = '72000000-0000-4000-8000-000000000001'
  ) like '%before you publish to eBay%',
  'ready copy distinguishes draft preparation from marketplace publishing'
);

-- A transient retry never emits a failure notification. Terminal exhaustion
-- does, and a later manual retry/failure cycle cannot duplicate the row.
update public.pipeline_runs
set status = 'running',
    stage = 'identifying',
    attempt_count = 1,
    started_at = statement_timestamp(),
    last_attempted_at = statement_timestamp(),
    lease_token = '73000000-0000-4000-8000-000000000002',
    lease_expires_at = statement_timestamp() + interval '1 minute'
where id = '72000000-0000-4000-8000-000000000002';

update public.pipeline_runs
set status = 'retrying',
    failure_code = 'provider_timeout',
    safe_failure_message = 'SnapList will retry this listing.',
    next_attempt_at = statement_timestamp(),
    lease_token = null,
    lease_expires_at = null
where id = '72000000-0000-4000-8000-000000000002';

select extensions.is(
  (
    select count(*)::integer
    from public.notifications
    where source_pipeline_run_id = '72000000-0000-4000-8000-000000000002'
  ),
  0,
  'a transient retry does not notify the seller'
);

update public.pipeline_runs
set status = 'running',
    attempt_count = 2,
    last_attempted_at = statement_timestamp(),
    next_attempt_at = null,
    lease_token = '73000000-0000-4000-8000-000000000003',
    lease_expires_at = statement_timestamp() + interval '1 minute'
where id = '72000000-0000-4000-8000-000000000002';

update public.pipeline_runs
set status = 'failed',
    failure_code = 'attempts_exhausted',
    safe_failure_message = 'SnapList could not finish this listing after several attempts.',
    completed_at = statement_timestamp(),
    lease_token = null,
    lease_expires_at = null
where id = '72000000-0000-4000-8000-000000000002';

select extensions.is(
  (
    select count(*)::integer
    from public.notifications
    where source_pipeline_run_id = '72000000-0000-4000-8000-000000000002'
      and kind = 'pipeline_failed'
  ),
  1,
  'terminal failure emits exactly one pipeline_failed notification'
);
select extensions.ok(
  (
    select body
    from public.notifications
    where source_pipeline_run_id = '72000000-0000-4000-8000-000000000002'
  ) like '%try again%',
  'terminal failure notification exposes a safe retry path'
);

-- Tenant A may cancel its queued run. The operation is idempotent and leaves
-- the item/photo reference intact; cleanup is not an implicit cancel side effect.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"pipeline-recovery-a","role":"authenticated"}',
  true
);

select extensions.is(
  public.cancel_pipeline_run('72000000-0000-4000-8000-000000000003') #>> '{status}',
  'canceled',
  'the owning tenant can cancel queued work'
);
select extensions.is(
  public.cancel_pipeline_run('72000000-0000-4000-8000-000000000003') #>> '{status}',
  'canceled',
  'cancel is idempotent'
);
select extensions.is(
  (
    select photos[1]
    from public.items
    where id = '71000000-0000-4000-8000-000000000003'
  ),
  'pipeline-recovery-a/cancel.jpg',
  'cancel preserves the item and referenced photo'
);

create temporary table retry_result on commit drop as
select public.retry_pipeline_run('72000000-0000-4000-8000-000000000003') as value;

select extensions.is(
  (select value #>> '{status}' from retry_result),
  'queued',
  'the owning tenant can retry canceled work'
);
select extensions.ok(
  (select (value #>> '{queueMessageId}')::bigint > 0 from retry_result),
  'retry enqueues one strict wake-up message'
);
select extensions.is(
  public.retry_pipeline_run('72000000-0000-4000-8000-000000000003') #>> '{queueMessageId}',
  (select value #>> '{queueMessageId}' from retry_result),
  'retry is idempotent and returns the existing queue message'
);
select extensions.is(
  public.cancel_pipeline_run('72000000-0000-4000-8000-000000000003') #>> '{status}',
  'canceled',
  'cancel accepts retried queued work'
);
reset role;
select extensions.is(
  (
    select count(*)::integer
    from pgmq.q_pipeline_jobs
    where msg_id = (select (value #>> '{queueMessageId}')::bigint from retry_result)
  ),
  0,
  'cancel removes the queued wake-up without touching domain data'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"pipeline-recovery-a","role":"authenticated"}',
  true
);

select extensions.throws_ok(
  $$select public.cancel_pipeline_run('72000000-0000-4000-8000-000000000001')$$,
  '55000',
  'A ready listing cannot be canceled',
  'successful listings cannot be canceled'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"pipeline-recovery-b","role":"authenticated"}',
  true
);
select extensions.throws_ok(
  $$select public.retry_pipeline_run('72000000-0000-4000-8000-000000000002')$$,
  'P0002',
  'Pipeline run not found',
  'a second tenant cannot retry another seller run'
);
select extensions.throws_ok(
  $$select public.cancel_pipeline_run('72000000-0000-4000-8000-000000000003')$$,
  'P0002',
  'Pipeline run not found',
  'a second tenant cannot cancel another seller run'
);

reset role;

-- Re-enter failed after a manual lifecycle reset as the database owner. The
-- unique notification key keeps the terminal row exactly-once for this run.
update public.pipeline_runs
set status = 'queued',
    stage = 'queued',
    max_attempts = attempt_count + 3,
    queue_message_id = null,
    enqueued_at = null,
    failure_code = null,
    safe_failure_message = null,
    completed_at = null,
    next_attempt_at = null
where id = '72000000-0000-4000-8000-000000000002';
update public.pipeline_runs
set status = 'running',
    stage = 'identifying',
    attempt_count = attempt_count + 1,
    last_attempted_at = statement_timestamp(),
    lease_token = '73000000-0000-4000-8000-000000000004',
    lease_expires_at = statement_timestamp() + interval '1 minute'
where id = '72000000-0000-4000-8000-000000000002';
update public.pipeline_runs
set status = 'failed',
    failure_code = 'attempts_exhausted',
    safe_failure_message = 'SnapList could not finish this listing after several attempts.',
    completed_at = statement_timestamp(),
    lease_token = null,
    lease_expires_at = null
where id = '72000000-0000-4000-8000-000000000002';

select extensions.is(
  (
    select count(*)::integer
    from public.notifications
    where source_pipeline_run_id = '72000000-0000-4000-8000-000000000002'
      and kind = 'pipeline_failed'
  ),
  1,
  'manual retry cannot duplicate a run failure notification'
);
select extensions.is(
  (
    select count(*)::integer
    from public.notifications notification
    join public.pipeline_runs run
      on run.id = notification.source_pipeline_run_id
     and run.user_id = notification.user_id
    where notification.source_pipeline_run_id is not null
  ),
  2,
  'every pipeline notification remains tenant-paired to its run'
);

select * from finish();
rollback;
