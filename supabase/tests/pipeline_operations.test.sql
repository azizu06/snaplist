begin;

select plan(42);

select extensions.has_column(
  'public', 'pipeline_runs', 'retention_cleaned_at',
  'terminal runs track operational metadata retention'
);
select extensions.has_table(
  'private', 'pipeline_storage_cleanup_jobs',
  'Storage cleanup jobs are private and durable'
);
select extensions.has_table(
  'private', 'pipeline_cleanup_runs',
  'cleanup outcomes are private and durable'
);
select extensions.has_function(
  'public', 'prepare_pipeline_retention', array['integer'],
  'bounded retention preparation RPC exists'
);
select extensions.has_function(
  'public', 'claim_pipeline_storage_cleanup', array['integer'],
  'leased Storage cleanup claim RPC exists'
);
select extensions.has_function(
  'public', 'complete_pipeline_storage_cleanup', array['uuid', 'uuid'],
  'Storage cleanup completion RPC exists'
);
select extensions.has_function(
  'public', 'fail_pipeline_storage_cleanup', array['uuid', 'uuid', 'text'],
  'Storage cleanup failure RPC exists'
);
select extensions.has_function(
  'public', 'pipeline_operations_health', array[]::text[],
  'aggregate pipeline health RPC exists'
);

select extensions.function_privs_are(
  'public', 'prepare_pipeline_retention', array['integer'], 'service_role',
  array['EXECUTE'], 'service role receives fixed retention authority'
);
select extensions.function_privs_are(
  'public', 'claim_pipeline_storage_cleanup', array['integer'], 'service_role',
  array['EXECUTE'], 'service role receives fixed cleanup claim authority'
);
select extensions.function_privs_are(
  'public', 'pipeline_operations_health', array[]::text[], 'service_role',
  array['EXECUTE'], 'service role receives fixed health authority'
);
select extensions.function_privs_are(
  'public', 'prepare_pipeline_retention', array['integer'], 'authenticated',
  array[]::text[], 'sellers cannot run cross-tenant retention'
);
select extensions.table_privs_are(
  'private', 'pipeline_storage_cleanup_jobs', 'service_role',
  array[]::text[], 'service role cannot bypass cleanup RPCs'
);
select extensions.table_privs_are(
  'private', 'pipeline_cleanup_runs', 'authenticated',
  array[]::text[], 'sellers cannot read cleanup outcomes'
);

insert into public.items (id, user_id, photos, attributes, condition)
values
  (
    '81000000-0000-4000-8000-000000000001',
    'pipeline-operations-user',
    array['pipeline-operations-user/success.jpg'],
    '{"brand":"protected"}',
    'good'
  ),
  (
    '81000000-0000-4000-8000-000000000002',
    'pipeline-operations-user',
    array['pipeline-operations-user/abandoned.jpg'],
    '{"brand":"abandoned"}',
    'poor'
  );

insert into public.pipeline_runs (id, user_id, item_id, idempotency_key, checkpoint, capture_input)
values
  (
    '82000000-0000-4000-8000-000000000001',
    'pipeline-operations-user',
    '81000000-0000-4000-8000-000000000001',
    'operations-success',
    '{"identified":{"model":"test"}}',
    '{"source":"single","autopilot_enabled":false,"photo_count":1}'
  ),
  (
    '82000000-0000-4000-8000-000000000002',
    'pipeline-operations-user',
    '81000000-0000-4000-8000-000000000002',
    'operations-failed',
    '{"identified":{"model":"test"}}',
    '{"source":"single","autopilot_enabled":false,"photo_count":1}'
  );

update public.pipeline_runs
set status = 'running',
    stage = 'identifying',
    attempt_count = 1,
    started_at = statement_timestamp(),
    last_attempted_at = statement_timestamp(),
    lease_token = '83000000-0000-4000-8000-000000000001',
    lease_expires_at = statement_timestamp() + interval '1 minute'
where id = '82000000-0000-4000-8000-000000000001';
update public.pipeline_runs
set status = 'succeeded',
    stage = 'completed',
    completed_at = statement_timestamp() - interval '31 days',
    lease_token = null,
    lease_expires_at = null
where id = '82000000-0000-4000-8000-000000000001';

insert into public.listings (
  id, user_id, item_id, platform, status, run_id
) values (
  '84000000-0000-4000-8000-000000000001',
  'pipeline-operations-user',
  '81000000-0000-4000-8000-000000000001',
  'ebay',
  'draft',
  '82000000-0000-4000-8000-000000000001'
);
update public.pipeline_runs
set listing_id = '84000000-0000-4000-8000-000000000001'
where id = '82000000-0000-4000-8000-000000000001';

