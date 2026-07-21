-- Issue #346: fence stale staging cleanup after an exact mobile replay.
--
-- Storage deletion remains two phase. A claimed job is not authority to delete:
-- the executor must authorize it under the same seller/submission advisory key
-- immediately before the Storage call. Exact replay can supersede a prepared or
-- claimed job until that final authorization begins.

alter table private.mobile_item_submissions
  add column cleanup_generation bigint not null default 1,
  add constraint mobile_item_submissions_cleanup_generation_check check (
    cleanup_generation > 0
  );
create unique index mobile_item_submissions_cleanup_id_idx
  on private.mobile_item_submissions (cleanup_id);
alter table private.pipeline_storage_cleanup_jobs
  add column fence_generation bigint,
  add column delete_authorized_at timestamptz,
  add constraint pipeline_storage_cleanup_fence_generation_check check (
    fence_generation is null or fence_generation > 0
  );
update private.pipeline_storage_cleanup_jobs job
set fence_generation = submission.cleanup_generation
from private.mobile_item_submissions submission
where job.source_type = 'staging'
  and job.source_id = submission.cleanup_id;
create or replace function private.assign_mobile_cleanup_fence_generation()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_generation bigint;
begin
  if tg_op = 'UPDATE' then
    if new.fence_generation is distinct from old.fence_generation then
      raise exception using
        errcode = '23514',
        message = 'Pipeline cleanup fence generation is immutable';
    end if;
    return new;
  end if;

  if new.source_type = 'staging' then
    select submission.cleanup_generation into v_generation
    from private.mobile_item_submissions submission
    where submission.cleanup_id = new.source_id;
    if found then
      new.fence_generation := v_generation;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.assign_mobile_cleanup_fence_generation()
  from public, anon, authenticated, service_role;

create trigger pipeline_storage_cleanup_fence_generation
before insert or update on private.pipeline_storage_cleanup_jobs
for each row execute function private.assign_mobile_cleanup_fence_generation();

