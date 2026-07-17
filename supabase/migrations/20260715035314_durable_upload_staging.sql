-- Issue #159: durable upload staging and producer-side capacity reservations.
--
-- The service-role caller is enclosed by a fixed TypeScript capability. It
-- supplies the Clerk user id and the already-resolved Seller policy limits;
-- this migration never derives or accepts browser-provided entitlement state.

create schema if not exists private;

alter table public.pipeline_runs
  add column batch_id uuid,
  add column batch_position integer,
  add column capture_input jsonb;

alter table public.pipeline_runs
  add constraint pipeline_runs_batch_position_check check (
    batch_position is null or batch_position >= 0
  ),
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
      and capture_input->>'photo_count' in ('0', '1', '2', '3', '4')
    )
  );

create index pipeline_runs_user_batch_created_at_idx
  on public.pipeline_runs (user_id, batch_id, created_at)
  where batch_id is not null;
create unique index pipeline_runs_user_batch_position_idx
  on public.pipeline_runs (user_id, batch_id, batch_position)
  where batch_id is not null and batch_position is not null;

-- One row per run makes both daily and per-minute accounting idempotent under
-- ambiguous request retries and queue redelivery. Daily capacity is released
-- only for terminal failed/canceled runs; minute capacity intentionally is not
-- refunded, preserving the existing request-rate semantics.
create table private.pipeline_run_usage_reservations (
  run_id uuid primary key references public.pipeline_runs (id) on delete cascade,
  user_id text not null,
  daily_bucket date not null,
  minute_bucket timestamp without time zone not null,
  daily_limit integer not null check (daily_limit between 1 and 10000),
  per_minute_limit integer not null check (per_minute_limit between 1 and 10000),
  reserved_at timestamptz not null default statement_timestamp(),
  daily_released_at timestamptz,
  constraint pipeline_run_usage_release_time_check check (
    daily_released_at is null or daily_released_at >= reserved_at
  )
);

create index pipeline_run_usage_daily_idx
  on private.pipeline_run_usage_reservations (user_id, daily_bucket)
  where daily_released_at is null;
create index pipeline_run_usage_minute_idx
  on private.pipeline_run_usage_reservations (user_id, minute_bucket);

revoke all on table private.pipeline_run_usage_reservations
  from public, anon, authenticated, service_role;

-- Storage writes happen before the atomic item/run transaction. Register the
-- exact seller-owned staging paths before the first object write so ambiguous
-- RPC or Storage outcomes remain recoverable by guarded retention. A later
-- cleanup pass must still prove that an item does not reference a path before
-- removing it; successful listing photos are never cleanup candidates.
create table private.pipeline_staging_cleanup_intents (
  cleanup_id uuid primary key,
  user_id text not null,
  batch_id uuid not null,
  photo_paths text[] not null,
  created_at timestamptz not null default statement_timestamp(),
  cleanup_after timestamptz not null default (statement_timestamp() + interval '24 hours'),
  constraint pipeline_staging_cleanup_paths_check check (
    cardinality(photo_paths) between 1 and 800
  ),
  constraint pipeline_staging_cleanup_time_check check (
    cleanup_after >= created_at
  )
);

create index pipeline_staging_cleanup_after_idx
  on private.pipeline_staging_cleanup_intents (cleanup_after, cleanup_id);

revoke all on table private.pipeline_staging_cleanup_intents
  from public, anon, authenticated, service_role;

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
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Pipeline cleanup authorization is required';
  end if;
  if p_cleanup_id is null
    or coalesce(p_user_id, '') = ''
    or char_length(p_user_id) > 255
    or p_batch_id is null
    or p_photo_paths is null
    or cardinality(p_photo_paths) not between 1 and 800 then
    raise exception using errcode = '22023', message = 'Invalid pipeline cleanup intent';
  end if;

  v_prefix := p_user_id || '/pipeline-staging/' || p_batch_id::text || '/';
  foreach v_path in array p_photo_paths loop
    if coalesce(char_length(v_path), 0) < char_length(v_prefix) + 1
      or char_length(v_path) > 1024
      or left(v_path, char_length(v_prefix)) <> v_prefix
      or v_path like '%://%'
      or v_path like '%?%'
      or v_path like '%#%' then
      raise exception using errcode = '22023', message = 'Invalid pipeline cleanup path';
    end if;
  end loop;

  select intent.user_id, intent.batch_id, intent.photo_paths
  into v_existing_user_id, v_existing_batch_id, v_existing_photo_paths
  from private.pipeline_staging_cleanup_intents intent
  where intent.cleanup_id = p_cleanup_id
  for update;

  if found then
    if v_existing_user_id is distinct from p_user_id
      or v_existing_batch_id is distinct from p_batch_id
      or v_existing_photo_paths is distinct from p_photo_paths then
      raise exception using errcode = '23514', message = 'Pipeline cleanup intent conflicts';
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

