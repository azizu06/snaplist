-- Issue #278: reconcile seller-confirmed durable-run retry with the monthly
-- AI-item credit ledger.
--
-- A failed or canceled credited run keeps one immutable reservation row. A
-- manual retry reclaims that row's original allowance slot before the existing
-- run is queued. Monotonic counters preserve every retry reserve/restore fact;
-- the reservation itself can settle at most once and never moves backward.

alter table public.ai_item_credit_reservations
  add column if not exists retry_reservation_count integer not null default 0,
  add column if not exists retry_restore_count integer not null default 0;

alter table public.ai_item_credit_reservations
  drop constraint ai_item_credit_reservations_terminal_check;

alter table public.ai_item_credit_reservations
  add constraint ai_item_credit_reservations_terminal_check check (
    (
      state = 'reserved'
      and settled_at is null
      and restored_at is null
      and settled_review_revision is null
      and listing_id is null
      and prediction_log_id is null
      and retry_reservation_count = 0
      and retry_restore_count = 0
    )
    or (
      state = 'settled'
      and settled_at is not null
      and settled_review_revision is not null
      and listing_id is not null
      and prediction_log_id is not null
      and (
        (
          restored_at is null
          and retry_reservation_count = 0
          and retry_restore_count = 0
        )
        or (
          restored_at is not null
          and retry_reservation_count = retry_restore_count + 1
        )
      )
    )
    or (
      state = 'restored'
      and settled_at is null
      and restored_at is not null
      and settled_review_revision is null
      and listing_id is null
      and prediction_log_id is null
      and retry_reservation_count between retry_restore_count
        and retry_restore_count + 1
    )
  );

comment on column public.ai_item_credit_reservations.retry_reservation_count is
  'Monotonic count of seller-confirmed manual retry allowance reclaims for this same logical run and photo set.';
comment on column public.ai_item_credit_reservations.retry_restore_count is
  'Monotonic count of reclaimed manual retry allowances restored after another pre-draft failure or cancellation.';

create or replace function private.enforce_ai_item_credit_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target_allowance integer;
  v_target_used integer;
