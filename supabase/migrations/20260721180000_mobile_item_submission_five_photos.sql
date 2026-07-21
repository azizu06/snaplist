-- Issue #352: extend the existing verified single-item submission spine to five photos.
-- Historical migrations remain immutable. Full function bodies below are required by
-- PostgreSQL CREATE OR REPLACE; differential tests permit only the bounded changes.

alter table private.mobile_item_submissions
  drop constraint mobile_item_submissions_photo_receipts_check,
  add constraint mobile_item_submissions_photo_receipts_check check (
    jsonb_typeof(photo_receipts) = 'array'
    and jsonb_array_length(photo_receipts) between 1 and 5
  );

alter table public.pipeline_runs
  drop constraint pipeline_runs_capture_input_check,
  add constraint pipeline_runs_capture_input_check check (
    capture_input is null
    or (
      jsonb_typeof(capture_input) = 'object'
      and capture_input ?& array['source', 'autopilot_enabled', 'photo_count']
      and (
        capture_input - array['source', 'autopilot_enabled', 'photo_count']::text[]
      ) = '{}'::jsonb
      and capture_input->>'source' in ('single', 'batch')
      and jsonb_typeof(capture_input->'autopilot_enabled') = 'boolean'
      and jsonb_typeof(capture_input->'photo_count') = 'number'
      and (
        capture_input->>'photo_count' in ('0', '1', '2', '3', '4')
        or (
          capture_input->>'source' = 'single'
          and capture_input->>'photo_count' = '5'
        )
      )
    )
  );

alter table private.guest_draft_recoveries
  drop constraint guest_draft_recoveries_object_count_check,
  add constraint guest_draft_recoveries_object_count_check check (
    storage_object_count between 1 and 5
  );