create or replace function public.record_pipeline_staging_cleanup_intent(
  p_cleanup_id uuid,
  p_user_id text,
  p_batch_id uuid,
  p_photo_paths text[]
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_path text;
  v_prefix text;
  v_existing_user_id text;
  v_existing_batch_id uuid;
  v_existing_photo_paths text[];
  v_submission private.mobile_item_submissions%rowtype;
  v_cleanup_job private.pipeline_storage_cleanup_jobs%rowtype;
  v_receipt_paths text[];
  v_intent_found boolean := false;
  v_mobile_submission_found boolean := false;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Pipeline cleanup authorization is required';
  end if;
  if p_cleanup_id is null
    or coalesce(p_user_id, '') = ''
    or char_length(p_user_id) > 255
    or p_batch_id is null
    or p_photo_paths is null
    or cardinality(p_photo_paths) not between 1 and 800 then
    raise exception using
      errcode = '22023',
      message = 'Invalid pipeline cleanup intent';
  end if;

  v_prefix := p_user_id || '/pipeline-staging/' || p_batch_id::text || '/';
  foreach v_path in array p_photo_paths loop
    if coalesce(char_length(v_path), 0) < char_length(v_prefix) + 1
      or char_length(v_path) > 1024
      or left(v_path, char_length(v_prefix)) <> v_prefix
      or v_path like '%://%'
      or v_path like '%?%'
      or v_path like '%#%' then
      raise exception using
        errcode = '22023',
        message = 'Invalid pipeline cleanup path';
    end if;
  end loop;

  select submission.* into v_submission
  from private.mobile_item_submissions submission
  where submission.cleanup_id = p_cleanup_id;

  if found then
    v_mobile_submission_found := true;
    perform pg_advisory_xact_lock(
      hashtextextended(
        'mobile-item-submission:'
          || v_submission.user_id || ':'
          || v_submission.idempotency_key::text,
        0
      )
    );

    select submission.* into v_submission
    from private.mobile_item_submissions submission
    where submission.cleanup_id = p_cleanup_id
    for update;
    if not found
      or v_submission.user_id is distinct from p_user_id
      or v_submission.batch_id is distinct from p_batch_id
      or v_submission.state is distinct from 'uploading' then
      raise exception using
        errcode = '55000',
        message = 'Uploading mobile item submission cleanup is required';
    end if;

    select coalesce(
      array_agg(receipt.value->>'storage_path' order by receipt.position),
      '{}'::text[]
    ) into v_receipt_paths
    from jsonb_array_elements(v_submission.photo_receipts)
      with ordinality receipt(value, position);
    if v_receipt_paths is distinct from p_photo_paths then
      raise exception using
        errcode = '23514',
        message = 'Mobile item submission cleanup paths conflict';
    end if;

    -- Mobile cleanup lock order after the advisory boundary is always:
    -- submission row, cleanup intent row, cleanup job row, item references.
    select intent.user_id, intent.batch_id, intent.photo_paths
    into v_existing_user_id, v_existing_batch_id, v_existing_photo_paths
    from private.pipeline_staging_cleanup_intents intent
    where intent.cleanup_id = p_cleanup_id
    for update;
    v_intent_found := found;

    select job.* into v_cleanup_job
    from private.pipeline_storage_cleanup_jobs job
    where job.source_type = 'staging'
      and job.source_id = p_cleanup_id
    for update;
    if found then
      if v_cleanup_job.photo_paths is distinct from p_photo_paths
        or v_cleanup_job.fence_generation > v_submission.cleanup_generation then
        raise exception using
          errcode = '23514',
          message = 'Pipeline cleanup job conflicts';
      end if;
      if v_cleanup_job.delete_authorized_at is not null then
        raise exception using
          errcode = '55000',
          message = 'Mobile photo cleanup is executing; retry the exact submission';
      end if;

      if v_cleanup_job.fence_generation is null
        or v_cleanup_job.fence_generation >= v_submission.cleanup_generation then
        update private.mobile_item_submissions submission
        set cleanup_generation = submission.cleanup_generation + 1
        where submission.user_id = p_user_id
          and submission.idempotency_key = v_submission.idempotency_key
        returning submission.* into v_submission;
      end if;

      delete from private.pipeline_storage_cleanup_jobs job
      where job.job_id = v_cleanup_job.job_id;
    end if;
  end if;

  if not v_mobile_submission_found then
    select intent.user_id, intent.batch_id, intent.photo_paths
    into v_existing_user_id, v_existing_batch_id, v_existing_photo_paths
    from private.pipeline_staging_cleanup_intents intent
    where intent.cleanup_id = p_cleanup_id
    for update;
    v_intent_found := found;
  end if;

  if v_intent_found then
    if v_existing_user_id is distinct from p_user_id
      or v_existing_batch_id is distinct from p_batch_id
      or v_existing_photo_paths is distinct from p_photo_paths then
      raise exception using
        errcode = '23514',
        message = 'Pipeline cleanup intent conflicts';
    end if;
    return false;
  end if;

  insert into private.pipeline_staging_cleanup_intents (
    cleanup_id,
    user_id,
    batch_id,
    photo_paths
  ) values (
    p_cleanup_id,
    p_user_id,
    p_batch_id,
    p_photo_paths
  );
  return true;
end;
$$;

revoke all on function public.record_pipeline_staging_cleanup_intent(
  uuid, text, uuid, text[]
) from public, anon, authenticated;
grant execute on function public.record_pipeline_staging_cleanup_intent(
  uuid, text, uuid, text[]
) to service_role;

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
  v_current_intent private.pipeline_staging_cleanup_intents%rowtype;
  v_submission private.mobile_item_submissions%rowtype;
  v_cleanup_job private.pipeline_storage_cleanup_jobs%rowtype;
  v_cleanup_job_found boolean;
  v_receipt_paths text[];
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

  -- Candidate reads identify a boundary only. For mobile submissions the
  -- authoritative order is advisory boundary, submission, intent, job, then
  -- item references. Every value used to publish cleanup is reread afterward.
  for v_intent in
    select intent.cleanup_id,
      submission.user_id as submission_user_id,
      submission.idempotency_key,
      submission.cleanup_generation
    from private.pipeline_staging_cleanup_intents intent
    left join private.mobile_item_submissions submission
      on submission.cleanup_id = intent.cleanup_id
    where intent.cleanup_after <= statement_timestamp()
    order by intent.cleanup_after, intent.cleanup_id
    limit p_batch_size
  loop
    if v_intent.submission_user_id is not null then
      perform pg_advisory_xact_lock(
        hashtextextended(
          'mobile-item-submission:'
            || v_intent.submission_user_id || ':'
            || v_intent.idempotency_key::text,
          0
        )
      );

      select submission.* into v_submission
      from private.mobile_item_submissions submission
      where submission.cleanup_id = v_intent.cleanup_id
      for update;
      if not found
        or v_submission.user_id is distinct from v_intent.submission_user_id
        or v_submission.idempotency_key is distinct from v_intent.idempotency_key
        or v_submission.cleanup_generation
          is distinct from v_intent.cleanup_generation then
        continue;
      end if;
    else
      v_submission := null;
    end if;

    select intent.* into v_current_intent
    from private.pipeline_staging_cleanup_intents intent
    where intent.cleanup_id = v_intent.cleanup_id
    for update;
    if not found
      or v_current_intent.cleanup_after > statement_timestamp() then
      continue;
    end if;

    select job.* into v_cleanup_job
    from private.pipeline_storage_cleanup_jobs job
    where job.source_type = 'staging'
      and job.source_id = v_intent.cleanup_id
    for update;
    v_cleanup_job_found := found;

    if v_intent.submission_user_id is not null then
      select coalesce(
        array_agg(receipt.value->>'storage_path' order by receipt.position),
        '{}'::text[]
      ) into v_receipt_paths
      from jsonb_array_elements(v_submission.photo_receipts)
        with ordinality receipt(value, position);

      if v_current_intent.user_id is distinct from v_submission.user_id
        or v_current_intent.batch_id is distinct from v_submission.batch_id
        or v_current_intent.photo_paths is distinct from v_receipt_paths then
        continue;
      end if;

      if v_submission.state is distinct from 'uploading' then
        if v_cleanup_job_found then
          delete from private.pipeline_storage_cleanup_jobs job
          where job.job_id = v_cleanup_job.job_id;
        end if;
        delete from private.pipeline_staging_cleanup_intents intent
        where intent.cleanup_id = v_current_intent.cleanup_id;
        continue;
      end if;
    end if;

    select coalesce(array_agg(path.path order by path.ordinality), '{}'::text[])
    into v_unreferenced_paths
    from unnest(v_current_intent.photo_paths)
      with ordinality as path(path, ordinality)
    where not exists (
      select 1
      from public.items item
      where path.path = any(item.photos)
    );

    if cardinality(v_unreferenced_paths)
      < cardinality(v_current_intent.photo_paths) then
      v_staging_intents_protected := v_staging_intents_protected + 1;
    end if;

    if v_cleanup_job_found
      and v_intent.submission_user_id is not null
      and (
        v_cleanup_job.fence_generation
          is distinct from v_submission.cleanup_generation
        or v_cleanup_job.photo_paths is distinct from v_unreferenced_paths
      ) then
      delete from private.pipeline_storage_cleanup_jobs job
      where job.job_id = v_cleanup_job.job_id;
      v_cleanup_job_found := false;
    end if;

    if cardinality(v_unreferenced_paths) > 0 and not v_cleanup_job_found then
      insert into private.pipeline_storage_cleanup_jobs (
        source_type,
        source_id,
        photo_paths
      ) values (
        'staging',
        v_current_intent.cleanup_id,
        v_unreferenced_paths
      ) on conflict (source_type, source_id) do nothing;
      if found then
        v_storage_jobs_queued := v_storage_jobs_queued + 1;
      end if;
    end if;

    delete from private.pipeline_staging_cleanup_intents intent
    where intent.cleanup_id = v_current_intent.cleanup_id;
  end loop;

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

create or replace function public.authorize_pipeline_storage_cleanup(
  p_job_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_probe private.pipeline_storage_cleanup_jobs%rowtype;
  v_job private.pipeline_storage_cleanup_jobs%rowtype;
  v_submission private.mobile_item_submissions%rowtype;
  v_submission_found boolean := false;
  v_intent private.pipeline_staging_cleanup_intents%rowtype;
  v_intent_found boolean := false;
  v_receipt_paths text[];
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Pipeline operations authorization is required';
  end if;
  if p_job_id is null or p_lease_token is null then
    raise exception using
      errcode = '22023',
      message = 'Pipeline cleanup authorization identity is required';
  end if;

  select job.* into v_probe
  from private.pipeline_storage_cleanup_jobs job
  where job.job_id = p_job_id;
  if not found then
    return jsonb_build_object('kind', 'stale');
  end if;

  if v_probe.source_type = 'staging'
    and v_probe.fence_generation is not null then
    select submission.* into v_submission
    from private.mobile_item_submissions submission
    where submission.cleanup_id = v_probe.source_id;
    if not found then
      return jsonb_build_object('kind', 'stale');
    end if;

    perform pg_advisory_xact_lock(
      hashtextextended(
        'mobile-item-submission:'
          || v_submission.user_id || ':'
          || v_submission.idempotency_key::text,
        0
      )
    );

    -- The same order used by replay and preparation: boundary, submission,
    -- intent, job, then item references. Pre-boundary probes are never authority.
    select submission.* into v_submission
    from private.mobile_item_submissions submission
    where submission.cleanup_id = v_probe.source_id
    for update;
    v_submission_found := found;

    select intent.* into v_intent
    from private.pipeline_staging_cleanup_intents intent
    where intent.cleanup_id = v_probe.source_id
    for update;
    v_intent_found := found;
  end if;

  select job.* into v_job
  from private.pipeline_storage_cleanup_jobs job
  where job.job_id = p_job_id
    and job.state = 'running'
    and job.lease_token = p_lease_token
    and job.lease_expires_at > statement_timestamp()
  for update;
  if not found then
    return jsonb_build_object('kind', 'stale');
  end if;

  if v_job.source_type = 'staging'
    and v_job.fence_generation is not null then
    if not v_submission_found
      or v_submission.cleanup_id is distinct from v_job.source_id
      or v_submission.state is distinct from 'uploading'
      or v_submission.cleanup_generation is distinct from v_job.fence_generation
      or v_intent_found then
      delete from private.pipeline_storage_cleanup_jobs job
      where job.job_id = v_job.job_id;
      return jsonb_build_object('kind', 'stale');
    end if;

    select coalesce(
      array_agg(receipt.value->>'storage_path' order by receipt.position),
      '{}'::text[]
    ) into v_receipt_paths
    from jsonb_array_elements(v_submission.photo_receipts)
      with ordinality receipt(value, position);

    if v_receipt_paths is distinct from v_job.photo_paths then
      delete from private.pipeline_storage_cleanup_jobs job
      where job.job_id = v_job.job_id;
      return jsonb_build_object('kind', 'stale');
    end if;
  end if;

  if exists (
    select 1
    from public.items item
    where item.photos && v_job.photo_paths
  ) then
    delete from private.pipeline_storage_cleanup_jobs job
    where job.job_id = v_job.job_id;
    return jsonb_build_object('kind', 'stale');
  end if;

  update private.pipeline_storage_cleanup_jobs job
  set delete_authorized_at = coalesce(
        job.delete_authorized_at,
        statement_timestamp()
      ),
      updated_at = statement_timestamp()
  where job.job_id = v_job.job_id;

  return jsonb_build_object(
    'kind', 'authorized',
    'photoPaths', to_jsonb(v_job.photo_paths)
  );
end;
$$;

revoke all on function public.authorize_pipeline_storage_cleanup(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.authorize_pipeline_storage_cleanup(uuid, uuid)
  to service_role;
