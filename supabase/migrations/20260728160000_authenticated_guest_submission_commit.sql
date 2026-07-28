-- Issue #332: share the existing atomic mobile commit behind fixed service
-- and capability-bound guest wrappers. The guest path derives its subject from
-- one active project-signed capability and remains publishable-key-only.

create or replace function private.enqueue_pipeline_message_for_subject(
  p_user_id text,
  p_run_id uuid,
  p_schema_version smallint
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.pipeline_runs%rowtype;
  v_message_id bigint;
begin
  if coalesce(p_user_id, '') = '' or char_length(p_user_id) > 255 then
    raise exception using errcode = '22023', message = 'Invalid pipeline queue user id';
  end if;
  if p_schema_version <> 1 then
    raise exception using errcode = '22023', message = 'Unsupported pipeline queue schema version';
  end if;

  select *
  into v_run
  from public.pipeline_runs run
  where run.id = p_run_id
    and run.user_id = p_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Pipeline run not found';
  end if;
  if v_run.schema_version <> p_schema_version then
    raise exception using errcode = '22023', message = 'Pipeline queue schema version mismatch';
  end if;
  if v_run.status <> 'queued' then
    raise exception using errcode = '55000', message = 'Only queued pipeline runs can be enqueued';
  end if;
  if v_run.queue_message_id is not null then
    return v_run.queue_message_id;
  end if;

  -- Intentionally omit `delay`. PGMQ 1.5 added a timestamptz overload that
  -- breaks implicit string casts; the two-argument form works on 1.4.x and 1.5+.
  select *
  into v_message_id
  from pgmq.send(
    'pipeline_jobs',
    jsonb_build_object('run_id', p_run_id, 'schema_version', p_schema_version)
  );

  update public.pipeline_runs run
  set queue_message_id = v_message_id,
      enqueued_at = now()
  where run.id = p_run_id
    and run.user_id = p_user_id;
  return v_message_id;
end;
$$;

create or replace function public.enqueue_pipeline_message(
  p_run_id uuid,
  p_schema_version smallint
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Pipeline queue authorization is required';
  end if;
  if p_schema_version <> 1 then
    raise exception using errcode = '22023', message = 'Unsupported pipeline queue schema version';
  end if;

  select run.user_id
  into v_user_id
  from public.pipeline_runs run
  where run.id = p_run_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Pipeline run not found';
  end if;

  return private.enqueue_pipeline_message_for_subject(
    v_user_id,
    p_run_id,
    p_schema_version
  );
end;
$$;

create or replace function public.stage_pipeline_batch(
  p_user_id text,
  p_batch_id uuid,
  p_entries jsonb,
  p_daily_limit integer,
  p_per_minute_limit integer
)
returns table (
  batch_id uuid,
  batch_position integer,
  idempotency_key text,
  item_id uuid,
  run_id uuid,
  queue_message_id bigint,
  listing_id uuid,
  status text,
  stage text,
  attempt_count integer,
  max_attempts integer,
  safe_failure_message text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_daily_bucket date := (v_now at time zone 'UTC')::date;
  v_minute_bucket timestamp without time zone := date_trunc('minute', v_now at time zone 'UTC');
  v_entry jsonb;
  v_batch_position integer;
  v_idempotency_key text;
  v_source text;
  v_autopilot_enabled boolean;
  v_photo_paths text[];
  v_cost_basis numeric;
  v_photo_path text;
  v_seen_keys text[] := '{}'::text[];
  v_new_count integer := 0;
  v_daily_used integer;
  v_minute_used integer;
  v_item_id uuid;
  v_run_id uuid;
  v_message_id bigint;
  v_existing_batch_id uuid;
  v_existing_batch_position integer;
  v_existing_capture jsonb;
  v_existing_photos text[];
  v_existing_cost_basis numeric;
  v_expected_capture jsonb;
  v_listing_id uuid;
  v_status text;
  v_stage text;
  v_attempt_count integer;
  v_max_attempts integer;
  v_safe_failure_message text;
  v_updated_at timestamptz;
  v_authorized_guest_user_id text;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    v_authorized_guest_user_id :=
      private.assert_verified_guest_capability();
    if p_user_id is distinct from v_authorized_guest_user_id then
      raise exception using
        errcode = '42501',
        message = 'Pipeline staging authorization is required';
    end if;
  end if;
  if coalesce(p_user_id, '') = '' or char_length(p_user_id) > 255 then
    raise exception using errcode = '22023', message = 'Invalid pipeline staging user id';
  end if;
  if p_batch_id is null then
    raise exception using errcode = '22023', message = 'Pipeline batch id is required';
  end if;
  if p_daily_limit not between 1 and 10000
    or p_per_minute_limit not between 1 and 10000 then
    raise exception using errcode = '22023', message = 'Invalid pipeline staging capacity';
  end if;
  if jsonb_typeof(p_entries) <> 'array'
    or jsonb_array_length(p_entries) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'Pipeline staging requires 1 to 200 entries';
  end if;

  -- Serialize quota checks for this seller in a stable daily-then-minute order.
  perform pg_advisory_xact_lock(
    hashtextextended('pipeline-daily:' || p_user_id || ':' || v_daily_bucket::text, 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('pipeline-minute:' || p_user_id || ':' || v_minute_bucket::text, 0)
  );

  -- Validate every entry and count only genuinely new run reservations before
  -- any domain row or queue message is written.
  for v_entry, v_batch_position in
    select entry.value, (entry.position - 1)::integer
    from jsonb_array_elements(p_entries) with ordinality entry(value, position)
  loop
    if jsonb_typeof(v_entry) <> 'object'
      or not (v_entry ?& array[
        'idempotency_key', 'source', 'autopilot_enabled', 'photo_paths', 'cost_basis'
      ])
      or (
        select count(*)
        from jsonb_object_keys(v_entry)
      ) <> 5 then
      raise exception using errcode = '22023', message = 'Invalid pipeline staging entry shape';
    end if;

    v_idempotency_key := v_entry->>'idempotency_key';
    v_source := v_entry->>'source';
    if coalesce(char_length(v_idempotency_key), 0) not between 1 and 128
      or v_source not in ('single', 'batch')
      or jsonb_typeof(v_entry->'autopilot_enabled') <> 'boolean'
      or jsonb_typeof(v_entry->'photo_paths') <> 'array'
      or jsonb_array_length(v_entry->'photo_paths') not between 1 and 5
      or (
        v_source = 'batch'
        and jsonb_array_length(v_entry->'photo_paths') > 4
      )
      or jsonb_typeof(v_entry->'cost_basis') not in ('number', 'null') then
      raise exception using errcode = '22023', message = 'Invalid pipeline staging entry';
    end if;
    if v_idempotency_key = any(v_seen_keys) then
      raise exception using errcode = '22023', message = 'Duplicate pipeline staging idempotency key';
    end if;
    v_seen_keys := array_append(v_seen_keys, v_idempotency_key);

    v_photo_paths := array(
      select value
      from jsonb_array_elements_text(v_entry->'photo_paths') with ordinality photos(value, position)
      order by position
    );
    foreach v_photo_path in array v_photo_paths loop
      if char_length(v_photo_path) > 1024
        or left(v_photo_path, char_length(p_user_id) + 1) <> p_user_id || '/'
        or v_photo_path like '%://%'
        or v_photo_path like '%?%'
        or v_photo_path like '%#%' then
        raise exception using errcode = '22023', message = 'Invalid private photo path';
      end if;
    end loop;

    if not exists (
      select 1
      from public.pipeline_runs run
      where run.user_id = p_user_id
        and run.idempotency_key = v_idempotency_key
    ) then
      v_new_count := v_new_count + 1;
    end if;
  end loop;

  select count(*)
  into v_daily_used
  from (
    select reservation.run_id
    from private.pipeline_run_usage_reservations reservation
    where reservation.user_id = p_user_id
      and reservation.daily_bucket = v_daily_bucket
      and reservation.daily_released_at is null
    union all
    select reservation.reservation_id
    from private.legacy_pipeline_usage_reservations reservation
    where reservation.user_id = p_user_id
      and reservation.daily_bucket = v_daily_bucket
      and reservation.daily_released_at is null
  ) usage;

  select count(*)
  into v_minute_used
  from (
    select reservation.run_id
    from private.pipeline_run_usage_reservations reservation
    where reservation.user_id = p_user_id
      and reservation.minute_bucket = v_minute_bucket
    union all
    select reservation.reservation_id
    from private.legacy_pipeline_usage_reservations reservation
    where reservation.user_id = p_user_id
      and reservation.minute_bucket = v_minute_bucket
  ) usage;

  if v_daily_used + v_new_count > p_daily_limit then
    raise exception using errcode = 'P0001', message = 'Pipeline daily capacity reached';
  end if;
  if v_minute_used + v_new_count > p_per_minute_limit then
    raise exception using errcode = 'P0001', message = 'Pipeline per-minute capacity reached';
  end if;

  for v_entry, v_batch_position in
    select entry.value, (entry.position - 1)::integer
    from jsonb_array_elements(p_entries) with ordinality entry(value, position)
  loop
    v_idempotency_key := v_entry->>'idempotency_key';
    v_source := v_entry->>'source';
    v_autopilot_enabled := (v_entry->>'autopilot_enabled')::boolean;
    v_photo_paths := array(
      select value
      from jsonb_array_elements_text(v_entry->'photo_paths') with ordinality photos(value, position)
      order by position
    );
    v_cost_basis := case
      when jsonb_typeof(v_entry->'cost_basis') = 'null' then null
      else (v_entry->>'cost_basis')::numeric
    end;
    if v_cost_basis is not null and v_cost_basis < 0 then
      raise exception using errcode = '22023', message = 'Pipeline cost basis cannot be negative';
    end if;

    v_expected_capture := jsonb_build_object(
      'source', v_source,
      'autopilot_enabled', v_autopilot_enabled,
      'photo_count', cardinality(v_photo_paths)
    );

    select
      run.id,
      run.item_id,
      run.queue_message_id,
      run.batch_id,
      run.batch_position,
      run.capture_input,
      item.photos,
      item.cost_basis
    into
      v_run_id,
      v_item_id,
      v_message_id,
      v_existing_batch_id,
      v_existing_batch_position,
      v_existing_capture,
      v_existing_photos,
      v_existing_cost_basis
    from public.pipeline_runs run
    join public.items item
      on item.id = run.item_id
     and item.user_id = run.user_id
    where run.user_id = p_user_id
      and run.idempotency_key = v_idempotency_key
    for update of run, item;

    if found then
      if v_existing_batch_id is distinct from p_batch_id
        or v_existing_batch_position is distinct from v_batch_position
        or v_existing_capture is distinct from v_expected_capture
        or v_existing_photos is distinct from v_photo_paths
        or v_existing_cost_basis is distinct from v_cost_basis
        or not exists (
          select 1
          from private.pipeline_run_usage_reservations reservation
          where reservation.run_id = v_run_id
            and reservation.user_id = p_user_id
        ) then
        raise exception using errcode = '23514', message = 'Pipeline idempotency key conflicts with staged input';
      end if;
    else
      insert into public.items (user_id, photos, cost_basis)
      values (p_user_id, v_photo_paths, v_cost_basis)
      returning id into v_item_id;

      insert into public.pipeline_runs (
        user_id,
        item_id,
        idempotency_key,
        batch_id,
        batch_position,
        capture_input
      ) values (
        p_user_id,
        v_item_id,
        v_idempotency_key,
        p_batch_id,
        v_batch_position,
        v_expected_capture
      )
      returning id into v_run_id;

      insert into private.pipeline_run_usage_reservations (
        run_id,
        user_id,
        daily_bucket,
        minute_bucket,
        daily_limit,
        per_minute_limit
      ) values (
        v_run_id,
        p_user_id,
        v_daily_bucket,
        v_minute_bucket,
        p_daily_limit,
        p_per_minute_limit
      );

      v_message_id := null;
    end if;

    if v_message_id is null then
      v_message_id := private.enqueue_pipeline_message_for_subject(
        p_user_id,
        v_run_id,
        1::smallint
      );
    end if;

    select
      run.listing_id,
      run.status,
      run.stage,
      run.attempt_count,
      run.max_attempts,
      run.safe_failure_message,
      run.updated_at
    into
      v_listing_id,
      v_status,
      v_stage,
      v_attempt_count,
      v_max_attempts,
      v_safe_failure_message,
      v_updated_at
    from public.pipeline_runs run
    where run.id = v_run_id;

    batch_id := p_batch_id;
    batch_position := v_batch_position;
    idempotency_key := v_idempotency_key;
    item_id := v_item_id;
    run_id := v_run_id;
    queue_message_id := v_message_id;
    listing_id := v_listing_id;
    status := v_status;
    stage := v_stage;
    attempt_count := v_attempt_count;
    max_attempts := v_max_attempts;
    safe_failure_message := v_safe_failure_message;
    updated_at := v_updated_at;
    return next;
  end loop;
end;
$$;

create or replace function public.stage_pipeline_batch(
  p_user_id text,
  p_batch_id uuid,
  p_entries jsonb,
  p_daily_limit integer,
  p_per_minute_limit integer,
  p_photo_identities jsonb
)
returns table (
  batch_id uuid,
  batch_position integer,
  idempotency_key text,
  item_id uuid,
  run_id uuid,
  queue_message_id bigint,
  listing_id uuid,
  status text,
  stage text,
  attempt_count integer,
  max_attempts integer,
  safe_failure_message text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_identity jsonb;
  v_seen_keys text[] := '{}'::text[];
  v_authorized_guest_user_id text;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    v_authorized_guest_user_id :=
      private.assert_verified_guest_capability();
    if p_user_id is distinct from v_authorized_guest_user_id then
      raise exception using
        errcode = '42501',
        message = 'Pipeline staging authorization is required';
    end if;
  end if;
  if jsonb_typeof(p_entries) <> 'array'
    or jsonb_typeof(p_photo_identities) <> 'array'
    or jsonb_array_length(p_photo_identities) <> jsonb_array_length(p_entries)
    or jsonb_array_length(p_photo_identities) not between 1 and 200 then
    raise exception using
      errcode = '22023',
      message = 'Verified photo identities must match staged entries';
  end if;

  for v_identity in
    select identity_row.value
    from jsonb_array_elements(p_photo_identities) identity_row(value)
  loop
    if jsonb_typeof(v_identity) <> 'object'
      or not (v_identity ?& array[
        'idempotency_key', 'photo_identity_kind', 'photo_identity_fingerprint'
      ])
      or (select count(*) from jsonb_object_keys(v_identity)) <> 3
      or v_identity->>'photo_identity_kind'
        is distinct from 'content_sha256_set_v1'
      or v_identity->>'photo_identity_fingerprint' !~ '^[0-9a-f]{64}$'
      or coalesce(char_length(v_identity->>'idempotency_key'), 0)
        not between 1 and 128
      or v_identity->>'idempotency_key' = any(v_seen_keys)
      or not exists (
        select 1
        from jsonb_array_elements(p_entries) entry(value)
        where entry.value->>'idempotency_key'
          = v_identity->>'idempotency_key'
      ) then
      raise exception using
        errcode = '22023',
        message = 'Invalid verified photo identity';
    end if;
    v_seen_keys := array_append(
      v_seen_keys, v_identity->>'idempotency_key'
    );

    if exists (
      select 1
      from public.pipeline_runs run
      where run.user_id = p_user_id
        and run.idempotency_key = v_identity->>'idempotency_key'
        and (
          run.photo_identity_kind
            is distinct from v_identity->>'photo_identity_kind'
          or run.photo_identity_fingerprint
            is distinct from v_identity->>'photo_identity_fingerprint'
        )
    ) then
      raise exception using
        errcode = '23514',
        message = 'Pipeline idempotency key conflicts with verified photo identity';
    end if;
  end loop;

  if exists (
    select 1
    from jsonb_array_elements(p_entries) entry(value)
    where not (entry.value->>'idempotency_key' = any(v_seen_keys))
  ) then
    raise exception using
      errcode = '22023',
      message = 'Every staged entry requires one verified photo identity';
  end if;

  perform set_config(
    'snaplist.verified_photo_identities', p_photo_identities::text, true
  );

  return query
  select staged.*
  from public.stage_pipeline_batch(
    p_user_id,
    p_batch_id,
    p_entries,
    p_daily_limit,
    p_per_minute_limit
  ) staged;

  -- The delegated staging seam acquires the seller's quota/advisory locks. A
  -- concurrent verified or legacy caller may have created the run after the
  -- optimistic check above, so revalidate while those transaction locks are
  -- still held before returning any replay receipt.
  if exists (
    select 1
    from jsonb_array_elements(p_photo_identities) identity_row(value)
    left join public.pipeline_runs run
      on run.user_id = p_user_id
     and run.idempotency_key = identity_row.value->>'idempotency_key'
    where run.id is null
      or run.photo_identity_kind
        is distinct from identity_row.value->>'photo_identity_kind'
      or run.photo_identity_fingerprint
        is distinct from identity_row.value->>'photo_identity_fingerprint'
  ) then
    raise exception using
      errcode = '23514',
      message = 'Pipeline idempotency key conflicts with verified photo identity';
  end if;

  perform set_config('snaplist.verified_photo_identities', '', true);
end;
$$;

create or replace function private.commit_mobile_item_submission_for_subject(
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
  is_replay boolean,
  denial_reason text
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
  v_error_message text;
begin
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
    or jsonb_array_length(p_photo_receipts) not between 1 and 5 then
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

  begin
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
  exception
    when sqlstate 'P0001' then
      get stacked diagnostics v_error_message = message_text;
      denial_reason := case v_error_message
        when 'AI item credit unavailable: snaplist-pro-required'
          then 'snaplist-pro-required'
        when 'AI item credit unavailable: storekit-entitlement-unavailable'
          then 'storekit-entitlement-unavailable'
        when 'AI item credit unavailable: monthly-allowance-reached'
          then 'monthly-allowance-reached'
        when 'Pipeline daily capacity reached'
          then 'daily-capacity-reached'
        when 'Pipeline per-minute capacity reached'
          then 'per-minute-capacity-reached'
        else null
      end;
      if denial_reason is null then
        raise;
      end if;

      item_id := null;
      run_id := null;
      queue_message_id := null;
      photo_identity_kind := null;
      photo_identity_fingerprint := null;
      photo_receipts := null;
      is_replay := false;
      return next;
      return;
  end;

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

  delete from private.pipeline_staging_cleanup_intents intent
  where intent.cleanup_id = p_cleanup_id
    and intent.user_id = p_user_id
    and intent.batch_id = p_batch_id
    and intent.photo_paths is not distinct from v_photo_paths;
  if not found then
    raise exception using
      errcode = '55000',
      message = 'Atomic mobile photo cleanup resolution is required';
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
  v_committed record;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Mobile item submission authorization is required';
  end if;

  select committed.* into v_committed
  from private.commit_mobile_item_submission_for_subject(
    p_user_id,
    p_idempotency_key,
    p_request_fingerprint,
    p_batch_id,
    p_cleanup_id,
    p_cost_basis,
    p_daily_limit,
    p_per_minute_limit,
    p_photo_identity,
    p_photo_receipts
  ) committed;
  if not found then
    raise exception using
      errcode = '55000',
      message = 'Atomic mobile item commit returned no outcome';
  end if;
  if v_committed.denial_reason is not null then
    raise exception using
      errcode = 'P0001',
      message = case v_committed.denial_reason
        when 'snaplist-pro-required'
          then 'AI item credit unavailable: snaplist-pro-required'
        when 'storekit-entitlement-unavailable'
          then 'AI item credit unavailable: storekit-entitlement-unavailable'
        when 'monthly-allowance-reached'
          then 'AI item credit unavailable: monthly-allowance-reached'
        when 'daily-capacity-reached'
          then 'Pipeline daily capacity reached'
        when 'per-minute-capacity-reached'
          then 'Pipeline per-minute capacity reached'
        else 'Mobile item submission denied'
      end;
  end if;

  item_id := v_committed.item_id;
  run_id := v_committed.run_id;
  queue_message_id := v_committed.queue_message_id;
  photo_identity_kind := v_committed.photo_identity_kind;
  photo_identity_fingerprint := v_committed.photo_identity_fingerprint;
  photo_receipts := v_committed.photo_receipts;
  is_replay := v_committed.is_replay;
  return next;
end;
$$;

create or replace function public.commit_mobile_item_submission(
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
  is_replay boolean,
  denial_reason text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := private.assert_verified_guest_capability();
begin
  return query
  select committed.*
  from private.commit_mobile_item_submission_for_subject(
    v_user_id,
    p_idempotency_key,
    p_request_fingerprint,
    p_batch_id,
    p_cleanup_id,
    p_cost_basis,
    p_daily_limit,
    p_per_minute_limit,
    p_photo_identity,
    p_photo_receipts
  ) committed;
end;
$$;

create or replace function public.resolve_pipeline_staging_cleanup_intent(
  p_cleanup_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := coalesce(auth.jwt()->>'role', '');
begin
  if p_cleanup_id is null then
    raise exception using
      errcode = '22023',
      message = 'Pipeline cleanup intent is required';
  end if;
  if v_role <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Pipeline cleanup authorization is required';
  end if;

  delete from private.pipeline_staging_cleanup_intents intent
  where intent.cleanup_id = p_cleanup_id;
  return found;
end;
$$;

create or replace function public.complete_pipeline_storage_cleanup(
  p_job_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_probe private.pipeline_storage_cleanup_jobs%rowtype;
  v_job private.pipeline_storage_cleanup_jobs%rowtype;
  v_submission_probe private.mobile_item_submissions%rowtype;
  v_submission private.mobile_item_submissions%rowtype;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Pipeline operations authorization is required';
  end if;

  select job.* into v_probe
  from private.pipeline_storage_cleanup_jobs job
  where job.job_id = p_job_id;
  if not found then return false; end if;

  if v_probe.source_type = 'staging'
    and v_probe.fence_generation is not null then
    select submission.* into v_submission_probe
    from private.mobile_item_submissions submission
    where submission.cleanup_id = v_probe.source_id;
    if not found then return false; end if;

    perform pg_advisory_xact_lock(
      hashtextextended(
        'mobile-item-submission:'
          || v_submission_probe.user_id || ':'
          || v_submission_probe.idempotency_key::text,
        0
      )
    );

    select submission.* into v_submission
    from private.mobile_item_submissions submission
    where submission.cleanup_id = v_probe.source_id
      and submission.user_id = v_submission_probe.user_id
      and submission.idempotency_key = v_submission_probe.idempotency_key
    for update;
    if not found then return false; end if;
  end if;

  select job.* into v_job
  from private.pipeline_storage_cleanup_jobs job
  where job.job_id = p_job_id
    and job.state = 'running'
    and job.lease_token = p_lease_token
    and job.lease_expires_at > statement_timestamp()
  for update;
  if not found then return false; end if;

  if v_job.source_type = 'staging'
    and v_job.fence_generation is not null then
    if v_job.delete_authorized_at is null
      or v_submission.state is distinct from 'uploading'
      or v_submission.cleanup_id is distinct from v_job.source_id
      or v_submission.cleanup_generation
        is distinct from v_job.fence_generation then
      return false;
    end if;

    delete from private.pipeline_storage_cleanup_jobs job
    where job.job_id = v_job.job_id
      and job.lease_token = p_lease_token;
    if not found then return false; end if;

    delete from private.mobile_item_submissions submission
    where submission.user_id = v_submission.user_id
      and submission.idempotency_key = v_submission.idempotency_key
      and submission.cleanup_id = v_job.source_id
      and submission.state = 'uploading'
      and submission.cleanup_generation = v_job.fence_generation;
    if not found then
      raise exception using
        errcode = '55000',
        message = 'Authenticated guest retention ledger completion was lost';
    end if;
    return true;
  end if;

  if v_job.source_type = 'guest_claim_copy'
    and v_job.resweep_requested
    and not v_job.guest_copy_final_sweep_armed then
    update private.pipeline_storage_cleanup_jobs job
    set state = 'pending',
        attempt_count = greatest(0, v_job.max_attempts - 1),
        available_at = statement_timestamp() + interval '5 minutes',
        lease_token = null,
        lease_expires_at = null,
        resweep_requested = false,
        guest_copy_final_sweep_armed = true,
        safe_error = null,
        updated_at = statement_timestamp()
    where job.job_id = v_job.job_id;
    return true;
  end if;

  if v_job.source_type = 'guest_claim_copy'
    and not v_job.guest_copy_writer_quiesced then
    if v_job.attempt_count >= v_job.max_attempts then
      update private.pipeline_storage_cleanup_jobs job
      set state = 'dead',
          lease_token = null,
          lease_expires_at = null,
          safe_error = 'Guest claim copy cleanup requires reconciliation.',
          updated_at = statement_timestamp()
      where job.job_id = v_job.job_id;
    else
      update private.pipeline_storage_cleanup_jobs job
      set state = 'pending',
          available_at = statement_timestamp() + interval '5 minutes',
          lease_token = null,
          lease_expires_at = null,
          resweep_requested = false,
          safe_error = null,
          updated_at = statement_timestamp()
      where job.job_id = v_job.job_id;
    end if;
    return true;
  end if;

  delete from private.pipeline_storage_cleanup_jobs job
  where job.job_id = v_job.job_id;
  return found;
end;
$$;

revoke all on function public.complete_pipeline_storage_cleanup(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.complete_pipeline_storage_cleanup(uuid, uuid)
  to service_role;

revoke all on function private.commit_mobile_item_submission_for_subject(
  text, uuid, text, uuid, uuid, numeric, integer, integer, jsonb, jsonb
) from public, anon, authenticated, service_role;

revoke all on function private.enqueue_pipeline_message_for_subject(
  text, uuid, smallint
) from public, anon, authenticated, service_role;

revoke all on function public.enqueue_pipeline_message(uuid, smallint)
  from public, anon, authenticated, service_role;
grant execute on function public.enqueue_pipeline_message(uuid, smallint)
  to service_role;

revoke all on function public.stage_pipeline_batch(
  text, uuid, jsonb, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.stage_pipeline_batch(
  text, uuid, jsonb, integer, integer
) to service_role;

revoke all on function public.stage_pipeline_batch(
  text, uuid, jsonb, integer, integer, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.stage_pipeline_batch(
  text, uuid, jsonb, integer, integer, jsonb
) to service_role;

revoke all on function public.commit_mobile_item_submission(
  text, uuid, text, uuid, uuid, numeric, integer, integer, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.commit_mobile_item_submission(
  text, uuid, text, uuid, uuid, numeric, integer, integer, jsonb, jsonb
) to service_role;

revoke all on function public.commit_mobile_item_submission(
  uuid, text, uuid, uuid, numeric, integer, integer, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.commit_mobile_item_submission(
  uuid, text, uuid, uuid, numeric, integer, integer, jsonb, jsonb
) to authenticated;

revoke all on function public.resolve_pipeline_staging_cleanup_intent(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.resolve_pipeline_staging_cleanup_intent(uuid)
  to service_role;