select pgmq.send(
  'pipeline_jobs',
  jsonb_build_object(
    'run_id', '82000000-0000-4000-8000-000000000002',
    'schema_version', 1
  )
) as msg_id into temporary table abandoned_message;
update public.pipeline_runs
set queue_message_id = (select msg_id from abandoned_message),
    enqueued_at = statement_timestamp() - interval '31 days'
where id = '82000000-0000-4000-8000-000000000002';
update public.pipeline_runs
set status = 'running',
    stage = 'identifying',
    attempt_count = 1,
    started_at = statement_timestamp() - interval '31 days',
    last_attempted_at = statement_timestamp() - interval '31 days',
    lease_token = '83000000-0000-4000-8000-000000000002',
    lease_expires_at = statement_timestamp() + interval '1 minute'
where id = '82000000-0000-4000-8000-000000000002';
update public.pipeline_runs
set status = 'failed',
    failure_code = 'provider_unavailable',
    safe_failure_message = 'The listing could not be prepared.',
    completed_at = statement_timestamp() - interval '31 days',
    lease_token = null,
    lease_expires_at = null
where id = '82000000-0000-4000-8000-000000000002';

insert into private.pipeline_staging_cleanup_intents (
  cleanup_id, user_id, batch_id, photo_paths, created_at, cleanup_after
) values (
  '85000000-0000-4000-8000-000000000001',
  'pipeline-operations-user',
  '86000000-0000-4000-8000-000000000001',
  array[
    'pipeline-operations-user/success.jpg',
    'pipeline-operations-user/pipeline-staging/orphan.jpg'
  ],
  statement_timestamp() - interval '26 hours',
  statement_timestamp() - interval '2 hours'
);

set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);
create temporary table retention_result on commit drop as
select public.prepare_pipeline_retention(25) as value;
reset role;

select extensions.is(
  (select value->>'skippedForLock' from retention_result),
  'false',
  'one retention preparation acquires the concurrency fence'
);
select extensions.is(
  (select (value->>'storageJobsQueued')::integer from retention_result),
  2,
  'one orphan staging group and one abandoned item become cleanup jobs'
);
select extensions.is(
  (select (value->>'stagingIntentsProtected')::integer from retention_result),
  1,
  'an intent containing a committed photo records protection'
);
select extensions.is(
  (select photos[1] from public.items where id = '81000000-0000-4000-8000-000000000001'),
  'pipeline-operations-user/success.jpg',
  'a successful listing photo is preserved'
);
select extensions.is(
  (select cardinality(photos) from public.items where id = '81000000-0000-4000-8000-000000000002'),
  0,
  'an abandoned terminal item releases its photo references'
);
select extensions.is(
  (select attributes from public.items where id = '81000000-0000-4000-8000-000000000002'),
  '{}'::jsonb,
  'an abandoned terminal item is reduced to an accounting tombstone'
);
select extensions.is(
  (
    select body
    from public.notifications
    where source_pipeline_run_id = '82000000-0000-4000-8000-000000000002'
      and kind = 'pipeline_failed'
  ),
  'This saved run has expired. Start a new capture to try again.',
  'retention replaces the stale saved-photo notification with recapture guidance'
);
select extensions.is(
  (select checkpoint from public.pipeline_runs where id = '82000000-0000-4000-8000-000000000002'),
  '{}'::jsonb,
  'failed terminal checkpoint metadata is pruned'
);
select extensions.is(
  (select checkpoint from public.pipeline_runs where id = '82000000-0000-4000-8000-000000000001'),
  '{}'::jsonb,
  'successful terminal checkpoint metadata is pruned without deleting the run'
);
select extensions.ok(
  (select retention_cleaned_at is not null from public.pipeline_runs where id = '82000000-0000-4000-8000-000000000001'),
  'terminal metadata cleanup is idempotently marked'
);
select extensions.is(
  (
    select count(*)::integer from pgmq.q_pipeline_jobs
    where msg_id = (select msg_id from abandoned_message)
  ),
  0,
  'a stale message paired to a durable terminal run is removed'
);
select extensions.is(
  (
    select count(*)::integer
    from private.pipeline_staging_cleanup_intents
    where cleanup_id = '85000000-0000-4000-8000-000000000001'
  ),
  0,
  'the resolved staging intent does not remain live'
);
select extensions.is(
  (select count(*)::integer from private.pipeline_storage_cleanup_jobs),
  2,
  'exact paths remain durably queued until Storage confirms deletion'
);
select extensions.is(
  (
    select count(*)::integer
    from private.pipeline_storage_cleanup_jobs job,
      unnest(job.photo_paths) path
    where path = 'pipeline-operations-user/success.jpg'
  ),
  0,
  'the successful photo never enters cleanup work'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"pipeline-operations-user","role":"authenticated"}',
  true
);
select extensions.throws_ok(
  $$select public.retry_pipeline_run('82000000-0000-4000-8000-000000000002')$$,
  '55000',
  'This saved run has expired. Start a new capture.',
  'a retention-cleaned run cannot enqueue an impossible retry'
);
reset role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table health_before on commit drop as
select public.pipeline_operations_health() as value;
create temporary table cleanup_claim on commit drop as
select public.claim_pipeline_storage_cleanup(300) as value;
reset role;

