-- Issue #291: expose the same effective allowance and manual-retry capacity
-- truth used by the canonical #278 reclaim operation.

create or replace function private.get_manual_retry_credit_projection(
  p_run_id uuid,
  p_user_id text
)
returns table (
  reservation_id uuid,
  allowance_period_id uuid,
  effective_allowance text,
  can_reclaim boolean,
  rejection_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  with owned_run as (
    select run.id, run.capture_input
    from public.pipeline_runs run
    where run.id = p_run_id
      and run.user_id = p_user_id
  ),
  credit_facts as (
    select
      run.capture_input,
      reservation.id as reservation_id,
      reservation.allowance_period_id,
      reservation.state,
      reservation.retry_reservation_count,
      reservation.retry_restore_count,
      period.id is not null as period_exists,
      period.allowance,
      coalesce(usage.used, 0) as used
    from owned_run run
    left join public.ai_item_credit_reservations reservation
      on reservation.pipeline_run_id = run.id
     and reservation.user_id = p_user_id
    left join public.ai_item_allowance_periods period
      on period.id = reservation.allowance_period_id
     and period.user_id = reservation.user_id
    left join lateral (
      select count(*)::integer as used
      from public.ai_item_credit_reservations candidate
      where candidate.allowance_period_id = reservation.allowance_period_id
        and (
          candidate.state in ('reserved', 'settled')
          or (
            candidate.state = 'restored'
            and candidate.retry_reservation_count
              > candidate.retry_restore_count
          )
        )
    ) usage on reservation.id is not null
  )
  select
    facts.reservation_id,
    facts.allowance_period_id,
    case
      when facts.reservation_id is null then 'unchanged'
      when facts.state = 'restored'
        and facts.retry_reservation_count > facts.retry_restore_count
        then 'reserved'
      else facts.state
    end as effective_allowance,
    case
      when facts.reservation_id is null then facts.capture_input is null
      else facts.state = 'restored'
        and facts.retry_reservation_count = facts.retry_restore_count
        and facts.period_exists
        and facts.used < facts.allowance
    end as can_reclaim,
    case
      when facts.reservation_id is null and facts.capture_input is null then null
      when facts.reservation_id is null then 'missing-reservation'
      when facts.state <> 'restored'
        or facts.retry_reservation_count <> facts.retry_restore_count
        then 'reservation-unavailable'
      when not facts.period_exists then 'period-unavailable'
      when facts.used >= facts.allowance then 'capacity-exhausted'
      else null
    end as rejection_reason
  from credit_facts facts;
$$;

comment on function private.get_manual_retry_credit_projection(uuid, text) is
  'Shared #278 accounting read: effective allowance plus whether the same logical run can reclaim its restored slot.';

revoke all on function private.get_manual_retry_credit_projection(uuid, text)
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
  v_projection record;
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
    select * into v_projection
    from private.get_manual_retry_credit_projection(p_run_id, v_user_id);
    if not found then
      return false;
    end if;
    if v_projection.can_reclaim then
      return false;
    end if;
    raise exception using
      errcode = '55000',
      message = 'A staged pipeline run cannot retry without a credit reservation';
  end if;

  select * into v_projection
  from private.get_manual_retry_credit_projection(p_run_id, v_user_id);
  if not found or v_projection.rejection_reason = 'reservation-unavailable' then
    raise exception using
      errcode = '55000',
      message = 'AI-item credit is not available for manual retry';
  end if;
  if v_projection.rejection_reason = 'period-unavailable' then
    raise exception using
      errcode = '55000',
      message = 'AI-item credit allowance period is unavailable';
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

  select * into v_projection
  from private.get_manual_retry_credit_projection(p_run_id, v_user_id);
  if not found or not v_projection.can_reclaim then
    if v_projection.rejection_reason = 'capacity-exhausted' then
      raise exception using
        errcode = 'P0001',
        message = 'AI item credit unavailable: restored-allowance-reused';
    end if;
    raise exception using
      errcode = '55000',
      message = 'AI-item credit is not available for manual retry';
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

create or replace function public.get_pipeline_run_retry_projection(
  p_run_id uuid
)
returns table (
  effective_allowance text,
  can_retry boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    projection.effective_allowance,
    run.status in ('failed', 'canceled')
      and run.listing_id is null
      and run.retention_cleaned_at is null
      and projection.can_reclaim as can_retry
  from public.pipeline_runs run
  cross join lateral private.get_manual_retry_credit_projection(
    run.id,
    public.clerk_user_id()
  ) projection
  where run.id = p_run_id
    and run.user_id = public.clerk_user_id();
$$;

comment on function public.get_pipeline_run_retry_projection(uuid) is
  'Authenticated run-detail projection of effective allowance and current canonical manual-Retry legality.';

revoke all on function public.get_pipeline_run_retry_projection(uuid)
  from public, anon, service_role;
grant execute on function public.get_pipeline_run_retry_projection(uuid)
  to authenticated;
