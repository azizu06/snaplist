-- Issue #161: seller-facing durable pipeline recovery.
--
-- Terminal notifications are emitted by the same Postgres transaction that
-- commits the run state. Retry and cancel are narrow authenticated RPCs: both
-- derive ownership from clerk_user_id(), never accept a tenant id, and never
-- delete an item, listing, or Storage object.

create unique index if not exists pipeline_runs_id_user_id_idx
  on public.pipeline_runs (id, user_id);

alter table public.notifications
  add column if not exists source_pipeline_run_id uuid;

alter table public.notifications
  add constraint notifications_source_pipeline_run_user_fkey
  foreign key (source_pipeline_run_id, user_id)
  references public.pipeline_runs (id, user_id)
  on delete cascade;

comment on column public.notifications.source_pipeline_run_id is
  'Tenant-paired durable pipeline run that produced a ready or terminal-failure activity row.';

create unique index notifications_pipeline_run_kind_unique
  on public.notifications (user_id, source_pipeline_run_id, kind);

create or replace function public.notify_pipeline_run_terminal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if new.status = 'succeeded' then
    insert into public.notifications (
      user_id,
      kind,
      title,
      body,
      href,
      item_id,
      listing_id,
      source_pipeline_run_id
    ) values (
      new.user_id,
      'listing_ready',
      'Your listing draft is ready',
      'Review and edit the draft before you publish to eBay.',
      '/review/' || new.item_id::text || '?ready=1',
      new.item_id,
      new.listing_id,
      new.id
    )
    on conflict (user_id, source_pipeline_run_id, kind) do nothing;
  elsif new.status = 'failed' then
    insert into public.notifications (
      user_id,
      kind,
      title,
      body,
      href,
      item_id,
      listing_id,
      source_pipeline_run_id
    ) values (
      new.user_id,
      'pipeline_failed',
      'Listing preparation stopped',
      coalesce(
        new.safe_failure_message,
        'SnapList could not finish this listing.'
      ) || ' Your photos are saved. Open this listing to try again.',
      '/review/' || new.item_id::text,
      new.item_id,
      new.listing_id,
      new.id
    )
    on conflict (user_id, source_pipeline_run_id, kind) do nothing;
  end if;

  return new;
end;
$$;

revoke all on function public.notify_pipeline_run_terminal()
  from public, anon, authenticated, service_role;

create trigger pipeline_runs_notify_terminal
  after update of status on public.pipeline_runs
  for each row execute function public.notify_pipeline_run_terminal();

create or replace function public.retry_pipeline_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text;
  v_run public.pipeline_runs%rowtype;
  v_message_id bigint;
begin
  v_user_id := public.clerk_user_id();
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Pipeline run authentication is required';
  end if;

  select *
  into v_run
  from public.pipeline_runs
  where id = p_run_id
    and user_id = v_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Pipeline run not found';
  end if;

  if v_run.status = 'succeeded' or v_run.listing_id is not null then
    raise exception using errcode = '55000', message = 'A ready listing cannot be retried';
  end if;

  if v_run.status in ('queued', 'running', 'retrying') then
    return jsonb_build_object(
      'runId', v_run.id,
      'itemId', v_run.item_id,
      'status', v_run.status,
      'queueMessageId', v_run.queue_message_id
    );
  end if;

  if v_run.status not in ('failed', 'canceled') then
    raise exception using errcode = '55000', message = 'This listing run cannot be retried';
  end if;

  -- Attempt counts stay cumulative. A seller retry grants one fresh bounded
  -- attempt window without regressing the monotonic counter or spending a new
  -- AI-item credit.
  update public.pipeline_runs
  set status = 'queued',
      stage = 'queued',
      max_attempts = greatest(max_attempts, attempt_count + 3),
      queue_message_id = null,
      enqueued_at = null,
      completed_at = null,
      failure_code = null,
      safe_failure_message = null,
      lease_token = null,
      lease_expires_at = null,
      next_attempt_at = null
  where id = v_run.id;

  -- Intentionally use the PGMQ 1.4/1.5-compatible two-argument send form and
  -- the strict identifiers-only envelope from ADR-0007.
  select *
  into v_message_id
  from pgmq.send(
    'pipeline_jobs',
    jsonb_build_object('run_id', v_run.id, 'schema_version', v_run.schema_version)
  );

  update public.pipeline_runs
  set queue_message_id = v_message_id,
      enqueued_at = statement_timestamp()
  where id = v_run.id;

  return jsonb_build_object(
    'runId', v_run.id,
    'itemId', v_run.item_id,
    'status', 'queued',
    'queueMessageId', v_message_id
  );
end;
$$;

revoke all on function public.retry_pipeline_run(uuid)
  from public, anon, service_role;
grant execute on function public.retry_pipeline_run(uuid)
  to authenticated;

create or replace function public.cancel_pipeline_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text;
  v_run public.pipeline_runs%rowtype;
begin
  v_user_id := public.clerk_user_id();
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Pipeline run authentication is required';
  end if;

  select *
  into v_run
  from public.pipeline_runs
  where id = p_run_id
    and user_id = v_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Pipeline run not found';
  end if;

  if v_run.status = 'succeeded' or v_run.listing_id is not null then
    raise exception using errcode = '55000', message = 'A ready listing cannot be canceled';
  end if;

  if v_run.status = 'canceled' then
    return jsonb_build_object(
      'runId', v_run.id,
      'itemId', v_run.item_id,
      'status', v_run.status
    );
  end if;

  if v_run.status not in ('queued', 'running', 'retrying') then
    raise exception using errcode = '55000', message = 'This listing run cannot be canceled';
  end if;

  update public.pipeline_runs
  set status = 'canceled',
      completed_at = statement_timestamp(),
      queue_message_id = null,
      enqueued_at = null,
      failure_code = null,
      safe_failure_message = null,
      lease_token = null,
      lease_expires_at = null,
      next_attempt_at = null
  where id = v_run.id;

  if v_run.queue_message_id is not null then
    perform pgmq.delete('pipeline_jobs', v_run.queue_message_id);
  end if;

  update private.pipeline_run_usage_reservations reservation
  set daily_released_at = statement_timestamp()
  where reservation.run_id = v_run.id
    and reservation.daily_released_at is null;

  -- Cancellation is deliberately non-destructive. The item, any successful
  -- listing, and every photo reference remain untouched; abandoned-object
  -- retention/cleanup stays a separate explicit operation owned by #162.
  return jsonb_build_object(
    'runId', v_run.id,
    'itemId', v_run.item_id,
    'status', 'canceled'
  );
end;
$$;

revoke all on function public.cancel_pipeline_run(uuid)
  from public, anon, service_role;
grant execute on function public.cancel_pipeline_run(uuid)
  to authenticated;