begin
  if (
    new.user_id,
    new.pipeline_run_id,
    new.item_id,
    new.allowance_period_id,
    new.logical_run_key,
    new.photo_set_fingerprint,
    new.reserved_at
  ) is distinct from (
    old.user_id,
    old.pipeline_run_id,
    old.item_id,
    old.allowance_period_id,
    old.logical_run_key,
    old.photo_set_fingerprint,
    old.reserved_at
  ) then
    if not private.guest_claim_credit_remap_allowed(old, new) then
      raise exception using
        errcode = '23514',
        message = 'AI-item credit reservation identity is immutable';
    end if;

    select period.allowance into v_target_allowance
    from public.ai_item_allowance_periods period
    where period.id = new.allowance_period_id
      and period.user_id = new.user_id
    for update;
    if not found then
      raise exception using
        errcode = '23503',
        message = 'Guest claim target allowance period is unavailable';
    end if;

    select count(*) into v_target_used
    from public.ai_item_credit_reservations reservation
    where reservation.allowance_period_id = new.allowance_period_id
      and reservation.id <> old.id
      and (
        reservation.state in ('reserved', 'settled')
        or (
          reservation.state = 'restored'
          and reservation.retry_reservation_count
            > reservation.retry_restore_count
        )
      );
    if v_target_used >= v_target_allowance then
      raise exception using
        errcode = '23505',
        message = 'Account included credit is already bound to another run';
    end if;
  end if;

  if new.state is distinct from old.state
    and not (
      (old.state = 'reserved' and new.state in ('settled', 'restored'))
      or (old.state = 'restored' and new.state = 'settled')
    ) then
    raise exception using
      errcode = '23514',
      message = format(
        'Illegal AI-item credit transition: %s -> %s', old.state, new.state
      );
  end if;

  if old.state = 'restored'
    and new.state = 'settled'
    and old.retry_reservation_count <> old.retry_restore_count + 1 then
    raise exception using
      errcode = '23514',
      message = 'A restored AI-item credit must be reclaimed before settlement';
  end if;

  if new.state is not distinct from old.state and (
    new.settled_at,
    new.restored_at,
    new.settled_review_revision,
    new.listing_id,
    new.prediction_log_id
  ) is distinct from (
    old.settled_at,
    old.restored_at,
    old.settled_review_revision,
    old.listing_id,
    old.prediction_log_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'AI-item credit terminal evidence is immutable';
  end if;

  if (
    new.retry_reservation_count,
    new.retry_restore_count
  ) is distinct from (
    old.retry_reservation_count,
    old.retry_restore_count
  ) and not (
    old.state = 'restored'
    and new.state = 'restored'
    and (
      (
        old.retry_reservation_count = old.retry_restore_count
        and new.retry_reservation_count = old.retry_reservation_count + 1
        and new.retry_restore_count = old.retry_restore_count
      )
      or (
        old.retry_reservation_count = old.retry_restore_count + 1
        and new.retry_reservation_count = old.retry_reservation_count
        and new.retry_restore_count = old.retry_restore_count + 1
      )
    )
  ) then
    raise exception using
      errcode = '23514',
      message = 'Illegal AI-item manual retry accounting transition';
  end if;

  if old.guided_correction_completed_at is not null
    and new.guided_correction_revision is distinct from old.guided_correction_revision then
    raise exception using
      errcode = '23514',
      message = 'Completed guided correction identity is immutable';
  end if;
  if old.guided_correction_completed_at is not null
    and new.guided_correction_started_at is distinct from old.guided_correction_started_at then
    raise exception using
      errcode = '23514',
      message = 'Completed guided correction start is immutable';
  end if;
  if old.guided_correction_completed_at is not null
    and new.guided_correction_completed_at
        is distinct from old.guided_correction_completed_at then
    raise exception using
      errcode = '23514',
      message = 'Guided correction completion is immutable';
  end if;
  if new.updated_at < old.updated_at then
    raise exception using
      errcode = '23514',
      message = 'AI-item credit time cannot move backward';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_ai_item_credit_transition()
  from public, anon, authenticated, service_role;

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
  if not found or cardinality(v_photo_paths) not between 1 and 4 then
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

revoke all on function private.reserve_ai_item_credit_for_pipeline_run()
  from public, anon, authenticated, service_role;

create or replace function private.reserve_ai_item_credit_for_manual_retry(
  p_run_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_reservation public.ai_item_credit_reservations%rowtype;
  v_period public.ai_item_allowance_periods%rowtype;
  v_used integer;
begin
  if coalesce(v_user_id, '') = '' then
    raise exception using
      errcode = '42501',
      message = 'Pipeline run authentication is required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('ai-item-credit:' || v_user_id, 0)
  );

  select reservation.* into v_reservation
  from public.ai_item_credit_reservations reservation
  join public.pipeline_runs run
    on run.id = reservation.pipeline_run_id
   and run.user_id = reservation.user_id
   and run.item_id = reservation.item_id
  where reservation.pipeline_run_id = p_run_id
    and reservation.user_id = v_user_id
  for update of reservation;

  if not found then
    if exists (
      select 1
      from public.pipeline_runs run
      where run.id = p_run_id
        and run.user_id = v_user_id
        and run.capture_input is not null
    ) then
      raise exception using
        errcode = '55000',
        message = 'A staged pipeline run cannot retry without a credit reservation';
    end if;
    return false;
  end if;

  if v_reservation.state <> 'restored'
    or v_reservation.retry_reservation_count <> v_reservation.retry_restore_count then
    raise exception using
      errcode = '55000',
      message = 'AI-item credit is not available for manual retry';
  end if;

  select * into v_period
  from public.ai_item_allowance_periods period
  where period.id = v_reservation.allowance_period_id
    and period.user_id = v_reservation.user_id
  for update;
  if not found then
    raise exception using
      errcode = '55000',
      message = 'AI-item credit allowance period is unavailable';
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
      message = 'AI item credit unavailable: restored-allowance-reused';
  end if;

  update public.ai_item_credit_reservations reservation
  set retry_reservation_count = retry_reservation_count + 1,
      updated_at = statement_timestamp()
  where reservation.id = v_reservation.id
    and reservation.state = 'restored'
    and reservation.retry_reservation_count = reservation.retry_restore_count;
  if not found then
    raise exception using
      errcode = '40001',
      message = 'AI-item credit manual retry lost its reservation';
  end if;
  return true;
end;
$$;

revoke all on function private.reserve_ai_item_credit_for_manual_retry(uuid)
  from public, anon, authenticated, service_role;

-- Put credit reclaim on the durable status transition itself. This preserves
-- the authenticated retry RPC's retention-lock order and also fences an
-- invocation of the pre-migration RPC that began before deployment: once this
-- trigger DDL acquires its pipeline_runs lock, an older retry either committed
-- in time for the backfill below or its later failed/canceled -> queued update
-- fires this trigger before the old function can send another PGMQ message.
create or replace function private.reserve_ai_item_credit_before_manual_retry_requeue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.reserve_ai_item_credit_for_manual_retry(new.id);
  return new;
end;
$$;

revoke all on function private.reserve_ai_item_credit_before_manual_retry_requeue()
  from public, anon, authenticated, service_role;

drop trigger if exists reserve_ai_item_credit_before_manual_retry_requeue
  on public.pipeline_runs;
create trigger reserve_ai_item_credit_before_manual_retry_requeue
before update of status on public.pipeline_runs
for each row
when (
  old.status in ('failed', 'canceled')
  and new.status = 'queued'
)
execute function private.reserve_ai_item_credit_before_manual_retry_requeue();

-- manual-retry-upgrade-backfill:begin
-- Before this migration, retry_pipeline_run could requeue a restored credited
-- run without reclaiming its allowance. Those unambiguously active retries
-- must enter the new ledger with one active reclaim or settlement would strand
-- them after deployment. Fail the migration instead of overbooking a period if
-- an already-started retry and a later reservation currently compete for the
-- same restored slot.
do $$
begin
  if exists (
    select 1
    from public.ai_item_allowance_periods period
    where (
      select count(*)
      from public.ai_item_credit_reservations reservation
      join public.pipeline_runs run
        on run.id = reservation.pipeline_run_id
       and run.user_id = reservation.user_id
       and run.item_id = reservation.item_id
      where reservation.allowance_period_id = period.id
        and reservation.state = 'restored'
        and reservation.retry_reservation_count = 0
        and reservation.retry_restore_count = 0
        and run.status in ('queued', 'running', 'retrying')
        and run.capture_input is not null
        and run.listing_id is null
        and run.completed_at is null
        and run.retention_cleaned_at is null
    ) > greatest(
      period.allowance::bigint - (
        select count(*)
        from public.ai_item_credit_reservations reservation
        where reservation.allowance_period_id = period.id
          and (
            reservation.state in ('reserved', 'settled')
            or (
              reservation.state = 'restored'
              and reservation.retry_reservation_count
                > reservation.retry_restore_count
            )
          )
      ),
      0::bigint
    )
  ) then
    raise exception using
      errcode = '55000',
      message = 'Cannot reconcile active manual retries without overbooking an AI-item allowance period';
  end if;
end;
$$;

update public.ai_item_credit_reservations reservation
set retry_reservation_count = 1,
    updated_at = statement_timestamp()
from public.pipeline_runs run
where run.id = reservation.pipeline_run_id
  and run.user_id = reservation.user_id
  and run.item_id = reservation.item_id
  and reservation.state = 'restored'
  and reservation.retry_reservation_count = 0
  and reservation.retry_restore_count = 0
  and run.status in ('queued', 'running', 'retrying')
  and run.capture_input is not null
  and run.listing_id is null
  and run.completed_at is null
  and run.retention_cleaned_at is null;
-- manual-retry-upgrade-backfill:end

create or replace function private.settle_ai_item_credit(p_run_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.ai_item_credit_reservations%rowtype;
  v_review_revision uuid;
  v_listing_id uuid;
  v_prediction_log_id uuid;
begin
  select * into v_reservation
  from public.ai_item_credit_reservations reservation
  where reservation.pipeline_run_id = p_run_id
  for update;
  if not found then
    if exists (
      select 1
      from public.pipeline_runs run
      where run.id = p_run_id
        and run.capture_input is not null
    ) then
      raise exception using
        errcode = '55000',
        message = 'A staged pipeline run cannot succeed without a credit reservation';
    end if;
    return false;
  end if;
  if v_reservation.state = 'settled' then return true; end if;
  if v_reservation.state = 'restored'
    and v_reservation.retry_reservation_count
        <> v_reservation.retry_restore_count + 1 then
    raise exception using
      errcode = '55000',
      message = 'A restored AI-item credit cannot settle without an active manual retry';
  end if;

  select item.review_revision, listing.id, prediction.id
  into v_review_revision, v_listing_id, v_prediction_log_id
  from public.pipeline_runs run
  join public.items item
    on item.id = run.item_id
   and item.user_id = run.user_id
  join public.listings listing
    on listing.id = run.listing_id
   and listing.run_id = run.id
   and listing.item_id = run.item_id
   and listing.user_id = run.user_id
  join public.prediction_logs prediction
    on prediction.run_id = run.id
   and prediction.item_id = run.item_id
   and prediction.user_id = run.user_id
  where run.id = p_run_id
    and run.status = 'succeeded'
    and run.user_id = v_reservation.user_id
    and run.item_id = v_reservation.item_id
    and v_reservation.photo_set_fingerprint = encode(
      sha256(convert_to(array_to_json(item.photos)::text, 'UTF8')),
      'hex'
    )
    and jsonb_typeof(item.attributes) = 'object'
    and item.attributes <> '{}'::jsonb
    and jsonb_typeof(item.identification) = 'object'
    and item.review_revision is not distinct from item.review_content_revision
    and prediction.price > 0
    and jsonb_typeof(prediction.price_range) = 'object'
    and prediction.confidence between 0 and 1
    and coalesce(btrim(prediction.tier_fired), '') <> ''
    and jsonb_typeof(prediction.sources) = 'array'
    and (
      jsonb_array_length(prediction.sources) > 0
      or prediction.tier_fired = 'llm-only'
    )
    and listing.platform = 'ebay'
    and listing.status in ('draft', 'queued')
    and coalesce(btrim(listing.title), '') <> ''
    and char_length(listing.title) <= 80
    and coalesce(btrim(listing.description), '') <> ''
    and listing.source_review_revision is not distinct from item.review_revision;
  if not found then
    raise exception using
      errcode = '55000',
      message = 'AI-item credit requires one coherent editable draft revision';
  end if;

  update public.ai_item_credit_reservations
  set state = 'settled',
      settled_at = statement_timestamp(),
      settled_review_revision = v_review_revision,
      listing_id = v_listing_id,
      prediction_log_id = v_prediction_log_id,
      updated_at = statement_timestamp()
  where id = v_reservation.id
    and (
      state = 'reserved'
      or (
        state = 'restored'
        and retry_reservation_count = retry_restore_count + 1
      )
    );
  if not found then
    raise exception using
      errcode = '55000',
      message = 'AI-item credit settlement lost its reservation';
  end if;
  return true;
end;
$$;

revoke all on function private.settle_ai_item_credit(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.restore_ai_item_credit(p_run_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.ai_item_credit_reservations%rowtype;
begin
  select * into v_reservation
  from public.ai_item_credit_reservations reservation
  where reservation.pipeline_run_id = p_run_id
  for update;
  if not found or v_reservation.state = 'settled' then
    return false;
  end if;

  if v_reservation.state = 'reserved' then
    update public.ai_item_credit_reservations
    set state = 'restored',
        restored_at = statement_timestamp(),
        updated_at = statement_timestamp()
    where id = v_reservation.id
      and state = 'reserved';
    return found;
  end if;

  if v_reservation.retry_reservation_count
      = v_reservation.retry_restore_count + 1 then
    update public.ai_item_credit_reservations
    set retry_restore_count = retry_restore_count + 1,
        updated_at = statement_timestamp()
    where id = v_reservation.id
      and state = 'restored'
      and retry_reservation_count = retry_restore_count + 1;
    return found;
  end if;

  return false;
end;
$$;

revoke all on function private.restore_ai_item_credit(uuid)
  from public, anon, authenticated, service_role;

-- Preserve #227's retention-first lock order. Credit reclaim occurs only after
-- the tenant-owned run is locked and validated, inside its failed/canceled ->
-- queued transition and before PGMQ changes, so any failure rolls the whole
-- seller-confirmed retry back.
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

-- RevenueCat remains a projection over the #168 ledger. A restored reservation
-- with an active manual-retry reclaim consumes its original allowance slot even
-- though its terminal reservation state stays forward-only.
create or replace function public.get_verified_ai_item_entitlement(
  p_user_id text
)
returns table (
  billing_source text,
  status text,
  remaining_items integer,
  period_start timestamptz,
  period_end timestamptz,
  grace_period_end timestamptz,
  transition_state text,
  legacy_stripe_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_included public.ai_item_allowance_periods%rowtype;
  v_storekit public.ai_item_allowance_periods%rowtype;
  v_binding public.revenuecat_customer_bindings%rowtype;
  v_remaining integer;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Verified entitlement authorization is required';
  end if;
  if coalesce(char_length(p_user_id), 0) not between 1 and 255 then
    raise exception using errcode = '22023', message = 'Invalid entitlement user';
  end if;

  select * into v_binding
  from public.revenuecat_customer_bindings binding
  where binding.user_id = p_user_id;

  select * into v_included
  from public.ai_item_allowance_periods period
  where period.user_id = p_user_id
    and period.source = 'included'
  order by period.created_at
  limit 1;

  if not found then
    return query select
      'included'::text,
      'included'::text,
      1,
      null::timestamptz,
      null::timestamptz,
      null::timestamptz,
      v_binding.transition_state,
      v_binding.legacy_stripe_status;
    return;
  end if;

  select greatest(
    v_included.allowance - count(*) filter (
      where reservation.state <> 'restored'
        or reservation.retry_reservation_count
          > reservation.retry_restore_count
    )::integer,
    0
  ) into v_remaining
  from public.ai_item_credit_reservations reservation
  where reservation.allowance_period_id = v_included.id;
  if v_remaining > 0 then
    return query select
      'included'::text,
      'included'::text,
      v_remaining,
      v_included.period_start,
      v_included.expires_date,
      null::timestamptz,
      v_binding.transition_state,
      v_binding.legacy_stripe_status;
    return;
  end if;

  select * into v_storekit
  from public.ai_item_allowance_periods period
  where period.user_id = p_user_id
    and period.source = 'storekit'
  order by period.period_start desc, period.created_at desc
  limit 1;
  if not found then
    return query select
      'included'::text,
      'included'::text,
      0,
      v_included.period_start,
      v_included.expires_date,
      null::timestamptz,
      v_binding.transition_state,
      v_binding.legacy_stripe_status;
    return;
  end if;

  select greatest(
    v_storekit.allowance - count(*) filter (
      where reservation.state <> 'restored'
        or reservation.retry_reservation_count
          > reservation.retry_restore_count
    )::integer,
    0
  ) into v_remaining
  from public.ai_item_credit_reservations reservation
  where reservation.allowance_period_id = v_storekit.id;

  return query select
    'storekit'::text,
    v_storekit.state,
    case
      when v_storekit.state = 'active'
        and v_storekit.expires_date > statement_timestamp() then v_remaining
      when v_storekit.state = 'grace'
        and v_storekit.grace_expires_date > statement_timestamp() then v_remaining
      else 0
    end,
    v_storekit.period_start,
    v_storekit.expires_date,
    v_storekit.grace_expires_date,
    v_binding.transition_state,
    v_binding.legacy_stripe_status;
end;
$$;
