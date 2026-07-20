-- Issue #334: bind one server-verified multipart request to one #159 staged run.
-- Storage remains tenant/RLS-scoped. This private ledger is reachable only
-- through two fixed service-role RPC capabilities and grants no generic table
-- access to the producer.

create table private.mobile_item_submissions (
  user_id text not null,
  idempotency_key uuid not null,
  request_fingerprint text not null
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  batch_id uuid not null,
  cleanup_id uuid not null,
  cost_basis numeric,
  photo_receipts jsonb not null
    check (
      jsonb_typeof(photo_receipts) = 'array'
      and jsonb_array_length(photo_receipts) between 1 and 4
    ),
  state text not null default 'uploading'
    check (state in ('uploading', 'committed')),
  photo_identity_kind text
    check (photo_identity_kind is null or photo_identity_kind = 'content_sha256_set_v1'),
  photo_identity_fingerprint text
    check (
      photo_identity_fingerprint is null
      or photo_identity_fingerprint ~ '^[0-9a-f]{64}$'
    ),
  item_id uuid,
  run_id uuid,
  queue_message_id bigint,
  created_at timestamptz not null default statement_timestamp(),
  committed_at timestamptz,
  primary key (user_id, idempotency_key),
  unique (run_id),
  constraint mobile_item_submissions_cost_basis_check check (
    cost_basis is null
    or (cost_basis >= 0 and cost_basis = round(cost_basis, 2))
  ),
  constraint mobile_item_submissions_state_coherence_check check (
    (
      state = 'uploading'
      and photo_identity_kind is null
      and photo_identity_fingerprint is null
      and item_id is null
      and run_id is null
      and queue_message_id is null
      and committed_at is null
    )
    or (
      state = 'committed'
      and photo_identity_kind is not null
      and photo_identity_fingerprint is not null
      and item_id is not null
      and run_id is not null
      and queue_message_id is not null
      and committed_at is not null
    )
  ),
  constraint mobile_item_submissions_item_owner_fkey
    foreign key (item_id, user_id)
    references public.items (id, user_id)
    on delete cascade,
  constraint mobile_item_submissions_run_owner_fkey
    foreign key (run_id, user_id)
    references public.pipeline_runs (id, user_id)
    on delete cascade
);

revoke all on table private.mobile_item_submissions
  from public, anon, authenticated, service_role;

