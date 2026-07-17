-- Issue #162: scheduler-neutral durable pipeline operations.
--
-- No schedule, secret, hosted resource, or provider call is created here.
-- The owner-only Cron/Vault/pg_net activation example lives under
-- supabase/templates and remains inert until manually applied.

create schema if not exists private;

alter table public.pipeline_runs
  add column if not exists retention_cleaned_at timestamptz;

comment on column public.pipeline_runs.retention_cleaned_at is
  'Operational checkpoint/capture metadata was pruned after terminal retention. The run identity remains as a durable accounting and notification anchor.';

-- Once retention has removed a failed/canceled run's capture input and item
-- photos, replay can no longer succeed. Keep the prior authenticated/RLS-aware
-- retry contract, but fail closed with seller-safe recapture guidance.
create or replace function public.retry_pipeline_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text;
  v_run public.pipeline_runs%rowtype;
  v_message_id bigint;
begin
  v_user_id := public.clerk_user_id();
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Pipeline run authentication is required';
  end if;

  select *
  into v_run
  from public.pipeline_runs
  where id = p_run_id
    and user_id = v_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Pipeline run not found';
  end if;

  if v_run.status = 'succeeded' or v_run.listing_id is not null then
    raise exception using errcode = '55000', message = 'A ready listing cannot be retried';
  end if;

  if v_run.retention_cleaned_at is not null then
    raise exception using
      errcode = '55000',
      message = 'This saved run has expired. Start a new capture.';
  end if;

  if v_run.status in ('queued', 'running', 'retrying') then
    return jsonb_build_object(
      'runId', v_run.id,
      'itemId', v_run.item_id,
      'status', v_run.status,
      'queueMessageId', v_run.queue_message_id
    );
  end if;

  if v_run.status not in ('failed', 'canceled') then
    raise exception using errcode = '55000', message = 'This listing run cannot be retried';
  end if;

  update public.pipeline_runs
  set status = 'queued',
      stage = 'queued',
      max_attempts = greatest(max_attempts, attempt_count + 3),
      queue_message_id = null,
      enqueued_at = null,
      completed_at = null,
      failure_code = null,
      safe_failure_message = null,
      lease_token = null,
      lease_expires_at = null,
      next_attempt_at = null
  where id = v_run.id;

  select *
  into v_message_id
  from pgmq.send(
    'pipeline_jobs',
    jsonb_build_object('run_id', v_run.id, 'schema_version', v_run.schema_version)
  );

  update public.pipeline_runs
  set queue_message_id = v_message_id,
      enqueued_at = statement_timestamp()
  where id = v_run.id;

  return jsonb_build_object(
    'runId', v_run.id,
    'itemId', v_run.item_id,
    'status', 'queued',
    'queueMessageId', v_message_id
  );
end;
$$;

revoke all on function public.retry_pipeline_run(uuid)
  from public, anon, service_role;
grant execute on function public.retry_pipeline_run(uuid)
  to authenticated;

-- Storage deletion is deliberately two phase. A short database transaction
-- first removes an abandoned item reference or resolves an uncommitted staging
-- intent, then persists the exact paths here. A separately leased TypeScript
-- capability may remove only those paths from the private photos bucket.
create table private.pipeline_storage_cleanup_jobs (
  job_id uuid primary key default gen_random_uuid(),
  source_type text not null,
  source_id uuid not null,
  photo_paths text[] not null,
  state text not null default 'pending',
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  available_at timestamptz not null default statement_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  safe_error text,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint pipeline_storage_cleanup_source_key unique (source_type, source_id),
  constraint pipeline_storage_cleanup_source_check check (
    source_type in ('staging', 'abandoned_item')
  ),
  constraint pipeline_storage_cleanup_paths_check check (
    cardinality(photo_paths) between 1 and 800
  ),
  constraint pipeline_storage_cleanup_state_check check (
    state in ('pending', 'running', 'dead')
  ),
  constraint pipeline_storage_cleanup_attempts_check check (
    attempt_count between 0 and max_attempts and max_attempts between 1 and 10
  ),
  constraint pipeline_storage_cleanup_lease_check check (
    (state = 'running' and lease_token is not null and lease_expires_at is not null)
    or (state <> 'running' and lease_token is null and lease_expires_at is null)
  ),
  constraint pipeline_storage_cleanup_error_check check (
    safe_error is null or char_length(safe_error) between 1 and 200
  )
);