revoke all on function public.record_pipeline_staging_cleanup_intent(uuid, text, uuid, text[])
  from public, anon, authenticated;
grant execute on function public.record_pipeline_staging_cleanup_intent(uuid, text, uuid, text[])
  to service_role;

create or replace function public.resolve_pipeline_staging_cleanup_intent(p_cleanup_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_resolved boolean;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Pipeline cleanup authorization is required';
  end if;
  if p_cleanup_id is null then
    raise exception using errcode = '22023', message = 'Pipeline cleanup intent is required';
  end if;

  delete from private.pipeline_staging_cleanup_intents intent
  where intent.cleanup_id = p_cleanup_id;
  v_resolved := found;
  return v_resolved;
end;
$$;

revoke all on function public.resolve_pipeline_staging_cleanup_intent(uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_pipeline_staging_cleanup_intent(uuid)
  to service_role;

-- The request-bound batch item route remains available while the durable
-- producer rolls out. Mirror each accepted legacy request into the same
-- Postgres capacity boundary so neither entry point can ignore the other's
-- daily or per-minute usage. This is an operational guardrail, not the native
-- AI-item credit ledger owned by #168.
create table private.legacy_pipeline_usage_reservations (
  reservation_id uuid primary key,
  user_id text not null,
  daily_bucket date not null,
  minute_bucket timestamp without time zone not null,
  daily_limit integer not null check (daily_limit between 1 and 10000),
  per_minute_limit integer not null check (per_minute_limit between 1 and 10000),
  reserved_at timestamptz not null default statement_timestamp(),
  daily_released_at timestamptz,
  constraint legacy_pipeline_usage_release_time_check check (
    daily_released_at is null or daily_released_at >= reserved_at
  )
);

create index legacy_pipeline_usage_daily_idx
  on private.legacy_pipeline_usage_reservations (user_id, daily_bucket)
  where daily_released_at is null;
create index legacy_pipeline_usage_minute_idx
  on private.legacy_pipeline_usage_reservations (user_id, minute_bucket);

revoke all on table private.legacy_pipeline_usage_reservations
  from public, anon, authenticated, service_role;

create or replace function public.reserve_legacy_pipeline_usage(
  p_reservation_id uuid,
  p_user_id text,
  p_daily_limit integer,
  p_per_minute_limit integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_daily_bucket date := (v_now at time zone 'UTC')::date;
  v_minute_bucket timestamp without time zone := date_trunc('minute', v_now at time zone 'UTC');
  v_existing_user_id text;
  v_existing_daily_bucket date;
  v_existing_minute_bucket timestamp without time zone;
  v_existing_daily_limit integer;
  v_existing_per_minute_limit integer;
  v_daily_used integer;
  v_minute_used integer;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Pipeline usage authorization is required';
  end if;
  if p_reservation_id is null
    or coalesce(p_user_id, '') = ''
    or char_length(p_user_id) > 255
    or p_daily_limit not between 1 and 10000
    or p_per_minute_limit not between 1 and 10000 then
    raise exception using errcode = '22023', message = 'Invalid legacy pipeline usage reservation';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('pipeline-daily:' || p_user_id || ':' || v_daily_bucket::text, 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('pipeline-minute:' || p_user_id || ':' || v_minute_bucket::text, 0)
  );

  select
    reservation.user_id,
    reservation.daily_bucket,
    reservation.minute_bucket,
    reservation.daily_limit,
    reservation.per_minute_limit
  into
    v_existing_user_id,
    v_existing_daily_bucket,
    v_existing_minute_bucket,
    v_existing_daily_limit,
    v_existing_per_minute_limit
  from private.legacy_pipeline_usage_reservations reservation
  where reservation.reservation_id = p_reservation_id
  for update;

  if found then
    if v_existing_user_id is distinct from p_user_id
      or v_existing_daily_bucket is distinct from v_daily_bucket
      or v_existing_minute_bucket is distinct from v_minute_bucket
      or v_existing_daily_limit is distinct from p_daily_limit
      or v_existing_per_minute_limit is distinct from p_per_minute_limit then
      raise exception using errcode = '23514', message = 'Legacy pipeline usage reservation conflicts';
    end if;
    return false;
  end if;

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

  if v_daily_used + 1 > p_daily_limit then
    raise exception using errcode = 'P0001', message = 'Pipeline daily capacity reached';
  end if;
  if v_minute_used + 1 > p_per_minute_limit then
    raise exception using errcode = 'P0001', message = 'Pipeline per-minute capacity reached';
  end if;

  insert into private.legacy_pipeline_usage_reservations (
    reservation_id,
    user_id,
    daily_bucket,
    minute_bucket,
    daily_limit,
    per_minute_limit
  ) values (
    p_reservation_id,
    p_user_id,
    v_daily_bucket,
    v_minute_bucket,
    p_daily_limit,
    p_per_minute_limit
  );
  return true;
end;
$$;

revoke all on function public.reserve_legacy_pipeline_usage(uuid, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.reserve_legacy_pipeline_usage(uuid, text, integer, integer)
  to service_role;

create or replace function public.release_legacy_pipeline_usage(p_reservation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_released boolean;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Pipeline usage authorization is required';
  end if;
  if p_reservation_id is null then
    raise exception using errcode = '22023', message = 'Legacy pipeline usage reservation is required';
  end if;

  update private.legacy_pipeline_usage_reservations reservation
  set daily_released_at = statement_timestamp()
  where reservation.reservation_id = p_reservation_id
    and reservation.daily_released_at is null;
  v_released := found;
  return v_released;
end;
$$;

revoke all on function public.release_legacy_pipeline_usage(uuid)
  from public, anon, authenticated;
grant execute on function public.release_legacy_pipeline_usage(uuid)
  to service_role;

-- A response can be lost after the atomic staging transaction commits. Check
-- for that completed producer request before uploading a second set of private
-- objects. Empty means no prior commit; any partial or conflicting match fails
-- closed instead of creating or mutating another run.
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
      or (v_entry->>'photo_count')::integer not between 1 and 4
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

revoke all on function public.find_pipeline_batch_replay(text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.find_pipeline_batch_replay(text, uuid, jsonb)
  to service_role;

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
      or jsonb_array_length(v_entry->'photo_paths') not between 1 and 4
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

revoke all on function public.stage_pipeline_batch(text, uuid, jsonb, integer, integer)
  from public, anon, authenticated;
grant execute on function public.stage_pipeline_batch(text, uuid, jsonb, integer, integer)
  to service_role;

create or replace function public.release_pipeline_run_daily_reservation(p_run_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_released boolean;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Pipeline quota authorization is required';
  end if;

  select run.status
  into v_status
  from public.pipeline_runs run
  where run.id = p_run_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Pipeline run not found';
  end if;
  if v_status not in ('failed', 'canceled') then
    raise exception using errcode = '55000', message = 'Only failed or canceled runs release daily capacity';
  end if;

  update private.pipeline_run_usage_reservations reservation
  set daily_released_at = statement_timestamp()
  where reservation.run_id = p_run_id
    and reservation.daily_released_at is null;
  v_released := found;

  -- Deliberately no item, listing, or Storage mutation here. Successful listing
  -- photos remain attached to their item; cleanup is a separate, guarded seam.
  return v_released;
end;
$$;

revoke all on function public.release_pipeline_run_daily_reservation(uuid)
  from public, anon, authenticated;
grant execute on function public.release_pipeline_run_daily_reservation(uuid)
  to service_role;

-- Product progress reads stay RLS-scoped while Realtime delivers updates.
do $publication$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'pipeline_runs'
  ) then
    alter publication supabase_realtime add table public.pipeline_runs;
  end if;
end;
$publication$;
