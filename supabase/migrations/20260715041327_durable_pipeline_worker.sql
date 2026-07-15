-- Issue #160: durable pipeline worker execution, stage checkpoints, leases,
-- bounded retry/backoff, and atomic idempotent draft persistence.

alter table public.pipeline_runs
  add column if not exists autopilot_enabled boolean not null default false,
  add column if not exists checkpoint jsonb not null default '{}'::jsonb,
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists next_attempt_at timestamptz;

alter table public.pipeline_runs
  drop constraint if exists pipeline_runs_checkpoint_check,
  add constraint pipeline_runs_checkpoint_check check (
    jsonb_typeof(checkpoint) = 'object'
    and octet_length(checkpoint::text) <= 262144
  ),
  drop constraint if exists pipeline_runs_lease_state_check,
  add constraint pipeline_runs_lease_state_check check (
    (status = 'running' and lease_token is not null and lease_expires_at is not null)
    or (status <> 'running' and lease_token is null and lease_expires_at is null)
  ),
  drop constraint if exists pipeline_runs_retry_time_check,
  add constraint pipeline_runs_retry_time_check check (
    (status = 'retrying' and next_attempt_at is not null)
    or (status <> 'retrying' and next_attempt_at is null)
  );

comment on column public.pipeline_runs.checkpoint is
  'Validated cumulative identify/price/generate output used only for safe worker resume.';
comment on column public.pipeline_runs.autopilot_enabled is
  'Fallback capture-time publish-eligibility snapshot when the #159 capture_input contract is absent.';
comment on column public.pipeline_runs.lease_token is
  'Fencing token for one active worker attempt; stale attempts cannot checkpoint or persist.';

grant insert (autopilot_enabled) on public.pipeline_runs to authenticated;

create index if not exists pipeline_runs_retry_due_idx
  on public.pipeline_runs (next_attempt_at, updated_at)
  where status = 'retrying';
create unique index if not exists listings_run_id_unique_idx
  on public.listings (run_id)
  where run_id is not null;
create unique index if not exists prediction_logs_run_id_unique_idx
  on public.prediction_logs (run_id)
  where run_id is not null;

-- The foundation's generic state/link helpers are superseded by message-paired,
-- lease-fenced RPCs below. Keeping the definitions aids migration history, but
-- the worker credential can no longer invoke them.
revoke execute on function public.load_pipeline_run_worker_context(uuid)
  from service_role;
revoke execute on function public.transition_pipeline_run(
  uuid, text, text, text, integer, text, text
) from service_role;
revoke execute on function public.link_pipeline_run_listing(uuid, uuid)
  from service_role;