create index pipeline_storage_cleanup_due_idx
  on private.pipeline_storage_cleanup_jobs (available_at, created_at)
  where state = 'pending';
create index pipeline_storage_cleanup_expired_lease_idx
  on private.pipeline_storage_cleanup_jobs (lease_expires_at)
  where state = 'running';

comment on table private.pipeline_storage_cleanup_jobs is
  'Exact photos-bucket paths proven eligible for bounded leased cleanup. Five failed attempts become a visible dead letter.';

-- One aggregate row per maintenance invocation keeps cleanup outcomes visible
-- without retaining every completed object job indefinitely.
create table private.pipeline_cleanup_runs (
  cleanup_run_id bigint generated always as identity primary key,
  queue_messages_deleted integer not null default 0,
  queue_archive_rows_deleted integer not null default 0,
  staging_intents_protected integer not null default 0,
  storage_jobs_queued integer not null default 0,
  terminal_runs_pruned integer not null default 0,
  cron_rows_deleted integer not null default 0,
  http_rows_deleted integer not null default 0,
  claimed_storage_jobs integer not null default 0,
  deleted_objects integer not null default 0,
  failed_objects integer not null default 0,
  skipped_for_lock boolean not null default false,
  created_at timestamptz not null default statement_timestamp(),
  constraint pipeline_cleanup_runs_counts_check check (
    queue_messages_deleted >= 0
    and queue_archive_rows_deleted >= 0
    and staging_intents_protected >= 0
    and storage_jobs_queued >= 0
    and terminal_runs_pruned >= 0
    and cron_rows_deleted >= 0
    and http_rows_deleted >= 0
    and claimed_storage_jobs >= 0
    and deleted_objects >= 0
    and failed_objects >= 0
  )
);

create index pipeline_cleanup_runs_created_at_idx
  on private.pipeline_cleanup_runs (created_at desc);

revoke all on table private.pipeline_storage_cleanup_jobs
  from public, anon, authenticated, service_role;
revoke all on table private.pipeline_cleanup_runs
  from public, anon, authenticated, service_role;
revoke all on sequence private.pipeline_cleanup_runs_cleanup_run_id_seq
  from public, anon, authenticated, service_role;

