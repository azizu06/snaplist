-- Issue #227: reconcile abandoned-photo retention with credited photo identity.
--
-- Public, authenticated, and service-role item updates still cannot change a
-- credited photo set. The sole exception is the existing retention transaction
-- after it has inserted the exact private abandoned-item cleanup job in that
-- same transaction. That job binds the release to the locked item, the exact
-- old ordered photo paths, and the current transaction id; a durable cleanup
-- job from an earlier transaction is not a reusable bypass.

create or replace function private.enforce_credited_item_photo_set_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_photo_set_fingerprint text;
begin
  if new.photos is not distinct from old.photos then
    return new;
  end if;

  -- Credit finalization takes the run row and then its reservation row. The
  -- retention path already locks sibling runs in deterministic id order, so
  -- taking reservations in pipeline-run order here preserves that ordering and
  -- fences the photo release against settlement/restoration.
  perform reservation.id
  from public.ai_item_credit_reservations reservation
  where reservation.item_id = old.id
    and reservation.user_id = old.user_id
  order by reservation.pipeline_run_id
  for update of reservation;

  if not found then
    return new;
  end if;

  v_photo_set_fingerprint := encode(
    sha256(convert_to(array_to_json(old.photos)::text, 'UTF8')),
    'hex'
  );

  if new.photos = '{}'::text[]
    and not exists (
      select 1
      from public.ai_item_credit_reservations reservation
      where reservation.item_id = old.id
        and reservation.user_id = old.user_id
        and (
          reservation.state = 'reserved'
          or reservation.photo_set_fingerprint
            is distinct from v_photo_set_fingerprint
        )
    )
    and exists (
      select 1
      from private.pipeline_storage_cleanup_jobs cleanup_job
      where cleanup_job.source_type = 'abandoned_item'
        and cleanup_job.source_id = old.id
        and cleanup_job.photo_paths is not distinct from old.photos
        and cleanup_job.xmin = pg_current_xact_id()::xid
    ) then
    return new;
  end if;

  raise exception using
    errcode = '23514',
    message = 'A credited item photo set is immutable; start a new AI-item run';
end;
$$;

revoke all on function private.enforce_credited_item_photo_set_immutable()
  from public, anon, authenticated, service_role;

-- Retry previously took its run row before retention took the same run after
-- locking the item. Updating the run can also need the referenced item, so that
-- opposite ordering admits a run <-> item deadlock. Join the scheduler-neutral
-- retention fence before touching either row: retry waits when retention won;
-- retention's existing try-lock returns a harmless skipped pass when retry won.
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
    raise exception using
      errcode = '42501',
      message = 'Pipeline run authentication is required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('snaplist:pipeline-retention', 0)
  );

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

  if v_run.retention_cleaned_at is not null then
    raise exception using
      errcode = '55000',
      message = 'This saved run has expired. Start a new capture.';
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
    raise exception using
      errcode = '55000',
      message = 'This listing run cannot be retried';
  end if;

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
