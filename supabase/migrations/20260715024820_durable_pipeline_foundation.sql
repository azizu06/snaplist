-- Issue #158: durable listing-pipeline foundation.
--
-- Queue administration is intentionally separated from tenant-domain access:
-- service_role can execute the fixed queue/worker RPCs below, but has no direct
-- privileges on pipeline_runs or pgmq. Every worker domain read is derived from
-- a trusted run id and joined through the run's stored ownership relationships.

create extension if not exists pgmq;

do $queue$
begin
  if not exists (
    select 1
    from pgmq.meta
    where queue_name = 'pipeline_jobs'
  ) then
    perform pgmq.create('pipeline_jobs');
  end if;

  if exists (
    select 1
    from pgmq.meta
    where queue_name = 'pipeline_jobs'
      and is_unlogged
  ) then
    raise exception using
      errcode = '55000',
      message = 'pipeline_jobs must be a logged Supabase Basic Queue';
  end if;
end;
$queue$;

-- Supabase Queues are private unless pgmq_public is deliberately exposed. Keep
-- the extension schema and its raw tables/functions unavailable to every Data
-- API role, including service_role; the fixed SECURITY DEFINER RPCs are the only
-- queue authority exported by this migration.
revoke all on schema pgmq from public, anon, authenticated, service_role;
revoke all on all tables in schema pgmq from public, anon, authenticated, service_role;
revoke all on all sequences in schema pgmq from public, anon, authenticated, service_role;
revoke execute on all functions in schema pgmq from public, anon, authenticated, service_role;

-- The composite target lets a pipeline run prove that an optional listing is
-- owned by the same seller and item. `items (id, user_id)` is already unique.
create unique index if not exists listings_id_item_user_id_idx
  on public.listings (id, item_id, user_id);

create table public.pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  item_id uuid not null,
  listing_id uuid,
  status text not null default 'queued',
  stage text not null default 'queued',
  schema_version smallint not null default 1,
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  idempotency_key text not null,
  queue_message_id bigint unique,
  failure_code text,
  safe_failure_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  enqueued_at timestamptz,
  started_at timestamptz,
  last_attempted_at timestamptz,
  completed_at timestamptz,

  constraint pipeline_runs_item_user_fkey
    foreign key (item_id, user_id)
    references public.items (id, user_id)
    on delete cascade,
  constraint pipeline_runs_listing_item_user_fkey
    foreign key (listing_id, item_id, user_id)
    references public.listings (id, item_id, user_id)
    on delete set null (listing_id),
  constraint pipeline_runs_user_idempotency_key_key
    unique (user_id, idempotency_key),
  constraint pipeline_runs_status_check check (
    status in ('queued', 'running', 'retrying', 'succeeded', 'failed', 'canceled')
  ),
  constraint pipeline_runs_stage_check check (
    stage in ('queued', 'identifying', 'pricing', 'generating', 'persisting', 'completed')
  ),
  constraint pipeline_runs_schema_version_check check (schema_version = 1),
  constraint pipeline_runs_attempts_check check (
    attempt_count >= 0
    and max_attempts > 0
    and attempt_count <= max_attempts
  ),
  constraint pipeline_runs_idempotency_key_check check (
    char_length(idempotency_key) between 1 and 128
  ),
  constraint pipeline_runs_failure_code_check check (
    failure_code is null
    or failure_code ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
  ),
  constraint pipeline_runs_safe_failure_message_check check (
    safe_failure_message is null
    or char_length(safe_failure_message) between 1 and 500
  ),
  constraint pipeline_runs_status_stage_check check (
    (status = 'queued' and stage = 'queued')
    or (
      status in ('running', 'retrying')
      and stage in ('identifying', 'pricing', 'generating', 'persisting')
    )
    or (status = 'succeeded' and stage = 'completed')
    or (
      status in ('failed', 'canceled')
      and stage in ('queued', 'identifying', 'pricing', 'generating', 'persisting')
    )
  ),
  constraint pipeline_runs_attempt_timestamp_check check (
    status not in ('running', 'retrying')
    or (
      attempt_count > 0
      and started_at is not null
      and last_attempted_at is not null
    )
  ),
  constraint pipeline_runs_completion_timestamp_check check (
    (
      status in ('succeeded', 'failed', 'canceled')
      and completed_at is not null
    )
    or (
      status not in ('succeeded', 'failed', 'canceled')
      and completed_at is null
    )
  ),
  constraint pipeline_runs_failed_reason_check check (
    status <> 'failed'
    or (failure_code is not null and safe_failure_message is not null)
  ),
  constraint pipeline_runs_success_has_no_failure_check check (
    status <> 'succeeded'
    or (failure_code is null and safe_failure_message is null)
  )
);