create or replace function public.prepare_pipeline_retention(
  p_batch_size integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent record;
  v_item record;
  v_unreferenced_paths text[];
  v_queue_messages_deleted integer := 0;
  v_queue_archive_rows_deleted integer := 0;
  v_staging_intents_protected integer := 0;
  v_storage_jobs_queued integer := 0;
  v_terminal_runs_pruned integer := 0;
  v_item_terminal_runs_pruned integer := 0;
  v_sweep_terminal_runs_pruned integer := 0;
  v_cron_rows_deleted integer := 0;
  v_http_rows_deleted integer := 0;
  v_cron_relation regclass := to_regclass('cron.job_run_details');
  v_http_relation regclass := to_regclass('net._http_response');
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Pipeline operations authorization is required';
  end if;
  if p_batch_size not between 1 and 100 then
    raise exception using
      errcode = '22023',
      message = 'Pipeline retention batch size must be between 1 and 100';
  end if;

  -- A single short preparation transaction prevents two maintenance requests
  -- from tombstoning the same item. The HTTP/Storage phase is never under lock.
  if not pg_try_advisory_xact_lock(
    hashtextextended('snaplist:pipeline-retention', 0)
  ) then
    return jsonb_build_object(
      'queueMessagesDeleted', 0,
      'queueArchiveRowsDeleted', 0,
      'stagingIntentsProtected', 0,
      'storageJobsQueued', 0,
      'terminalRunsPruned', 0,
      'cronRowsDeleted', 0,
      'httpRowsDeleted', 0,
      'skippedForLock', true
    );
  end if;

  -- A staging intent older than 24 hours is resolved. Paths referenced by any
  -- item are committed product data and are protected; only the unreferenced
  -- remainder becomes a Storage cleanup job.
  for v_intent in
    select intent.cleanup_id, intent.photo_paths
    from private.pipeline_staging_cleanup_intents intent
    where intent.cleanup_after <= statement_timestamp()
    order by intent.cleanup_after, intent.cleanup_id
    for update skip locked
    limit p_batch_size
  loop
    select coalesce(array_agg(path.path order by path.ordinality), '{}'::text[])
    into v_unreferenced_paths
    from unnest(v_intent.photo_paths) with ordinality as path(path, ordinality)
    where not exists (
      select 1
      from public.items item
      where path.path = any(item.photos)
    );

    if cardinality(v_unreferenced_paths) < cardinality(v_intent.photo_paths) then
      v_staging_intents_protected := v_staging_intents_protected + 1;
    end if;

    if cardinality(v_unreferenced_paths) > 0 then
      insert into private.pipeline_storage_cleanup_jobs (
        source_type,
        source_id,
        photo_paths
      ) values (
        'staging',
        v_intent.cleanup_id,
        v_unreferenced_paths
      ) on conflict (source_type, source_id) do nothing;
      if found then
        v_storage_jobs_queued := v_storage_jobs_queued + 1;
      end if;
    end if;

    delete from private.pipeline_staging_cleanup_intents intent
    where intent.cleanup_id = v_intent.cleanup_id;
  end loop;

  -- After 30 days, a terminal failed/canceled item with no listing, successful
  -- sibling run, or active sibling run is an abandoned capture. Preserve its
  -- item/run ids as accounting anchors, but tombstone seller metadata and move
  -- exact photo paths into the replayable Storage cleanup queue.
  for v_item in
    select item.id, item.photos
    from public.items item
    where cardinality(item.photos) > 0
      and not exists (
        select 1 from public.listings listing where listing.item_id = item.id
      )
      and exists (
        select 1
        from public.pipeline_runs terminal_run
        where terminal_run.item_id = item.id
          and terminal_run.status in ('failed', 'canceled')
          and terminal_run.completed_at
            < statement_timestamp() - interval '30 days'
      )
      and not exists (
        select 1
        from public.pipeline_runs protected_run
        where protected_run.item_id = item.id
          and (
            protected_run.status in ('queued', 'running', 'retrying', 'succeeded')
            or (
              protected_run.status in ('failed', 'canceled')
              and (
                protected_run.completed_at is null
                or protected_run.completed_at
                  >= statement_timestamp() - interval '30 days'
              )
            )
          )
      )
    order by item.updated_at, item.id
    for update of item skip locked
    limit p_batch_size
  loop
    -- Retry locks the run row before changing failed/canceled back to queued.
    -- Lock every sibling in deterministic order, then re-check eligibility.
    -- If retry won first, its queued row protects the photos. If retention won
    -- first, retry waits and then observes retention_cleaned_at after commit.
    perform run.id
    from public.pipeline_runs run
    where run.item_id = v_item.id
    order by run.id
    for update;

    if exists (
      select 1
      from public.pipeline_runs protected_run
      where protected_run.item_id = v_item.id
        and (
          protected_run.status in ('queued', 'running', 'retrying', 'succeeded')
          or (
            protected_run.status in ('failed', 'canceled')
            and (
              protected_run.completed_at is null
              or protected_run.completed_at
                >= statement_timestamp() - interval '30 days'
            )
          )
        )
    ) then
      continue;
    end if;

    insert into private.pipeline_storage_cleanup_jobs (
      source_type,
      source_id,
      photo_paths
    ) values (
      'abandoned_item',
      v_item.id,
      v_item.photos
    ) on conflict (source_type, source_id) do nothing;

    if found then
      update public.pipeline_runs run
      set checkpoint = '{}'::jsonb,
          capture_input = null,
          retention_cleaned_at = statement_timestamp()
      where run.item_id = v_item.id
        and run.status in ('failed', 'canceled')
        and run.retention_cleaned_at is null;
      get diagnostics v_item_terminal_runs_pruned = row_count;
      v_terminal_runs_pruned :=
        v_terminal_runs_pruned + v_item_terminal_runs_pruned;

      update public.items
      set photos = '{}'::text[],
          attributes = '{}'::jsonb,
          condition = null,
          identification = null,
          cost_basis = null
      where id = v_item.id;

      update public.notifications notification
      set body = 'This saved run has expired. Start a new capture to try again.'
      where notification.item_id = v_item.id
        and notification.kind = 'pipeline_failed'
        and notification.source_pipeline_run_id in (
          select run.id
          from public.pipeline_runs run
          where run.item_id = v_item.id
            and run.status = 'failed'
        );
      v_storage_jobs_queued := v_storage_jobs_queued + 1;
    end if;
  end loop;

  -- Keep terminal run identities for notifications and #168 credit accounting;
  -- prune only resumable/provider-sized operational metadata after 30 days.
  with targets as (
    select run.id
    from public.pipeline_runs run
    where run.status in ('succeeded', 'failed', 'canceled')
      and run.completed_at < statement_timestamp() - interval '30 days'
      and run.retention_cleaned_at is null
    order by run.completed_at, run.id
    for update skip locked
    limit p_batch_size
  )
  update public.pipeline_runs run
  set checkpoint = '{}'::jsonb,
      capture_input = null,
      retention_cleaned_at = statement_timestamp()
  from targets
  where run.id = targets.id;
  get diagnostics v_sweep_terminal_runs_pruned = row_count;
  v_terminal_runs_pruned :=
    v_terminal_runs_pruned + v_sweep_terminal_runs_pruned;

  -- Normal workers delete after durable terminal state. This bounded sweep is
  -- crash recovery for messages left behind after completion/terminal failure.
  with targets as (
    select queued.msg_id
    from pgmq.q_pipeline_jobs queued
    join public.pipeline_runs run
      on run.queue_message_id = queued.msg_id
    where run.status in ('succeeded', 'failed', 'canceled')
      and run.completed_at < statement_timestamp() - interval '24 hours'
    order by queued.msg_id
    limit p_batch_size
  )
  delete from pgmq.q_pipeline_jobs queued
  using targets
  where queued.msg_id = targets.msg_id;
  get diagnostics v_queue_messages_deleted = row_count;

  -- PGMQ archive rows are operational delivery history, not product truth.
  if to_regclass('pgmq.a_pipeline_jobs') is not null then
    execute $archive$
      with targets as (
        select archived.ctid
        from pgmq.a_pipeline_jobs archived
        where archived.archived_at
          < statement_timestamp() - interval '7 days'
        order by archived.archived_at, archived.msg_id
        limit $1
      )
      delete from pgmq.a_pipeline_jobs archived
      using targets
      where archived.ctid = targets.ctid
    $archive$ using p_batch_size;
    get diagnostics v_queue_archive_rows_deleted = row_count;
  end if;

  -- These extension-owned response tables are optional locally. Dynamic SQL
  -- keeps fresh resets valid when pg_cron or pg_net is absent.
  if v_cron_relation is not null then
    execute format($cron_cleanup$
      with targets as (
        select detail.runid
        from %s detail
        where coalesce(detail.end_time, detail.start_time)
          < statement_timestamp() - interval '7 days'
        order by detail.runid
        limit $1
      )
      delete from %s detail
      using targets
      where detail.runid = targets.runid
    $cron_cleanup$, v_cron_relation, v_cron_relation) using p_batch_size;
    get diagnostics v_cron_rows_deleted = row_count;
  end if;

  if v_http_relation is not null then
    execute format($http_cleanup$
      with targets as (
        select response.id
        from %s response
        where response.created
          < statement_timestamp() - interval '24 hours'
        order by response.created, response.id
        limit $1
      )
      delete from %s response
      using targets
      where response.id = targets.id
    $http_cleanup$, v_http_relation, v_http_relation) using p_batch_size;
    get diagnostics v_http_rows_deleted = row_count;
  end if;

  return jsonb_build_object(
    'queueMessagesDeleted', v_queue_messages_deleted,
    'queueArchiveRowsDeleted', v_queue_archive_rows_deleted,
    'stagingIntentsProtected', v_staging_intents_protected,
    'storageJobsQueued', v_storage_jobs_queued,
    'terminalRunsPruned', v_terminal_runs_pruned,
    'cronRowsDeleted', v_cron_rows_deleted,
    'httpRowsDeleted', v_http_rows_deleted,
    'skippedForLock', false
  );
end;
$$;

revoke all on function public.prepare_pipeline_retention(integer)
  from public, anon, authenticated;
grant execute on function public.prepare_pipeline_retention(integer)
  to service_role;

create or replace function public.claim_pipeline_storage_cleanup(
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job private.pipeline_storage_cleanup_jobs%rowtype;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Pipeline operations authorization is required';
  end if;
  if p_lease_seconds not between 30 and 3600 then
    raise exception using
      errcode = '22023',
      message = 'Pipeline cleanup lease must be between 30 and 3600 seconds';
  end if;

  -- A crash during the final allowed attempt is a dead letter after expiry.
  update private.pipeline_storage_cleanup_jobs job
  set state = 'dead',
      lease_token = null,
      lease_expires_at = null,
      safe_error = coalesce(job.safe_error, 'Photo cleanup lease expired.'),
      updated_at = statement_timestamp()
  where job.state = 'running'
    and job.lease_expires_at <= statement_timestamp()
    and job.attempt_count >= job.max_attempts;

  select * into v_job
  from private.pipeline_storage_cleanup_jobs job
  where (
      job.state = 'pending'
      and job.available_at <= statement_timestamp()
    ) or (
      job.state = 'running'
      and job.lease_expires_at <= statement_timestamp()
      and job.attempt_count < job.max_attempts
    )
  order by job.available_at, job.created_at, job.job_id
  for update skip locked
  limit 1;

  if not found then
    return jsonb_build_object('kind', 'empty');
  end if;

  update private.pipeline_storage_cleanup_jobs job
  set state = 'running',
      attempt_count = job.attempt_count + 1,
      lease_token = gen_random_uuid(),
      lease_expires_at = statement_timestamp()
        + make_interval(secs => p_lease_seconds),
      safe_error = null,
      updated_at = statement_timestamp()
  where job.job_id = v_job.job_id
  returning * into v_job;

  return jsonb_build_object(
    'kind', 'claimed',
    'job', jsonb_build_object(
      'jobId', v_job.job_id,
      'leaseToken', v_job.lease_token,
      'photoPaths', to_jsonb(v_job.photo_paths),
      'attemptCount', v_job.attempt_count,
      'maxAttempts', v_job.max_attempts
    )
  );
end;
$$;

revoke all on function public.claim_pipeline_storage_cleanup(integer)
  from public, anon, authenticated;
grant execute on function public.claim_pipeline_storage_cleanup(integer)
  to service_role;

create or replace function public.complete_pipeline_storage_cleanup(
  p_job_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Pipeline operations authorization is required';
  end if;

  delete from private.pipeline_storage_cleanup_jobs job
  where job.job_id = p_job_id
    and job.state = 'running'
    and job.lease_token = p_lease_token
    and job.lease_expires_at > statement_timestamp();
  return found;
end;
$$;

revoke all on function public.complete_pipeline_storage_cleanup(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.complete_pipeline_storage_cleanup(uuid, uuid)
  to service_role;

create or replace function public.fail_pipeline_storage_cleanup(
  p_job_id uuid,
  p_lease_token uuid,
  p_safe_error text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job private.pipeline_storage_cleanup_jobs%rowtype;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Pipeline operations authorization is required';
  end if;
  if char_length(p_safe_error) not between 1 and 200 then
    raise exception using
      errcode = '22023',
      message = 'Invalid pipeline cleanup failure summary';
  end if;

  select * into v_job
  from private.pipeline_storage_cleanup_jobs job
  where job.job_id = p_job_id
    and job.state = 'running'
    and job.lease_token = p_lease_token
    and job.lease_expires_at > statement_timestamp()
  for update;
  if not found then return false; end if;

  update private.pipeline_storage_cleanup_jobs job
  set state = case
        when v_job.attempt_count >= v_job.max_attempts then 'dead'
        else 'pending'
      end,
      available_at = case
        when v_job.attempt_count >= v_job.max_attempts then job.available_at
        else statement_timestamp() + make_interval(
          secs => least(900, 30 * (2 ^ greatest(0, v_job.attempt_count - 1))::integer)
        )
      end,
      lease_token = null,
      lease_expires_at = null,
      safe_error = p_safe_error,
      updated_at = statement_timestamp()
  where job.job_id = p_job_id;
  return true;
end;
$$;

revoke all on function public.fail_pipeline_storage_cleanup(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.fail_pipeline_storage_cleanup(uuid, uuid, text)
  to service_role;

create or replace function public.record_pipeline_cleanup_outcome(
  p_summary jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Pipeline operations authorization is required';
  end if;
  if jsonb_typeof(p_summary) is distinct from 'object' then
    raise exception using
      errcode = '22023',
      message = 'Invalid pipeline cleanup outcome';
  end if;

  insert into private.pipeline_cleanup_runs (
    queue_messages_deleted,
    queue_archive_rows_deleted,
    staging_intents_protected,
    storage_jobs_queued,
    terminal_runs_pruned,
    cron_rows_deleted,
    http_rows_deleted,
    claimed_storage_jobs,
    deleted_objects,
    failed_objects,
    skipped_for_lock
  ) values (
    (p_summary->>'queueMessagesDeleted')::integer,
    (p_summary->>'queueArchiveRowsDeleted')::integer,
    (p_summary->>'stagingIntentsProtected')::integer,
    (p_summary->>'storageJobsQueued')::integer,
    (p_summary->>'terminalRunsPruned')::integer,
    (p_summary->>'cronRowsDeleted')::integer,
    (p_summary->>'httpRowsDeleted')::integer,
    (p_summary->>'claimedStorageJobs')::integer,
    (p_summary->>'deletedObjects')::integer,
    (p_summary->>'failedObjects')::integer,
    (p_summary->>'skippedForLock')::boolean
  );

  -- Aggregate outcomes are useful for recent operations, not permanent product
  -- history. Bound the table opportunistically to 90 days.
  delete from private.pipeline_cleanup_runs cleanup
  where cleanup.created_at < statement_timestamp() - interval '90 days';
  return true;
exception
  when invalid_text_representation or not_null_violation or check_violation then
    raise exception using
      errcode = '22023',
      message = 'Invalid pipeline cleanup outcome';
end;
$$;

revoke all on function public.record_pipeline_cleanup_outcome(jsonb)
  from public, anon, authenticated;
grant execute on function public.record_pipeline_cleanup_outcome(jsonb)
  to service_role;

create or replace function public.pipeline_operations_health()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_metrics jsonb := '{}'::jsonb;
  v_last private.pipeline_cleanup_runs%rowtype;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Pipeline operations authorization is required';
  end if;

  select to_jsonb(metrics)
  into v_metrics
  from pgmq.metrics('pipeline_jobs') metrics;

  select * into v_last
  from private.pipeline_cleanup_runs cleanup
  order by cleanup.created_at desc, cleanup.cleanup_run_id desc
  limit 1;

  return jsonb_build_object(
    'queueDepth', coalesce((v_metrics->>'queue_length')::integer, 0),
    'oldestJobAgeSeconds', greatest(
      0,
      coalesce((v_metrics->>'oldest_msg_age_sec')::integer, 0)
    ),
    'retries', (
      select count(*)::integer
      from public.pipeline_runs run
      where run.status = 'retrying'
    ),
    'terminalFailures', (
      select count(*)::integer
      from public.pipeline_runs run
      where run.status = 'failed'
    ),
    'expiredWorkerLeases', (
      select count(*)::integer
      from public.pipeline_runs run
      where run.status = 'running'
        and run.lease_expires_at <= statement_timestamp()
    ),
    'cleanupPending', (
      select count(*)::integer
      from private.pipeline_storage_cleanup_jobs job
      where job.state in ('pending', 'running')
    ),
    'cleanupDeadLetters', (
      select count(*)::integer
      from private.pipeline_storage_cleanup_jobs job
      where job.state = 'dead'
    ),
    'lastCleanupAt', case when v_last.cleanup_run_id is null
      then null
      else to_jsonb(v_last.created_at)
    end,
    'lastCleanupDeletedObjects', coalesce(v_last.deleted_objects, 0),
    'lastCleanupFailedObjects', coalesce(v_last.failed_objects, 0)
  );
end;
$$;

revoke all on function public.pipeline_operations_health()
  from public, anon, authenticated;
grant execute on function public.pipeline_operations_health()
  to service_role;
