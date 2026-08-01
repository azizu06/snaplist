-- Issue #571: one documented advisory lock order for the two per-seller
-- pipeline locks, so staging and manual retry can no longer deadlock.
--
-- Row triggers on public.pipeline_runs fire in alphabetical name order, which
-- put the two per-seller advisory locks in opposite orders on the two write
-- paths:
--
--   staging (INSERT)   pipeline_runs_record_history_order_version
--                        -> trophy-run-order:<seller>
--                      reserve_ai_item_credit_for_pipeline_run
--                        -> ai-item-credit:<seller>
--   manual retry       reserve_ai_item_credit_before_manual_retry_requeue
--                        (BEFORE UPDATE) -> ai-item-credit:<seller>
--                      pipeline_runs_record_history_order_version
--                        (AFTER UPDATE)  -> trophy-run-order:<seller>
--
-- One seller staging a run while retrying another closed an AB/BA cycle and
-- Postgres cancelled one side with `deadlock detected`.
--
-- The canonical seller-scoped order is `ai-item-credit` then
-- `trophy-run-order`, wrapped in one named helper so the order lives in a
-- documented seam instead of in trigger names. Manual retry and guest claim
-- already acquire the pair in that order; staging is the path that inverts it,
-- and public.stage_pipeline_batch is the only function in the schema that
-- inserts public.pipeline_runs, so pre-acquiring the pair there covers every
-- insert. The trigger-level acquisitions stay exactly as they are: they now
-- re-take locks the transaction already holds, which is free, and credit
-- accounting is unchanged.
--
-- Full transaction-wide order: snaplist:pipeline-retention, then
-- pipeline-daily / pipeline-minute, then ai-item-credit:<seller>, then
-- trophy-run-order:<seller>.

create or replace function private.lock_pipeline_run_tenant_scope(
  p_user_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('ai-item-credit:' || p_user_id, 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('trophy-run-order:' || p_user_id, 0)
  );
end;
$$;

revoke all on function private.lock_pipeline_run_tenant_scope(text)
  from public, anon, authenticated, service_role;

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

  -- Issue #571: take the seller's credit/ordering pair in the canonical order
  -- before any pipeline_runs row is inserted. The AFTER INSERT triggers take
  -- the same two locks in the opposite order, which used to deadlock against a
  -- concurrent manual retry for the same seller.
  perform private.lock_pipeline_run_tenant_scope(p_user_id);

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

-- `create or replace` preserves the existing ACL, so this restatement changes no
-- privilege. Every prior redefinition of this function restates the pair so the
-- migration file is auditable on its own.
revoke all on function public.stage_pipeline_batch(
  text, uuid, jsonb, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.stage_pipeline_batch(
  text, uuid, jsonb, integer, integer
) to service_role;