comment on table public.pipeline_runs is
  'Tenant-owned durable source of truth for one listing-preparation run. Queue messages contain only id + schema version.';
comment on column public.pipeline_runs.safe_failure_message is
  'Bounded seller-safe failure summary only; never raw provider text, secrets, signed URLs, or seller copy.';
comment on column public.pipeline_runs.queue_message_id is
  'PGMQ message identity for idempotent enqueue. The queue payload remains {run_id,schema_version} only.';

create index pipeline_runs_user_created_at_idx
  on public.pipeline_runs (user_id, created_at desc);
create index pipeline_runs_user_status_updated_at_idx
  on public.pipeline_runs (user_id, status, updated_at desc);
create index pipeline_runs_item_id_idx
  on public.pipeline_runs (item_id);
create index pipeline_runs_listing_id_idx
  on public.pipeline_runs (listing_id)
  where listing_id is not null;
create index pipeline_runs_active_status_updated_at_idx
  on public.pipeline_runs (status, updated_at)
  where status in ('queued', 'running', 'retrying');

alter table public.pipeline_runs enable row level security;

revoke all on table public.pipeline_runs from public, anon, authenticated, service_role;
grant select on table public.pipeline_runs to authenticated;
grant insert (user_id, item_id, idempotency_key) on table public.pipeline_runs
  to authenticated;

create policy pipeline_runs_select_own
  on public.pipeline_runs
  for select
  to authenticated
  using ((select public.clerk_user_id()) = user_id);

create policy pipeline_runs_insert_own
  on public.pipeline_runs
  for insert
  to authenticated
  with check ((select public.clerk_user_id()) = user_id);

create or replace function public.enforce_pipeline_run_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_allowed boolean := false;
  v_old_stage integer;
  v_new_stage integer;
begin
  if (new.user_id, new.item_id, new.idempotency_key, new.schema_version)
    is distinct from
    (old.user_id, old.item_id, old.idempotency_key, old.schema_version) then
    raise exception using
      errcode = '23514',
      message = 'Pipeline run identity is immutable';
  end if;

  v_allowed := new.status = old.status
    or (old.status = 'queued' and new.status in ('running', 'failed', 'canceled'))
    or (old.status = 'running' and new.status in ('retrying', 'succeeded', 'failed', 'canceled'))
    or (old.status = 'retrying' and new.status in ('running', 'failed', 'canceled'))
    or (old.status in ('failed', 'canceled') and new.status = 'queued');

  if not v_allowed then
    raise exception using
      errcode = '23514',
      message = format('Illegal pipeline run status transition: %s -> %s', old.status, new.status);
  end if;

  if new.attempt_count < old.attempt_count
    or new.attempt_count > old.attempt_count + 1 then
    raise exception using
      errcode = '23514',
      message = 'Pipeline run attempts must advance monotonically by at most one';
  end if;

  if new.status = 'running'
    and old.status in ('queued', 'retrying')
    and new.attempt_count <> old.attempt_count + 1 then
    raise exception using
      errcode = '23514',
      message = 'A claimed pipeline run must increment its attempt count exactly once';
  end if;

  if not (
    new.status = 'running'
    and old.status in ('queued', 'retrying')
  ) and new.attempt_count <> old.attempt_count then
    raise exception using
      errcode = '23514',
      message = 'Only a claimed pipeline run may increment its attempt count';
  end if;

  v_old_stage := array_position(
    array['queued', 'identifying', 'pricing', 'generating', 'persisting', 'completed'],
    old.stage
  );
  v_new_stage := array_position(
    array['queued', 'identifying', 'pricing', 'generating', 'persisting', 'completed'],
    new.stage
  );
  if new.status <> 'queued' and v_new_stage < v_old_stage then
    raise exception using
      errcode = '23514',
      message = format('Pipeline run stage cannot regress: %s -> %s', old.stage, new.stage);
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.enforce_pipeline_run_transition()
  from public, anon, authenticated, service_role;

create trigger pipeline_runs_enforce_transition
  before update on public.pipeline_runs
  for each row execute function public.enforce_pipeline_run_transition();

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
  v_run public.pipeline_runs%rowtype;
  v_message_id bigint;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Pipeline queue authorization is required';
  end if;
  if p_schema_version <> 1 then
    raise exception using errcode = '22023', message = 'Unsupported pipeline queue schema version';
  end if;

  select *
  into v_run
  from public.pipeline_runs
  where id = p_run_id
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

  update public.pipeline_runs
  set queue_message_id = v_message_id,
      enqueued_at = now()
  where id = p_run_id;
  return v_message_id;