create or replace function public.defer_pipeline_message(
  p_message_id bigint,
  p_visibility_timeout_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_message_id bigint;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Pipeline queue authorization is required';
  end if;
  if p_message_id <= 0 or p_visibility_timeout_seconds not between 1 and 3600 then
    raise exception using errcode = '22023', message = 'Invalid pipeline queue visibility update';
  end if;

  select updated.msg_id
  into v_message_id
  from pgmq.set_vt(
    'pipeline_jobs',
    p_message_id,
    p_visibility_timeout_seconds
  ) updated;
  return v_message_id is not null;
end;
$$;

revoke all on function public.defer_pipeline_message(bigint, integer)
  from public, anon, authenticated;
grant execute on function public.defer_pipeline_message(bigint, integer)
  to service_role;

create or replace function private.pipeline_worker_context_json(p_run_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'run', jsonb_build_object(
      'id', run.id,
      'user_id', run.user_id,
      'item_id', run.item_id,
      'listing_id', run.listing_id,
      'status', run.status,
      'stage', run.stage,
      'schema_version', run.schema_version,
      'attempt_count', run.attempt_count,
      'max_attempts', run.max_attempts,
      'autopilot_enabled', coalesce(
        (to_jsonb(run) #>> '{capture_input,autopilot_enabled}')::boolean,
        run.autopilot_enabled
      ),
      'checkpoint', run.checkpoint,
      'lease_token', run.lease_token,
      'lease_expires_at', run.lease_expires_at,
      'next_attempt_at', run.next_attempt_at
    ),
    'item', jsonb_build_object(
      'id', item.id,
      'user_id', item.user_id,
      'photos', item.photos,
      'attributes', item.attributes,
      'condition', item.condition,
      'cost_basis', item.cost_basis,
      'review_revision', item.review_revision,
      'review_content_revision', item.review_content_revision
    )
  )
  from public.pipeline_runs run
  join public.items item
    on item.id = run.item_id
   and item.user_id = run.user_id
  where run.id = p_run_id;
$$;

revoke all on function private.pipeline_worker_context_json(uuid)
  from public, anon, authenticated, service_role;

-- Issue #159 owns producer-side quota reservations. Its migration may land
-- before or after this slice, so use capability discovery rather than a static
-- dependency. Once present, every terminal worker outcome reuses that narrow
-- release RPC; retries and successful runs retain the accepted-work charge.
create or replace function private.release_pipeline_run_quota_if_available(
  p_run_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_schema_name text := 'public';
  v_function_name text := concat('release_pipeline_run_', 'daily_reservation');
begin
  if to_regprocedure('public.release_pipeline_run_daily_reservation(uuid)') is not null then
    execute format(
      'select %I.%I($1)',
      v_schema_name,
      v_function_name
    ) using p_run_id;
  end if;
end;
$$;

revoke all on function private.release_pipeline_run_quota_if_available(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.claim_pipeline_run_attempt(
  p_run_id uuid,
  p_message_id bigint,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.pipeline_runs%rowtype;
  v_retry_after integer;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Pipeline worker authorization is required';
  end if;
  if p_message_id <= 0 or p_lease_seconds not between 1 and 3600 then
    raise exception using errcode = '22023', message = 'Invalid pipeline worker attempt bounds';
  end if;

  select * into v_run
  from public.pipeline_runs
  where id = p_run_id
  for update;

  if not found or v_run.queue_message_id is distinct from p_message_id then
    return jsonb_build_object('kind', 'mismatch');
  end if;
  if v_run.status in ('succeeded', 'failed', 'canceled') then
    return jsonb_build_object('kind', 'terminal', 'status', v_run.status);
  end if;

  if v_run.status = 'running' and v_run.lease_expires_at > now() then
    v_retry_after := greatest(
      1,
      ceil(extract(epoch from (v_run.lease_expires_at - now())))::integer
    );
    return jsonb_build_object(
      'kind', 'deferred',
      'retryAfterSeconds', least(v_retry_after, 3600)
    );
  end if;

  -- A redelivery after an expired visibility/lease window fences the old worker
  -- before a new attempt is acquired. External model calls never hold this lock.
  if v_run.status = 'running' then
    update public.pipeline_runs
    set status = 'retrying',
        lease_token = null,
        lease_expires_at = null,
        next_attempt_at = now()
    where id = p_run_id;
    select * into v_run from public.pipeline_runs where id = p_run_id for update;
  end if;

  if v_run.status = 'retrying' and v_run.next_attempt_at > now() then
    v_retry_after := greatest(
      1,
      ceil(extract(epoch from (v_run.next_attempt_at - now())))::integer
    );
    return jsonb_build_object(
      'kind', 'deferred',
      'retryAfterSeconds', least(v_retry_after, 3600)
    );
  end if;

  if v_run.attempt_count >= v_run.max_attempts then
    update public.pipeline_runs
    set status = 'failed',
        failure_code = 'attempts_exhausted',
        safe_failure_message = 'SnapList could not finish this listing after several attempts.',
        completed_at = now(),
        lease_token = null,
        lease_expires_at = null,
        next_attempt_at = null
    where id = p_run_id;
    perform private.release_pipeline_run_quota_if_available(p_run_id);
    return jsonb_build_object('kind', 'terminal', 'status', 'failed');
  end if;

  update public.pipeline_runs
  set status = 'running',
      stage = case when stage = 'queued' then 'identifying' else stage end,
      attempt_count = attempt_count + 1,
      started_at = coalesce(started_at, now()),
      last_attempted_at = now(),
      failure_code = null,
      safe_failure_message = null,
      completed_at = null,
      next_attempt_at = null,
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where id = p_run_id;

  return jsonb_build_object(
    'kind', 'acquired',
    'context', private.pipeline_worker_context_json(p_run_id)
  );
end;
$$;

revoke all on function public.claim_pipeline_run_attempt(uuid, bigint, integer)
  from public, anon, authenticated;
grant execute on function public.claim_pipeline_run_attempt(uuid, bigint, integer)
  to service_role;

create or replace function public.checkpoint_pipeline_run(
  p_run_id uuid,
  p_lease_token uuid,
  p_stage text,
  p_checkpoint jsonb,
  p_lease_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Pipeline worker authorization is required';
  end if;
  if p_stage not in ('identifying', 'pricing', 'generating', 'persisting')
    or p_lease_seconds not between 1 and 3600
    or jsonb_typeof(p_checkpoint) is distinct from 'object'
    or octet_length(p_checkpoint::text) > 262144
    or not (p_checkpoint ? 'identified')
    or (p_stage in ('pricing', 'generating', 'persisting') and not (p_checkpoint ? 'priced'))
    or (p_stage in ('generating', 'persisting') and not (p_checkpoint ? 'generated')) then
    raise exception using errcode = '22023', message = 'Invalid pipeline checkpoint';
  end if;

  update public.pipeline_runs
  set stage = p_stage,
      checkpoint = p_checkpoint,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      last_attempted_at = now()
  where id = p_run_id
    and status = 'running'
    and lease_token = p_lease_token
    and lease_expires_at > now()
    and p_checkpoint @> checkpoint;

  if not found then
    raise exception using
      errcode = '55000',
      message = 'Pipeline worker lease is stale or checkpoint regressed';
  end if;
  return true;
end;
$$;

revoke all on function public.checkpoint_pipeline_run(uuid, uuid, text, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public.checkpoint_pipeline_run(uuid, uuid, text, jsonb, integer)
  to service_role;

create or replace function public.finish_pipeline_run_attempt(
  p_run_id uuid,
  p_lease_token uuid,
  p_retryable boolean,
  p_retry_after_seconds integer,
  p_failure_code text,
  p_failure_message text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.pipeline_runs%rowtype;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Pipeline worker authorization is required';
  end if;
  if p_retry_after_seconds not between 1 and 3600
    or p_failure_code !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
    or char_length(p_failure_message) not between 1 and 500 then
    raise exception using errcode = '22023', message = 'Invalid pipeline failure summary';
  end if;

  select * into v_run
  from public.pipeline_runs
  where id = p_run_id
    and status = 'running'
    and lease_token = p_lease_token
    and lease_expires_at > now()
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'Pipeline worker lease is stale';
  end if;

  if p_retryable and v_run.attempt_count < v_run.max_attempts then
    update public.pipeline_runs
    set status = 'retrying',
        failure_code = p_failure_code,
        safe_failure_message = p_failure_message,
        next_attempt_at = now() + make_interval(secs => p_retry_after_seconds),
        lease_token = null,
        lease_expires_at = null
    where id = p_run_id;
    return jsonb_build_object(
      'status', 'retrying',
      'retryAfterSeconds', p_retry_after_seconds
    );
  end if;

  update public.pipeline_runs
  set status = 'failed',
      failure_code = p_failure_code,
      safe_failure_message = p_failure_message,
      completed_at = now(),
      next_attempt_at = null,
      lease_token = null,
      lease_expires_at = null
  where id = p_run_id;
  perform private.release_pipeline_run_quota_if_available(p_run_id);
  return jsonb_build_object('status', 'failed', 'retryAfterSeconds', null);
end;
$$;

revoke all on function public.finish_pipeline_run_attempt(
  uuid, uuid, boolean, integer, text, text
) from public, anon, authenticated;
grant execute on function public.finish_pipeline_run_attempt(
  uuid, uuid, boolean, integer, text, text
) to service_role;

create or replace function public.reject_pipeline_message(
  p_run_id uuid,
  p_message_id bigint,
  p_failure_code text,
  p_failure_message text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.pipeline_runs%rowtype;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Pipeline worker authorization is required';
  end if;
  if p_message_id <= 0
    or p_failure_code !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
    or char_length(p_failure_message) not between 1 and 500 then
    raise exception using errcode = '22023', message = 'Invalid pipeline message rejection';
  end if;

  select * into v_run
  from public.pipeline_runs
  where id = p_run_id
    and queue_message_id = p_message_id
  for update;
  if not found then return false; end if;
  if v_run.status in ('succeeded', 'failed', 'canceled') then return true; end if;
  if v_run.status = 'running' and v_run.lease_expires_at > now() then return false; end if;

  update public.pipeline_runs
  set status = 'failed',
      failure_code = p_failure_code,
      safe_failure_message = p_failure_message,
      completed_at = now(),
      next_attempt_at = null,
      lease_token = null,
      lease_expires_at = null
  where id = p_run_id;
  perform private.release_pipeline_run_quota_if_available(p_run_id);
  return true;
end;
$$;

revoke all on function public.reject_pipeline_message(uuid, bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.reject_pipeline_message(uuid, bigint, text, text)
  to service_role;

create or replace function public.complete_pipeline_run(
  p_run_id uuid,
  p_lease_token uuid,
  p_persistence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.pipeline_runs%rowtype;
  v_listing_id uuid;
  v_prediction_id uuid;
  v_listing_status text;
  v_autopilot_enabled boolean;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Pipeline worker authorization is required';
  end if;
  if jsonb_typeof(p_persistence) is distinct from 'object'
    or jsonb_typeof(p_persistence->'item') is distinct from 'object'
    or jsonb_typeof(p_persistence->'listing') is distinct from 'object'
    or jsonb_typeof(p_persistence->'prediction') is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Invalid pipeline persistence payload';
  end if;
  v_listing_status := p_persistence #>> '{listing,status}';
  if v_listing_status not in ('draft', 'queued') then
    raise exception using errcode = '22023', message = 'Pipeline worker may create drafts only';
  end if;

  select * into v_run
  from public.pipeline_runs
  where id = p_run_id
    and status = 'running'
    and lease_token = p_lease_token
    and lease_expires_at > now()
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'Pipeline worker lease is stale';
  end if;
  v_autopilot_enabled := coalesce(
    (to_jsonb(v_run) #>> '{capture_input,autopilot_enabled}')::boolean,
    v_run.autopilot_enabled
  );
  if (p_persistence #>> '{prediction,autopilot_enabled}')::boolean
    is distinct from v_autopilot_enabled then
    raise exception using errcode = '22023', message = 'Pipeline run configuration mismatch';
  end if;
  if not (v_run.checkpoint ? 'identified')
    or not (v_run.checkpoint ? 'priced')
    or not (v_run.checkpoint ? 'generated') then
    raise exception using errcode = '55000', message = 'Pipeline worker checkpoints are incomplete';
  end if;

  update public.pipeline_runs
  set stage = 'persisting'
  where id = p_run_id;

  update public.items
  set attributes = p_persistence #> '{item,attributes}',
      condition = p_persistence #>> '{item,condition}',
      identification = nullif(
        p_persistence #> '{item,identification}',
        'null'::jsonb
      )
  where id = v_run.item_id
    and user_id = v_run.user_id;
  if not found then
    raise exception using errcode = '23503', message = 'Pipeline run item ownership changed';
  end if;

  insert into public.prediction_logs (
    user_id, item_id, run_id, extracted_attrs, price, price_range, confidence,
    tier_fired, model, listing_model, pricing_model, sources,
    autopilot_enabled, autopilot_eligible
  ) values (
    v_run.user_id,
    v_run.item_id,
    v_run.id,
    p_persistence #> '{prediction,extracted_attrs}',
    (p_persistence #>> '{prediction,price}')::numeric,
    p_persistence #> '{prediction,price_range}',
    (p_persistence #>> '{prediction,confidence}')::numeric,
    p_persistence #>> '{prediction,tier_fired}',
    p_persistence #>> '{prediction,model}',
    p_persistence #>> '{prediction,listing_model}',
    p_persistence #>> '{prediction,pricing_model}',
    p_persistence #> '{prediction,sources}',
    (p_persistence #>> '{prediction,autopilot_enabled}')::boolean,
    (p_persistence #>> '{prediction,autopilot_eligible}')::boolean
  )
  on conflict (run_id) where run_id is not null do update
  set extracted_attrs = excluded.extracted_attrs,
      price = excluded.price,
      price_range = excluded.price_range,
      confidence = excluded.confidence,
      tier_fired = excluded.tier_fired,
      model = excluded.model,
      listing_model = excluded.listing_model,
      pricing_model = excluded.pricing_model,
      sources = excluded.sources,
      autopilot_enabled = excluded.autopilot_enabled,
      autopilot_eligible = excluded.autopilot_eligible
  where prediction_logs.user_id = v_run.user_id
    and prediction_logs.item_id = v_run.item_id
  returning id into v_prediction_id;
  if v_prediction_id is null then
    raise exception using errcode = '23505', message = 'Pipeline prediction identity conflict';
  end if;

  insert into public.listings (
    user_id, item_id, platform, title, description, copy, status, run_id
  ) values (
    v_run.user_id,
    v_run.item_id,
    p_persistence #>> '{listing,platform}',
    p_persistence #>> '{listing,title}',
    p_persistence #>> '{listing,description}',
    p_persistence #> '{listing,copy}',
    v_listing_status,
    v_run.id
  )
  on conflict (run_id) where run_id is not null do update
  set platform = excluded.platform,
      title = excluded.title,
      description = excluded.description,
      copy = excluded.copy,
      status = excluded.status
  where listings.user_id = v_run.user_id
    and listings.item_id = v_run.item_id
    and listings.status in ('draft', 'queued')
    and listings.ebay_listing_id is null
    and listings.ebay_status is distinct from 'publishing'
    and listings.ebay_status is distinct from 'published'
  returning id into v_listing_id;
  if v_listing_id is null then
    raise exception using errcode = '23505', message = 'Pipeline listing identity conflict';
  end if;

  update public.pipeline_runs
  set listing_id = v_listing_id,
      status = 'succeeded',
      stage = 'completed',
      completed_at = now(),
      failure_code = null,
      safe_failure_message = null,
      next_attempt_at = null,
      lease_token = null,
      lease_expires_at = null
  where id = p_run_id;

  return jsonb_build_object('listingId', v_listing_id);
end;
$$;

revoke all on function public.complete_pipeline_run(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_pipeline_run(uuid, uuid, jsonb)
  to service_role;