create or replace function public.find_mobile_item_submission(
  p_user_id text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns table (
  item_id uuid,
  run_id uuid,
  queue_message_id bigint,
  photo_identity_kind text,
  photo_identity_fingerprint text,
  photo_receipts jsonb,
  is_replay boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_submission private.mobile_item_submissions%rowtype;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Mobile item submission authorization is required';
  end if;
  if coalesce(p_user_id, '') = ''
    or char_length(p_user_id) > 255
    or p_idempotency_key is null
    or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'Invalid mobile item submission replay identity';
  end if;

  select submission.* into v_submission
  from private.mobile_item_submissions submission
  where submission.user_id = p_user_id
    and submission.idempotency_key = p_idempotency_key;
  if not found then return; end if;

  if v_submission.request_fingerprint is distinct from p_request_fingerprint then
    raise exception using
      errcode = '23514',
      message = 'Mobile item submission idempotency conflict';
  end if;
  if v_submission.state = 'uploading' then return; end if;

  item_id := v_submission.item_id;
  run_id := v_submission.run_id;
  queue_message_id := v_submission.queue_message_id;
  photo_identity_kind := v_submission.photo_identity_kind;
  photo_identity_fingerprint := v_submission.photo_identity_fingerprint;
  photo_receipts := v_submission.photo_receipts;
  is_replay := true;
  return next;
end;
$$;

revoke all on function public.find_mobile_item_submission(text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.find_mobile_item_submission(text, uuid, text)
  to service_role;

create or replace function public.begin_mobile_item_submission(
  p_user_id text,
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
  v_submission private.mobile_item_submissions%rowtype;
  v_receipt jsonb;
  v_position integer;
  v_storage_path text;
  v_photo_paths text[] := '{}'::text[];
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Mobile item submission authorization is required';
  end if;
  if coalesce(p_user_id, '') = ''
    or char_length(p_user_id) > 255
    or p_idempotency_key is null
    or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    or p_batch_id is distinct from p_idempotency_key
    or p_cleanup_id is null
    or p_cost_basis < 0
    or p_cost_basis is distinct from round(p_cost_basis, 2)
    or jsonb_typeof(p_photo_receipts) <> 'array'
    or jsonb_array_length(p_photo_receipts) not between 1 and 4 then
    raise exception using
      errcode = '22023',
      message = 'Invalid uploading mobile item submission';
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
        message = 'Invalid planned mobile photo receipt';
    end if;

    v_storage_path := v_receipt->>'storage_path';
    if coalesce(char_length(v_storage_path), 0) < 1
      or char_length(v_storage_path) > 1024
      or left(
        v_storage_path,
        char_length(p_user_id || '/pipeline-staging/' || p_batch_id::text || '/0/')
      ) <> p_user_id || '/pipeline-staging/' || p_batch_id::text || '/0/'
      or v_storage_path like '%://%'
      or v_storage_path like '%?%'
      or v_storage_path like '%#%' then
      raise exception using
        errcode = '22023',
        message = 'Invalid planned mobile photo path';
    end if;
    v_photo_paths := array_append(v_photo_paths, v_storage_path);
  end loop;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'mobile-item-submission:' || p_user_id || ':' || p_idempotency_key::text,
      0
    )
  );

  select submission.* into v_submission
  from private.mobile_item_submissions submission
  where submission.user_id = p_user_id
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
      perform public.record_pipeline_staging_cleanup_intent(
        p_cleanup_id, p_user_id, p_batch_id, v_photo_paths
      );
    end if;
    return false;
  end if;

  perform public.record_pipeline_staging_cleanup_intent(
    p_cleanup_id, p_user_id, p_batch_id, v_photo_paths
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
    p_user_id,
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
  text, uuid, text, uuid, uuid, numeric, jsonb
) from public, anon, authenticated;
grant execute on function public.begin_mobile_item_submission(
  text, uuid, text, uuid, uuid, numeric, jsonb
) to service_role;

create or replace function public.commit_mobile_item_submission(
  p_user_id text,
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_batch_id uuid,
  p_cleanup_id uuid,
  p_cost_basis numeric,
  p_daily_limit integer,
  p_per_minute_limit integer,
  p_photo_identity jsonb,
  p_photo_receipts jsonb
)
returns table (
  item_id uuid,
  run_id uuid,
  queue_message_id bigint,
  photo_identity_kind text,
  photo_identity_fingerprint text,
  photo_receipts jsonb,
  is_replay boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_submission private.mobile_item_submissions%rowtype;
  v_receipt jsonb;
  v_position integer;
  v_storage_path text;
  v_photo_paths text[] := '{}'::text[];
  v_canonical_fingerprint text;
  v_photo_identities jsonb;
  v_item_id uuid;
  v_run_id uuid;
  v_queue_message_id bigint;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Mobile item submission authorization is required';
  end if;
  if coalesce(p_user_id, '') = ''
    or char_length(p_user_id) > 255
    or p_idempotency_key is null
    or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    or p_batch_id is distinct from p_idempotency_key
    or p_cleanup_id is null
    or p_daily_limit not between 1 and 10000
    or p_per_minute_limit not between 1 and 10000
    or p_cost_basis < 0
    or p_cost_basis is distinct from round(p_cost_basis, 2)
    or jsonb_typeof(p_photo_identity) <> 'object'
    or not (p_photo_identity ?& array['kind', 'fingerprint'])
    or (select count(*) from jsonb_object_keys(p_photo_identity)) <> 2
    or p_photo_identity->>'kind' is distinct from 'content_sha256_set_v1'
    or p_photo_identity->>'fingerprint' !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_photo_receipts) <> 'array'
    or jsonb_array_length(p_photo_receipts) not between 1 and 4 then
    raise exception using
      errcode = '22023',
      message = 'Invalid mobile item submission';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'mobile-item-submission:' || p_user_id || ':' || p_idempotency_key::text,
      0
    )
  );

  select submission.* into v_submission
  from private.mobile_item_submissions submission
  where submission.user_id = p_user_id
    and submission.idempotency_key = p_idempotency_key
  for update;
  if not found then
    raise exception using
      errcode = '55000',
      message = 'Uploading mobile item submission is required';
  end if;
  if v_submission.request_fingerprint is distinct from p_request_fingerprint
    or v_submission.batch_id is distinct from p_batch_id
    or v_submission.cleanup_id is distinct from p_cleanup_id
    or v_submission.cost_basis is distinct from p_cost_basis
    or v_submission.photo_receipts is distinct from p_photo_receipts then
    raise exception using
      errcode = '23514',
      message = 'Mobile item submission idempotency conflict';
  end if;
  if v_submission.state = 'committed' then
    item_id := v_submission.item_id;
    run_id := v_submission.run_id;
    queue_message_id := v_submission.queue_message_id;
    photo_identity_kind := v_submission.photo_identity_kind;
    photo_identity_fingerprint := v_submission.photo_identity_fingerprint;
    photo_receipts := v_submission.photo_receipts;
    is_replay := true;
    return next;
    return;
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
        message = 'Invalid verified mobile photo receipt';
    end if;

    v_storage_path := v_receipt->>'storage_path';
    if coalesce(char_length(v_storage_path), 0) < 1
      or char_length(v_storage_path) > 1024
      or left(
        v_storage_path,
        char_length(p_user_id || '/pipeline-staging/' || p_batch_id::text || '/0/')
      ) <> p_user_id || '/pipeline-staging/' || p_batch_id::text || '/0/'
      or v_storage_path like '%://%'
      or v_storage_path like '%?%'
      or v_storage_path like '%#%' then
      raise exception using
        errcode = '22023',
        message = 'Invalid verified mobile photo path';
    end if;
    v_photo_paths := array_append(v_photo_paths, v_storage_path);
  end loop;

  select encode(
    sha256(
      convert_to(
        string_agg(receipt.value->>'content_sha256', E'\n'
          order by receipt.value->>'content_sha256'),
        'UTF8'
      )
    ),
    'hex'
  ) into v_canonical_fingerprint
  from jsonb_array_elements(p_photo_receipts) receipt(value);
  if v_canonical_fingerprint is distinct from p_photo_identity->>'fingerprint' then
    raise exception using
      errcode = '23514',
      message = 'Verified mobile photo identity conflicts with receipts';
  end if;

  perform 1
  from private.pipeline_staging_cleanup_intents intent
  where intent.cleanup_id = p_cleanup_id
    and intent.user_id = p_user_id
    and intent.batch_id = p_batch_id
    and intent.photo_paths is not distinct from v_photo_paths
  for update;
  if not found then
    raise exception using
      errcode = '55000',
      message = 'Durable mobile photo cleanup intent is required';
  end if;

  v_photo_identities := jsonb_build_array(jsonb_build_object(
    'idempotency_key', p_idempotency_key::text,
    'photo_identity_kind', p_photo_identity->>'kind',
    'photo_identity_fingerprint', p_photo_identity->>'fingerprint'
  ));

  select staged.item_id, staged.run_id, staged.queue_message_id
  into v_item_id, v_run_id, v_queue_message_id
  from public.stage_pipeline_batch(
    p_user_id,
    p_batch_id,
    jsonb_build_array(jsonb_build_object(
      'idempotency_key', p_idempotency_key::text,
      'source', 'single',
      'autopilot_enabled', false,
      'photo_paths', to_jsonb(v_photo_paths),
      'cost_basis', p_cost_basis
    )),
    p_daily_limit,
    p_per_minute_limit,
    v_photo_identities
  ) staged;
  if not found or v_item_id is null or v_run_id is null or v_queue_message_id is null then
    raise exception using
      errcode = '55000',
      message = 'Atomic pipeline staging returned no durable run';
  end if;

  update private.mobile_item_submissions submission
  set state = 'committed',
      photo_identity_kind = p_photo_identity->>'kind',
      photo_identity_fingerprint = p_photo_identity->>'fingerprint',
      item_id = v_item_id,
      run_id = v_run_id,
      queue_message_id = v_queue_message_id,
      committed_at = statement_timestamp()
  where submission.user_id = p_user_id
    and submission.idempotency_key = p_idempotency_key
    and submission.state = 'uploading';
  if not found then
    raise exception using
      errcode = '55000',
      message = 'Uploading mobile item submission transition was lost';
  end if;

  item_id := v_item_id;
  run_id := v_run_id;
  queue_message_id := v_queue_message_id;
  photo_identity_kind := p_photo_identity->>'kind';
  photo_identity_fingerprint := p_photo_identity->>'fingerprint';
  photo_receipts := p_photo_receipts;
  is_replay := false;
  return next;
end;
$$;

revoke all on function public.commit_mobile_item_submission(
  text, uuid, text, uuid, uuid, numeric, integer, integer, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.commit_mobile_item_submission(
  text, uuid, text, uuid, uuid, numeric, integer, integer, jsonb, jsonb
) to service_role;
