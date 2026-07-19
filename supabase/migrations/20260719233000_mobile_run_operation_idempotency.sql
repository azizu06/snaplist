-- Issue #241: authenticated mobile retry/cancel replay fence.
--
-- The #161 transition functions remain the only durable-run state machine.
-- This private ledger binds one client mutation key to one operation receipt,
-- so a delayed HTTP replay cannot apply the old intent to a later run state.

create table private.mobile_run_operation_replays (
  user_id text not null,
  idempotency_key uuid not null,
  run_id uuid not null references public.pipeline_runs (id) on delete cascade,
  operation text not null,
  result jsonb not null,
  created_at timestamptz not null default statement_timestamp(),
  primary key (user_id, idempotency_key),
  constraint mobile_run_operation_replays_operation_check check (
    operation in ('retry', 'cancel')
  ),
  constraint mobile_run_operation_replays_result_check check (
    jsonb_typeof(result) = 'object'
  )
);

comment on table private.mobile_run_operation_replays is
  'Principal-bound #241 retry/cancel receipts. Canonical run truth remains in public.pipeline_runs.';

revoke all on table private.mobile_run_operation_replays
  from public, anon, authenticated, service_role;

create or replace function public.apply_mobile_run_operation(
  p_run_id uuid,
  p_operation text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text;
  v_replay private.mobile_run_operation_replays%rowtype;
  v_reservation_state text;
  v_result jsonb;
begin
  v_user_id := public.clerk_user_id();
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'Pipeline run authentication is required';
  end if;
  if p_run_id is null
    or p_idempotency_key is null
    or p_operation not in ('retry', 'cancel') then
    raise exception using
      errcode = '22023',
      message = 'Invalid mobile run operation';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'mobile-run-operation:' || v_user_id || ':' || p_idempotency_key::text,
      0
    )
  );

  select *
  into v_replay
  from private.mobile_run_operation_replays replay
  where replay.user_id = v_user_id
    and replay.idempotency_key = p_idempotency_key;

  if found then
    if p_run_id is distinct from v_replay.run_id
      or p_operation is distinct from v_replay.operation then
      raise exception using
        errcode = '23514',
        message = 'The Idempotency-Key is already bound to another run operation';
    end if;
    return v_replay.result;
  end if;

  if p_operation = 'retry' then
    select reservation.state
    into v_reservation_state
    from public.ai_item_credit_reservations reservation
    where reservation.pipeline_run_id = p_run_id
      and reservation.user_id = v_user_id;

    if v_reservation_state = 'restored' then
      raise exception using
        errcode = '55000',
        message = 'This run cannot retry until its restored credit is reconciled';
    end if;

    v_result := public.retry_pipeline_run(p_run_id);
  else
    v_result := public.cancel_pipeline_run(p_run_id);
  end if;

  insert into private.mobile_run_operation_replays (
    user_id,
    idempotency_key,
    run_id,
    operation,
    result
  ) values (
    v_user_id,
    p_idempotency_key,
    p_run_id,
    p_operation,
    v_result
  );

  return v_result;
end;
$$;

revoke all on function public.apply_mobile_run_operation(uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.apply_mobile_run_operation(uuid, text, uuid)
  to authenticated;
