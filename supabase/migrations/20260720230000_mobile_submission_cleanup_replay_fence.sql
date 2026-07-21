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

  select intent.user_id, intent.batch_id, intent.photo_paths
  into v_existing_user_id, v_existing_batch_id, v_existing_photo_paths
  from private.pipeline_staging_cleanup_intents intent
  where intent.cleanup_id = p_cleanup_id
  for update;

  if found then
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
      'fenceGeneration', v_job.fence_generation,
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
      delete from private.pipeline_storage_cleanup_jobs job
      where job.job_id = p_job_id
        and job.lease_token = p_lease_token;
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
    select submission.* into v_submission
    from private.mobile_item_submissions submission
    where submission.cleanup_id = v_job.source_id
    for update;

    if not found
      or v_submission.state is distinct from 'uploading'
      or v_submission.cleanup_generation is distinct from v_job.fence_generation then
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