end;
$$;

revoke all on function public.enqueue_pipeline_message(uuid, smallint)
  from public, anon, authenticated;
grant execute on function public.enqueue_pipeline_message(uuid, smallint)
  to service_role;

create or replace function public.claim_pipeline_messages(
  p_visibility_timeout_seconds integer,
  p_quantity integer
)
returns table (
  message_id bigint,
  read_count bigint,
  enqueued_at timestamptz,
  visible_at timestamptz,
  envelope jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Pipeline queue authorization is required';
  end if;
  if p_visibility_timeout_seconds not between 1 and 3600
    or p_quantity not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Invalid pipeline queue claim bounds';
  end if;

  return query
  select
    message.msg_id,
    message.read_ct::bigint,
    message.enqueued_at,
    message.vt,
    message.message
  from pgmq.read('pipeline_jobs', p_visibility_timeout_seconds, p_quantity) message;
end;
$$;

revoke all on function public.claim_pipeline_messages(integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_pipeline_messages(integer, integer)
  to service_role;

create or replace function public.ack_pipeline_message(p_message_id bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted boolean;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Pipeline queue authorization is required';
  end if;
  if p_message_id <= 0 then
    raise exception using errcode = '22023', message = 'Invalid pipeline queue message id';
  end if;
  select pgmq.delete('pipeline_jobs', p_message_id) into v_deleted;
  return v_deleted;
end;
$$;

revoke all on function public.ack_pipeline_message(bigint)
  from public, anon, authenticated;
grant execute on function public.ack_pipeline_message(bigint)
  to service_role;

create or replace function public.load_pipeline_run_worker_context(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_context jsonb;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Pipeline worker authorization is required';
  end if;

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
      'max_attempts', run.max_attempts
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
  into v_context
  from public.pipeline_runs run
  join public.items item
    on item.id = run.item_id
   and item.user_id = run.user_id
  where run.id = p_run_id;

  if v_context is null then
    raise exception using errcode = 'P0002', message = 'Pipeline worker context not found';
  end if;
  return v_context;
end;
$$;

revoke all on function public.load_pipeline_run_worker_context(uuid)
  from public, anon, authenticated;
grant execute on function public.load_pipeline_run_worker_context(uuid)
  to service_role;

create or replace function public.transition_pipeline_run(
  p_run_id uuid,
  p_expected_status text,
  p_next_status text,
  p_next_stage text,
  p_attempt_count integer,
  p_failure_code text default null,
  p_failure_message text default null
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

  update public.pipeline_runs
  set status = p_next_status,
      stage = p_next_stage,
      attempt_count = p_attempt_count,
      started_at = case
        when p_next_status = 'running' then coalesce(started_at, now())
        else started_at
      end,
      last_attempted_at = case
        when p_next_status in ('running', 'retrying') then now()
        else last_attempted_at
      end,
      completed_at = case
        when p_next_status in ('succeeded', 'failed', 'canceled') then now()
        else null
      end,
      failure_code = case
        when p_next_status in ('succeeded', 'running', 'queued') then null
        else p_failure_code
      end,
      safe_failure_message = case
        when p_next_status in ('succeeded', 'running', 'queued') then null
        else p_failure_message
      end,
      queue_message_id = case
        when p_next_status = 'queued' then null
        else queue_message_id
      end,
      enqueued_at = case
        when p_next_status = 'queued' then null
        else enqueued_at
      end
  where id = p_run_id
    and status = p_expected_status
  returning * into v_run;

  if not found then
    raise exception using
      errcode = '40001',
      message = 'Pipeline run transition lost its expected state';
  end if;
  return to_jsonb(v_run);
end;
$$;

revoke all on function public.transition_pipeline_run(uuid, text, text, text, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.transition_pipeline_run(uuid, text, text, text, integer, text, text)
  to service_role;

create or replace function public.link_pipeline_run_listing(
  p_run_id uuid,
  p_listing_id uuid
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

  update public.pipeline_runs run
  set listing_id = listing.id
  from public.listings listing
  where run.id = p_run_id
    and listing.id = p_listing_id
    and listing.item_id = run.item_id
    and listing.user_id = run.user_id
  returning run.* into v_run;

  if not found then
    raise exception using
      errcode = '23503',
      message = 'Pipeline listing does not belong to the run item and tenant';
  end if;
  return to_jsonb(v_run);
end;
$$;

revoke all on function public.link_pipeline_run_listing(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.link_pipeline_run_listing(uuid, uuid)
  to service_role;