create or replace function public.find_pipeline_batch_replay(
  p_user_id text,
  p_batch_id uuid,
  p_entries jsonb
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
  v_entry jsonb;
  v_batch_position integer;
  v_idempotency_key text;
  v_source text;
  v_autopilot_enabled boolean;
  v_photo_count integer;
  v_cost_basis numeric;
  v_seen_keys text[] := '{}'::text[];
  v_match_count integer;
  v_item_id uuid;
  v_run_id uuid;
  v_message_id bigint;
  v_existing_batch_id uuid;
  v_existing_batch_position integer;
  v_existing_capture jsonb;
  v_existing_cost_basis numeric;
  v_listing_id uuid;
  v_status text;
  v_stage text;
  v_attempt_count integer;
  v_max_attempts integer;
  v_safe_failure_message text;
  v_updated_at timestamptz;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Pipeline replay authorization is required';
  end if;
  if coalesce(p_user_id, '') = '' or char_length(p_user_id) > 255 or p_batch_id is null then
    raise exception using errcode = '22023', message = 'Invalid pipeline replay identity';
  end if;
  if jsonb_typeof(p_entries) <> 'array'
    or jsonb_array_length(p_entries) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'Pipeline replay requires 1 to 200 entries';
  end if;

  for v_entry in select value from jsonb_array_elements(p_entries)
  loop
    if jsonb_typeof(v_entry) <> 'object'
      or not (v_entry ?& array[
        'idempotency_key', 'source', 'autopilot_enabled', 'photo_count', 'cost_basis'
      ])
      or (select count(*) from jsonb_object_keys(v_entry)) <> 5
      or coalesce(char_length(v_entry->>'idempotency_key'), 0) not between 1 and 128
      or v_entry->>'source' not in ('single', 'batch')
      or jsonb_typeof(v_entry->'autopilot_enabled') <> 'boolean'
      or jsonb_typeof(v_entry->'photo_count') <> 'number'
      or (v_entry->>'photo_count')::integer not between 1 and 5
      or (
        v_entry->>'source' = 'batch'
        and (v_entry->>'photo_count')::integer > 4
      )
      or jsonb_typeof(v_entry->'cost_basis') not in ('number', 'null') then
      raise exception using errcode = '22023', message = 'Invalid pipeline replay entry';
    end if;
    v_idempotency_key := v_entry->>'idempotency_key';
    if v_idempotency_key = any(v_seen_keys) then
      raise exception using errcode = '22023', message = 'Duplicate pipeline replay idempotency key';
    end if;
    v_seen_keys := array_append(v_seen_keys, v_idempotency_key);
  end loop;

  select count(*)
  into v_match_count
  from public.pipeline_runs run
  where run.user_id = p_user_id
    and run.idempotency_key = any(v_seen_keys);

  if v_match_count = 0 then
    return;
  end if;
  if v_match_count <> jsonb_array_length(p_entries) then
    raise exception using errcode = '23514', message = 'Pipeline replay is partial or conflicting';
  end if;

  for v_entry, v_batch_position in
    select entry.value, (entry.position - 1)::integer
    from jsonb_array_elements(p_entries) with ordinality entry(value, position)
  loop
    v_idempotency_key := v_entry->>'idempotency_key';
    v_source := v_entry->>'source';
    v_autopilot_enabled := (v_entry->>'autopilot_enabled')::boolean;
    v_photo_count := (v_entry->>'photo_count')::integer;
    v_cost_basis := case
      when jsonb_typeof(v_entry->'cost_basis') = 'null' then null
      else (v_entry->>'cost_basis')::numeric
    end;
    if v_cost_basis is not null and v_cost_basis < 0 then
      raise exception using errcode = '22023', message = 'Pipeline replay cost basis cannot be negative';
    end if;

    select
      run.id,
      run.item_id,
      run.queue_message_id,
      run.batch_id,
      run.batch_position,
      run.capture_input,
      item.cost_basis,
      run.listing_id,
      run.status,
      run.stage,
      run.attempt_count,
      run.max_attempts,
      run.safe_failure_message,
      run.updated_at
    into
      v_run_id,
      v_item_id,
      v_message_id,
      v_existing_batch_id,
      v_existing_batch_position,
      v_existing_capture,
      v_existing_cost_basis,
      v_listing_id,
      v_status,
      v_stage,
      v_attempt_count,
      v_max_attempts,
      v_safe_failure_message,
      v_updated_at
    from public.pipeline_runs run
    join public.items item
      on item.id = run.item_id
     and item.user_id = run.user_id
    where run.user_id = p_user_id
      and run.idempotency_key = v_idempotency_key;

    if not found
      or v_message_id is null
      or v_existing_batch_id is distinct from p_batch_id
      or v_existing_batch_position is distinct from v_batch_position
      or v_existing_capture is distinct from jsonb_build_object(
        'source', v_source,
        'autopilot_enabled', v_autopilot_enabled,
        'photo_count', v_photo_count
      )
      or v_existing_cost_basis is distinct from v_cost_basis then
      raise exception using errcode = '23514', message = 'Pipeline replay conflicts with staged input';
    end if;

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
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Pipeline staging authorization is required';
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
      v_message_id := public.enqueue_pipeline_message(v_run_id, 1::smallint);
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

create or replace function private.reserve_ai_item_credit_for_pipeline_run()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_photo_paths text[];
  v_photo_set_fingerprint text;
  v_period public.ai_item_allowance_periods%rowtype;
  v_used integer;
  v_existing public.ai_item_credit_reservations%rowtype;
  v_now timestamptz := statement_timestamp();
begin
  if new.capture_input is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('ai-item-credit:' || new.user_id, 0)
  );

  select item.photos into v_photo_paths
  from public.items item
  where item.id = new.item_id
    and item.user_id = new.user_id
  for update;
  if not found or cardinality(v_photo_paths) not between 1 and 5 then
    raise exception using
      errcode = '23503',
      message = 'AI-item credit run has no owned immutable photo set';
  end if;
  v_photo_set_fingerprint := encode(
    sha256(convert_to(array_to_json(v_photo_paths)::text, 'UTF8')),
    'hex'
  );

  insert into public.ai_item_allowance_periods (
    user_id,
    source,
    period_key,
    period_start,
    expires_date,
    state,
    allowance
  ) values (
    new.user_id,
    'included',
    'included-first-run',
    '-infinity'::timestamptz,
    'infinity'::timestamptz,
    'active',
    1
  )
  on conflict (user_id, source, period_key) do nothing;

  select * into v_period
  from public.ai_item_allowance_periods period
  where period.user_id = new.user_id
    and period.source = 'included'
    and period.period_key = 'included-first-run'
  for update;

  select count(*) into v_used
  from public.ai_item_credit_reservations reservation
  where reservation.allowance_period_id = v_period.id
    and (
      reservation.state in ('reserved', 'settled')
      or (
        reservation.state = 'restored'
        and reservation.retry_reservation_count > reservation.retry_restore_count
      )
    );

  if v_used >= v_period.allowance then
    select * into v_period
    from public.ai_item_allowance_periods period
    where period.user_id = new.user_id
      and period.source = 'storekit'
      and period.period_start <= v_now
    order by period.period_start desc, period.expires_date desc
    limit 1
    for update;

    if not found then
      raise exception using
        errcode = 'P0001',
        message = 'AI item credit unavailable: snaplist-pro-required';
    end if;
    if not (
      (v_period.state = 'active' and v_now < v_period.expires_date)
      or (
        v_period.state = 'grace'
        and v_period.grace_expires_date is not null
        and v_now < v_period.grace_expires_date
      )
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'AI item credit unavailable: storekit-entitlement-unavailable';
    end if;

    select count(*) into v_used
    from public.ai_item_credit_reservations reservation
    where reservation.allowance_period_id = v_period.id
      and (
        reservation.state in ('reserved', 'settled')
        or (
          reservation.state = 'restored'
          and reservation.retry_reservation_count > reservation.retry_restore_count
        )
      );
    if v_used >= v_period.allowance then
      raise exception using
        errcode = 'P0001',
        message = 'AI item credit unavailable: monthly-allowance-reached';
    end if;
  end if;

  insert into public.ai_item_credit_reservations (
    user_id,
    pipeline_run_id,
    item_id,
    allowance_period_id,
    logical_run_key,
    photo_set_fingerprint
  ) values (
    new.user_id,
    new.id,
    new.item_id,
    v_period.id,
    new.idempotency_key,
    v_photo_set_fingerprint
  )
  on conflict (pipeline_run_id) do nothing;

  select * into v_existing
  from public.ai_item_credit_reservations reservation
  where reservation.pipeline_run_id = new.id;
  if not found
    or v_existing.user_id is distinct from new.user_id
    or v_existing.item_id is distinct from new.item_id
    or v_existing.logical_run_key is distinct from new.idempotency_key
    or v_existing.photo_set_fingerprint is distinct from v_photo_set_fingerprint then
    raise exception using
      errcode = '23514',
      message = 'AI-item credit reservation identity conflicts';
  end if;
  return new;
end;
$$;

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
    or jsonb_array_length(p_photo_receipts) not between 1 and 5 then
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
      -- The recorder locks and validates the exact existing intent. Renew it in
      -- this same transaction before returning control to Storage so retention
      -- cannot claim a stale replay intent between begin and commit.
      update private.pipeline_staging_cleanup_intents intent
      set cleanup_after = greatest(
        intent.cleanup_after,
        statement_timestamp() + interval '24 hours'
      )
      where intent.cleanup_id = p_cleanup_id
        and intent.user_id = p_user_id
        and intent.batch_id = p_batch_id
        and intent.photo_paths is not distinct from v_photo_paths;
      if not found then
        raise exception using
          errcode = '55000',
          message = 'Durable mobile photo cleanup renewal is required';
      end if;
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

create or replace function private.queue_guest_recovery_storage_cleanup(
  p_recovery private.guest_draft_recoveries
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_paths text[];
begin
  v_paths := private.guest_manifest_source_paths(p_recovery.storage_manifest);
  if cardinality(v_paths) not between 1 and 5 then
    raise exception using
      errcode = '23514',
      message = 'Guest recovery has no bounded Storage cleanup manifest';
  end if;

  insert into private.pipeline_storage_cleanup_jobs (
    source_type,
    source_id,
    photo_paths
  ) values (
    'guest_recovery',
    p_recovery.id,
    v_paths
  )
  on conflict (source_type, source_id) do nothing;
end;
$$;

create or replace function private.queue_guest_claim_copy_cleanup(
  p_recovery private.guest_draft_recoveries,
  p_target_user_id text,
  p_claim_lease_token uuid,
  p_writer_quiesced boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_paths text[];
  v_available_at timestamptz := statement_timestamp() + interval '5 minutes';
begin
  if coalesce(char_length(p_target_user_id), 0) not between 1 and 255
    or p_target_user_id !~ '^[A-Za-z0-9_-]+$'
    or p_target_user_id = p_recovery.guest_user_id
    or p_claim_lease_token is null
    or p_recovery.storage_object_count not between 1 and 5 then
    raise exception using
      errcode = '23514',
      message = 'Guest claim copy cleanup requires an exact bounded lease';
  end if;

  if p_recovery.state = 'claimed'
    and p_recovery.claim_target_user_id = p_target_user_id
    and p_recovery.claimed_lease_token = p_claim_lease_token then
    return false;
  end if;

  v_paths := private.guest_claim_destination_paths(
    p_recovery.id,
    p_target_user_id,
    p_claim_lease_token,
    p_recovery.storage_object_count
  );
  if cardinality(v_paths) not between 1 and 5 then
    raise exception using
      errcode = '23514',
      message = 'Guest claim copy cleanup is not bounded';
  end if;

  if p_recovery.state = 'copying'
    and p_recovery.claim_target_user_id = p_target_user_id
    and p_recovery.claim_lease_token = p_claim_lease_token then
    v_available_at := greatest(
      v_available_at,
      p_recovery.claim_lease_expires_at + interval '5 minutes'
    );
  end if;

  insert into private.pipeline_storage_cleanup_jobs as cleanup_job (
    source_type,
    source_id,
    photo_paths,
    available_at,
    guest_copy_writer_quiesced,
    resweep_requested,
    guest_copy_final_sweep_armed
  ) values (
    'guest_claim_copy',
    p_claim_lease_token,
    v_paths,
    v_available_at,
    p_writer_quiesced,
    p_writer_quiesced,
    false
  )
  on conflict (source_type, source_id) do update
  set state = case
        when cleanup_job.state = 'dead'
          and excluded.guest_copy_writer_quiesced
          and not cleanup_job.guest_copy_final_sweep_armed
        then 'pending'
        else cleanup_job.state
      end,
      attempt_count = case
        when cleanup_job.state = 'dead'
          and excluded.guest_copy_writer_quiesced
          and not cleanup_job.guest_copy_final_sweep_armed
        then greatest(0, cleanup_job.max_attempts - 1)
        else cleanup_job.attempt_count
      end,
      available_at = case
        when cleanup_job.state = 'dead'
          and excluded.guest_copy_writer_quiesced
          and not cleanup_job.guest_copy_final_sweep_armed
        then statement_timestamp() + interval '5 minutes'
        else cleanup_job.available_at
      end,
      safe_error = case
        when cleanup_job.state = 'dead'
          and excluded.guest_copy_writer_quiesced
          and not cleanup_job.guest_copy_final_sweep_armed
        then null
        else cleanup_job.safe_error
      end,
      guest_copy_writer_quiesced =
        cleanup_job.guest_copy_writer_quiesced
        or excluded.guest_copy_writer_quiesced,
      resweep_requested = case
        when cleanup_job.state = 'dead'
          and excluded.guest_copy_writer_quiesced
          and not cleanup_job.guest_copy_final_sweep_armed
        then false
        else cleanup_job.resweep_requested
          or (
            excluded.resweep_requested
            and not cleanup_job.guest_copy_final_sweep_armed
          )
      end,
      guest_copy_final_sweep_armed =
        cleanup_job.guest_copy_final_sweep_armed
        or (
          cleanup_job.state = 'dead'
          and excluded.guest_copy_writer_quiesced
          and not cleanup_job.guest_copy_final_sweep_armed
        ),
      updated_at = statement_timestamp()
  where cleanup_job.source_type = 'guest_claim_copy';
  return true;
end;
$$;

create or replace function public.register_guest_draft_recovery(
  p_recovery_id uuid,
  p_guest_user_id text,
  p_pipeline_run_id uuid,
  p_recovery_token_hash text,
  p_encrypted_artifact jsonb,
  p_storage_manifest jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.pipeline_runs%rowtype;
  v_recovery private.guest_draft_recoveries%rowtype;
  v_reservation public.ai_item_credit_reservations%rowtype;
  v_object jsonb;
  v_source_paths text[];
  v_distinct_paths integer;
  v_distinct_nonces integer;
begin
  perform private.guest_claim_service_role_required();

  if p_recovery_id is null
    or p_pipeline_run_id is null
    or coalesce(char_length(p_guest_user_id), 0) not between 1 and 255
    or p_guest_user_id !~ '^[A-Za-z0-9_-]+$'
    or coalesce(p_recovery_token_hash, '') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_encrypted_artifact) is distinct from 'object'
    or p_encrypted_artifact - array[
      'version', 'algorithm', 'keyId', 'keyEnvelope', 'nonce', 'tag', 'ciphertext'
    ]::text[] <> '{}'::jsonb
    or not p_encrypted_artifact ?& array[
      'version', 'algorithm', 'keyId', 'keyEnvelope', 'nonce', 'tag', 'ciphertext'
    ]
    or p_encrypted_artifact->>'version' <> '1'
    or p_encrypted_artifact->>'algorithm' <> 'aes-256-gcm'
    or coalesce(p_encrypted_artifact->>'keyId', '') !~ '^[A-Za-z0-9_-]{1,128}$'
    or not coalesce(private.valid_guest_base64(
      p_encrypted_artifact->>'keyEnvelope',
      p_min_bytes => 1,
      p_max_bytes => 65536
    ), false)
    or not coalesce(private.valid_guest_base64(
      p_encrypted_artifact->>'nonce',
      p_exact_bytes => 12
    ), false)
    or not coalesce(private.valid_guest_base64(
      p_encrypted_artifact->>'tag',
      p_exact_bytes => 16
    ), false)
    or not coalesce(private.valid_guest_base64(
      p_encrypted_artifact->>'ciphertext',
      p_min_bytes => 1,
      p_max_bytes => 2097152
    ), false)
    or pg_column_size(p_encrypted_artifact) > 2 * 1024 * 1024
    or jsonb_typeof(p_storage_manifest) is distinct from 'array'
    or jsonb_array_length(p_storage_manifest) not between 1 and 5 then
    raise exception using
      errcode = '22023',
      message = 'Invalid encrypted guest recovery artifact';
  end if;

  for v_object in
    select entry.value
    from jsonb_array_elements(p_storage_manifest) entry(value)
  loop
    if jsonb_typeof(v_object) is distinct from 'object'
      or v_object - array[
        'sourcePath', 'sha256', 'byteLength', 'encryption'
      ]::text[]
        <> '{}'::jsonb
      or not v_object ?& array[
        'sourcePath', 'sha256', 'byteLength', 'encryption'
      ]
      or jsonb_typeof(v_object->'sourcePath') is distinct from 'string'
      or jsonb_typeof(v_object->'sha256') is distinct from 'string'
      or jsonb_typeof(v_object->'byteLength') is distinct from 'number'
      or jsonb_typeof(v_object->'encryption') is distinct from 'object'
      or (v_object->'encryption') - array[
        'algorithm', 'keyId', 'nonce', 'tag'
      ]::text[] <> '{}'::jsonb
      or not (v_object->'encryption') ?& array[
        'algorithm', 'keyId', 'nonce', 'tag'
      ]
      or v_object->'encryption'->>'algorithm' <> 'aes-256-gcm'
      or v_object->'encryption'->>'keyId' <> p_encrypted_artifact->>'keyId'
      or not coalesce(private.valid_guest_base64(
        v_object->'encryption'->>'nonce',
        p_exact_bytes => 12
      ), false)
      or not coalesce(private.valid_guest_base64(
        v_object->'encryption'->>'tag',
        p_exact_bytes => 16
      ), false)
      or left(
        v_object->>'sourcePath', char_length(p_guest_user_id) + 1
      ) <> p_guest_user_id || '/'
      or char_length(v_object->>'sourcePath') <= char_length(p_guest_user_id) + 1
      or v_object->>'sourcePath' like '%://%'
      or v_object->>'sourcePath' ~ '[?#]'
      or v_object->>'sourcePath' ~ '(^|/)\.\.?(/|$)'
      or char_length(v_object->>'sourcePath') > 1024
      or coalesce(v_object->>'sha256', '') !~ '^[0-9a-f]{64}$'
      or coalesce(v_object->>'byteLength', '') !~ '^[0-9]+$'
      or (v_object->>'byteLength')::bigint not between 1 and 52428800 then
      raise exception using
        errcode = '22023',
        message = 'Invalid private Storage recovery manifest';
    end if;
  end loop;

  v_source_paths := private.guest_manifest_source_paths(p_storage_manifest);
  select count(distinct entry.value->>'sourcePath')
  into v_distinct_paths
  from jsonb_array_elements(p_storage_manifest) entry(value);
  if v_distinct_paths <> cardinality(v_source_paths) then
    raise exception using
      errcode = '22023',
      message = 'Guest recovery Storage paths must be unique';
  end if;
  select count(distinct entry.value->'encryption'->>'nonce')
  into v_distinct_nonces
  from jsonb_array_elements(p_storage_manifest) entry(value);
  if v_distinct_nonces <> jsonb_array_length(p_storage_manifest)
    or exists (
      select 1
      from jsonb_array_elements(p_storage_manifest) entry(value)
      where entry.value->'encryption'->>'nonce' = p_encrypted_artifact->>'nonce'
    ) then
    raise exception using
      errcode = '22023',
      message = 'Guest recovery AES-GCM nonces must be unique';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('guest-recovery:' || p_recovery_id::text, 0)
  );

  select * into v_recovery
  from private.guest_draft_recoveries recovery
  where recovery.id = p_recovery_id
  for update;
  if found then
    if v_recovery.pipeline_run_id is distinct from p_pipeline_run_id
      or v_recovery.guest_user_id is distinct from p_guest_user_id
      or v_recovery.recovery_token_hash is distinct from p_recovery_token_hash
      or (
        v_recovery.state in ('claimable', 'copying')
        and (
          v_recovery.encrypted_artifact is distinct from p_encrypted_artifact
          or v_recovery.storage_manifest is distinct from p_storage_manifest
        )
      ) then
      raise exception using
        errcode = '23514',
        message = 'Guest recovery registration identity conflicts';
    end if;
    if v_recovery.state in ('claimed', 'expired') then
      return private.guest_terminal_outcome(v_recovery);
    end if;
    if statement_timestamp() >= v_recovery.expires_at then
      v_recovery := private.expire_guest_recovery_locked(v_recovery.id);
      return private.guest_terminal_outcome(v_recovery);
    end if;
    return jsonb_build_object(
      'outcome', 'recoverable',
      'recoveryId', v_recovery.id,
      'itemId', v_recovery.item_id,
      'runId', v_recovery.pipeline_run_id,
      'draftId', v_recovery.draft_id,
      'usableDraftAt', v_recovery.usable_draft_at,
      'expiresAt', v_recovery.expires_at,
      'encryptedArtifact', v_recovery.encrypted_artifact,
      'purgeLocalRecovery', false
    );
  end if;

  select * into v_recovery
  from private.guest_draft_recoveries recovery
  where recovery.pipeline_run_id = p_pipeline_run_id
  for update;
  if found then
    raise exception using
      errcode = '23514',
      message = 'Guest recovery run is already registered';
  end if;

  select * into v_run
  from public.pipeline_runs run
  where run.id = p_pipeline_run_id
    and run.user_id = p_guest_user_id
    and run.status = 'succeeded'
    and run.stage = 'completed'
    and run.completed_at is not null
    and run.listing_id is not null
  for update;
  if not found then
    raise exception using
      errcode = '55000',
      message = 'Guest recovery requires a durable usable draft';
  end if;

  select * into v_reservation
  from public.ai_item_credit_reservations reservation
  where reservation.pipeline_run_id = v_run.id
    and reservation.user_id = v_run.user_id
    and reservation.item_id = v_run.item_id
    and reservation.state = 'settled'
    and reservation.listing_id = v_run.listing_id
  for update;
  if not found
    or not exists (
      select 1
      from public.items item
      join public.listings draft
        on draft.id = v_run.listing_id
       and draft.item_id = item.id
       and draft.user_id = item.user_id
      join public.prediction_logs prediction
        on prediction.id = v_reservation.prediction_log_id
       and prediction.run_id = v_run.id
       and prediction.item_id = item.id
       and prediction.user_id = item.user_id
      where item.id = v_run.item_id
        and item.user_id = v_run.user_id
        and item.photos is not distinct from v_source_paths
        and draft.status in ('draft', 'queued')
        and draft.ebay_listing_id is null
        and draft.ebay_status is distinct from 'publishing'
        and draft.ebay_status is distinct from 'published'
    ) then
    raise exception using
      errcode = '55000',
      message = 'Guest recovery requires the exact settled draft evidence';
  end if;

  insert into private.guest_draft_recoveries (
    id,
    guest_user_id,
    pipeline_run_id,
    item_id,
    draft_id,
    reservation_id,
    allowance_period_id,
    recovery_token_hash,
    encrypted_artifact,
    storage_manifest,
    storage_object_count,
    usable_draft_at,
    expires_at
  ) values (
    p_recovery_id,
    p_guest_user_id,
    v_run.id,
    v_run.item_id,
    v_run.listing_id,
    v_reservation.id,
    v_reservation.allowance_period_id,
    p_recovery_token_hash,
    p_encrypted_artifact,
    p_storage_manifest,
    jsonb_array_length(p_storage_manifest),
    v_run.completed_at,
    v_run.completed_at + interval '24 hours'
  )
  returning * into v_recovery;

  if statement_timestamp() >= v_recovery.expires_at then
    v_recovery := private.expire_guest_recovery_locked(v_recovery.id);
    return private.guest_terminal_outcome(v_recovery);
  end if;

  return jsonb_build_object(
    'outcome', 'recoverable',
    'recoveryId', v_recovery.id,
    'itemId', v_recovery.item_id,
    'runId', v_recovery.pipeline_run_id,
    'draftId', v_recovery.draft_id,
    'usableDraftAt', v_recovery.usable_draft_at,
    'expiresAt', v_recovery.expires_at,
    'encryptedArtifact', v_recovery.encrypted_artifact,
    'purgeLocalRecovery', false
  );
end;
$$;

revoke all on function public.find_pipeline_batch_replay(text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.find_pipeline_batch_replay(text, uuid, jsonb)
  to service_role;

revoke all on function public.stage_pipeline_batch(text, uuid, jsonb, integer, integer)
  from public, anon, authenticated;
grant execute on function public.stage_pipeline_batch(text, uuid, jsonb, integer, integer)
  to service_role;

revoke all on function private.reserve_ai_item_credit_for_pipeline_run()
  from public, anon, authenticated, service_role;

revoke all on function public.begin_mobile_item_submission(
  text, uuid, text, uuid, uuid, numeric, jsonb
) from public, anon, authenticated;
grant execute on function public.begin_mobile_item_submission(
  text, uuid, text, uuid, uuid, numeric, jsonb
) to service_role;

revoke all on function public.commit_mobile_item_submission(
  text, uuid, text, uuid, uuid, numeric, integer, integer, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.commit_mobile_item_submission(
  text, uuid, text, uuid, uuid, numeric, integer, integer, jsonb, jsonb
) to service_role;

revoke all on function private.queue_guest_recovery_storage_cleanup(
  private.guest_draft_recoveries
) from public, anon, authenticated, service_role;

revoke all on function private.queue_guest_claim_copy_cleanup(
  private.guest_draft_recoveries, text, uuid, boolean
) from public, anon, authenticated, service_role;

revoke all on function public.register_guest_draft_recovery(
  uuid, text, uuid, text, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.register_guest_draft_recovery(
  uuid, text, uuid, text, jsonb, jsonb
) to service_role;