select extensions.is(
  (select (value->>'queueDepth')::integer from health_before),
  0,
  'health exposes queue depth'
);
select extensions.is(
  (select (value->>'terminalFailures')::integer from health_before),
  1,
  'health exposes terminal failures'
);
select extensions.is(
  (select value->>'kind' from cleanup_claim),
  'claimed',
  'cleanup claims one leased job'
);
select extensions.ok(
  (select jsonb_array_length(value #> '{job,photoPaths}') > 0 from cleanup_claim),
  'cleanup returns only exact persisted paths'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select extensions.ok(
  public.complete_pipeline_storage_cleanup(
    (select (value #>> '{job,jobId}')::uuid from cleanup_claim),
    (select (value #>> '{job,leaseToken}')::uuid from cleanup_claim)
  ),
  'the current lease can complete cleanup exactly once'
);
reset role;

select extensions.is(
  (select count(*)::integer from private.pipeline_storage_cleanup_jobs),
  1,
  'completion removes only its claimed cleanup job'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table dead_claim on commit drop as
select public.claim_pipeline_storage_cleanup(300) as value;
reset role;
update private.pipeline_storage_cleanup_jobs
set attempt_count = max_attempts
where job_id = (select (value #>> '{job,jobId}')::uuid from dead_claim);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select extensions.ok(
  public.fail_pipeline_storage_cleanup(
    (select (value #>> '{job,jobId}')::uuid from dead_claim),
    (select (value #>> '{job,leaseToken}')::uuid from dead_claim),
    'Photo cleanup failed and will be retried.'
  ),
  'a failed current cleanup lease is durably finished'
);
reset role;

select extensions.is(
  (
    select state from private.pipeline_storage_cleanup_jobs
    where job_id = (select (value #>> '{job,jobId}')::uuid from dead_claim)
  ),
  'dead',
  'the fifth failed cleanup attempt becomes a dead letter'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select extensions.ok(
  public.record_pipeline_cleanup_outcome(jsonb_build_object(
    'queueMessagesDeleted', 1,
    'queueArchiveRowsDeleted', 0,
    'stagingIntentsProtected', 1,
    'storageJobsQueued', 2,
    'terminalRunsPruned', 2,
    'cronRowsDeleted', 0,
    'httpRowsDeleted', 0,
    'skippedForLock', false,
    'claimedStorageJobs', 2,
    'deletedObjects', 1,
    'failedObjects', 1
  )),
  'aggregate cleanup outcomes are recorded through a fixed RPC'
);
create temporary table health_after on commit drop as
select public.pipeline_operations_health() as value;
reset role;

select extensions.is(
  (select (value->>'cleanupDeadLetters')::integer from health_after),
  1,
  'health exposes cleanup dead letters'
);
select extensions.is(
  (select (value->>'lastCleanupDeletedObjects')::integer from health_after),
  1,
  'health exposes the latest successful object cleanup count'
);
select extensions.is(
  (select (value->>'lastCleanupFailedObjects')::integer from health_after),
  1,
  'health exposes the latest failed object cleanup count'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"pipeline-operations-user","role":"authenticated"}',
  true
);
select extensions.throws_ok(
  $$select public.prepare_pipeline_retention(25)$$,
  '42501',
  'permission denied for function prepare_pipeline_retention',
  'an authenticated seller cannot invoke retention'
);
reset role;

select * from finish();
rollback;
