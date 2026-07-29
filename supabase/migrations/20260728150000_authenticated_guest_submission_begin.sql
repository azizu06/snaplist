-- Issue #332: let a project-signed authenticated guest bind its own uploading
-- mobile submission before Storage work. The existing seven-argument
-- service-role function remains unchanged for Clerk-backed composition.

create or replace function private.record_authenticated_guest_staging_cleanup_intent(
  p_cleanup_id uuid,
  p_batch_id uuid,
  p_photo_paths text[]
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := private.assert_verified_guest_capability();
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
  if p_cleanup_id is null
    or p_batch_id is null
    or p_photo_paths is null
    or cardinality(p_photo_paths) not between 1 and 800 then
    raise exception using
      errcode = '22023',
      message = 'Invalid authenticated guest cleanup intent';
  end if;

  v_prefix := v_user_id || '/pipeline-staging/' || p_batch_id::text || '/';
  foreach v_path in array p_photo_paths loop
    if coalesce(char_length(v_path), 0) < char_length(v_prefix) + 1
      or char_length(v_path) > 1024
      or left(v_path, char_length(v_prefix)) <> v_prefix
      or v_path like '%://%'
      or v_path like '%?%'
      or v_path like '%#%' then
      raise exception using
        errcode = '22023',
        message = 'Invalid authenticated guest cleanup path';
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
      or v_submission.user_id is distinct from v_user_id
      or v_submission.batch_id is distinct from p_batch_id
      or v_submission.state is distinct from 'uploading' then
      raise exception using
        errcode = '55000',
        message = 'Uploading authenticated guest submission cleanup is required';
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
        message = 'Authenticated guest submission cleanup paths conflict';
    end if;

    -- Match the service-role recorder's replay-fence lock order after the
    -- submission advisory boundary: submission, intent, job, item references.
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
        where submission.user_id = v_user_id
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
    if v_existing_user_id is distinct from v_user_id
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
    v_user_id,
    p_batch_id,
    p_photo_paths
  );
  return true;
end;
$$;

revoke all on function private.record_authenticated_guest_staging_cleanup_intent(
  uuid, uuid, text[]
) from public, anon, authenticated, service_role;

create or replace function public.begin_mobile_item_submission(
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_batch_id uuid,
  p_cleanup_id uuid,
  p_cost_basis numeric,
  p_photo_receipts jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := private.assert_verified_guest_capability();
  v_submission private.mobile_item_submissions%rowtype;
  v_receipt jsonb;
  v_position integer;
  v_storage_path text;
  v_photo_paths text[] := '{}'::text[];
begin
  if char_length(v_user_id) > 255
    or p_idempotency_key is null
    or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    or p_batch_id is distinct from p_idempotency_key
    or p_cleanup_id is null
    or p_cost_basis < 0
    or p_cost_basis is distinct from round(p_cost_basis, 2)
    or jsonb_typeof(p_photo_receipts) <> 'array'
    or jsonb_array_length(p_photo_receipts) not between 1 and 5 then
    raise exception using
      errcode = '22023',
      message = 'Invalid uploading authenticated guest submission';
  end if;

  for v_receipt, v_position in
    select receipt.value, (receipt.position - 1)::integer
    from jsonb_array_elements(p_photo_receipts)
      with ordinality receipt(value, position)
  loop
    if jsonb_typeof(v_receipt) <> 'object'
      or not (v_receipt ?& array[
        'ordinal', 'storage_path', 'content_sha256', 'byte_length', 'media_type'
      ])
      or (select count(*) from jsonb_object_keys(v_receipt)) <> 5
      or jsonb_typeof(v_receipt->'ordinal') <> 'number'
      or (v_receipt->>'ordinal') !~ '^[0-9]+$'
      or (v_receipt->>'ordinal')::integer is distinct from v_position
      or v_receipt->>'content_sha256' !~ '^[0-9a-f]{64}$'
      or jsonb_typeof(v_receipt->'byte_length') <> 'number'
      or (v_receipt->>'byte_length') !~ '^[0-9]+$'
      or (v_receipt->>'byte_length')::bigint not between 1 and 52428800
      or v_receipt->>'media_type' not in ('image/jpeg', 'image/png', 'image/webp') then
      raise exception using
        errcode = '22023',
        message = 'Invalid planned authenticated guest photo receipt';
    end if;

    v_storage_path := v_receipt->>'storage_path';
    if coalesce(char_length(v_storage_path), 0) < 1
      or char_length(v_storage_path) > 1024
      or left(
        v_storage_path,
        char_length(v_user_id || '/pipeline-staging/' || p_batch_id::text || '/0/')
      ) <> v_user_id || '/pipeline-staging/' || p_batch_id::text || '/0/'
      or v_storage_path like '%://%'
      or v_storage_path like '%?%'
      or v_storage_path like '%#%' then
      raise exception using
        errcode = '22023',
        message = 'Invalid planned authenticated guest photo path';
    end if;
    v_photo_paths := array_append(v_photo_paths, v_storage_path);
  end loop;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'mobile-item-submission:' || v_user_id || ':' || p_idempotency_key::text,
      0
    )
  );

  select submission.* into v_submission
  from private.mobile_item_submissions submission
  where submission.user_id = v_user_id
    and submission.idempotency_key = p_idempotency_key
  for update;
  if found then
    if v_submission.request_fingerprint is distinct from p_request_fingerprint
      or v_submission.batch_id is distinct from p_batch_id
      or v_submission.cleanup_id is distinct from p_cleanup_id
      or v_submission.cost_basis is distinct from p_cost_basis
      or v_submission.photo_receipts is distinct from p_photo_receipts then
      raise exception using
        errcode = '23514',
        message = 'Mobile item submission idempotency conflict';
    end if;
    if v_submission.state = 'uploading' then
      perform private.record_authenticated_guest_staging_cleanup_intent(
        p_cleanup_id, p_batch_id, v_photo_paths
      );
      update private.pipeline_staging_cleanup_intents intent
      set cleanup_after = greatest(
        intent.cleanup_after,
        statement_timestamp() + interval '24 hours'
      )
      where intent.cleanup_id = p_cleanup_id
        and intent.user_id = v_user_id
        and intent.batch_id = p_batch_id
        and intent.photo_paths is not distinct from v_photo_paths;
      if not found then
        raise exception using
          errcode = '55000',
          message = 'Durable authenticated guest photo cleanup renewal is required';
      end if;
    end if;
    return false;
  end if;

  perform private.record_authenticated_guest_staging_cleanup_intent(
    p_cleanup_id, p_batch_id, v_photo_paths
  );
  insert into private.mobile_item_submissions (
    user_id,
    idempotency_key,
    request_fingerprint,
    batch_id,
    cleanup_id,
    cost_basis,
    photo_receipts
  ) values (
    v_user_id,
    p_idempotency_key,
    p_request_fingerprint,
    p_batch_id,
    p_cleanup_id,
    p_cost_basis,
    p_photo_receipts
  );
  return true;
end;
$$;

revoke all on function public.begin_mobile_item_submission(
  uuid, text, uuid, uuid, numeric, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.begin_mobile_item_submission(
  uuid, text, uuid, uuid, numeric, jsonb
) to authenticated;
