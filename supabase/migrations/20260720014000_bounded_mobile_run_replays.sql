-- Issue #290: bounded authenticated mobile retry/cancel replay receipts.
--
-- The #161 transition functions remain the only durable-run state machine.
-- This private ledger binds one client mutation key to one operation receipt,
-- so a delayed HTTP replay cannot apply the old intent to a later run state.

create table private.mobile_run_operation_replays (
  user_id text not null,
  idempotency_key uuid not null,
  requested_run_id uuid not null,
  run_id uuid not null references public.pipeline_runs (id) on delete cascade,
  operation text not null,
  result jsonb not null,
  created_at timestamptz not null default statement_timestamp(),
  primary key (user_id, idempotency_key),
  constraint mobile_run_operation_replays_operation_check check (
    operation in ('retry', 'cancel')
  ),
  constraint mobile_run_operation_replays_verified_run_check check (
    run_id = requested_run_id
  ),
  constraint mobile_run_operation_replays_result_check check (
    jsonb_typeof(result) = 'object'
  )
);

comment on table private.mobile_run_operation_replays is
  'Principal-bound retry/cancel receipts for verified tenant-owned runs, capped at 32 receipts per run. Missing and foreign targets return the tenant-safe error without persistence. Canonical run truth remains in public.pipeline_runs.';

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
  v_replay_count integer;
  v_replay_limit constant integer := 32;
  v_locked_run_id uuid;
  v_error_code text;
  v_error_message text;
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
    if p_run_id is distinct from v_replay.requested_run_id
      or p_operation is distinct from v_replay.operation then
      raise exception using
        errcode = '23514',
        message = 'The Idempotency-Key is already bound to another run operation';
    end if;
    return v_replay.result;
  end if;

  -- Preserve #227/#278 retention-first retry ordering. The canonical retry
  -- reacquires this transaction-scoped lock, then performs #278 credit
  -- reclaim inside the failed/canceled -> queued transition.
  if p_operation = 'retry' then
    perform pg_advisory_xact_lock(
      hashtextextended('snaplist:pipeline-retention', 0)
    );
  end if;

  -- Keep the verified-run linearization lock outside the caught exception
  -- subtransaction. A canonical rejection may roll back that inner block, but
  -- cannot release this lock before its durable receipt is inserted below.
  select run.id
  into v_locked_run_id
  from public.pipeline_runs run
  where run.id = p_run_id
    and run.user_id = v_user_id
  for update;

  -- Missing and foreign targets intentionally share the same deterministic
  -- response but are not durable domain receipts.
  if not found then
    return jsonb_build_object(
      'mobileRunOperationError', jsonb_build_object(
        'code', 'P0002',
        'message', 'Pipeline run not found'
      )
    );
  end if;

  select count(*)::integer
  into v_replay_count
  from private.mobile_run_operation_replays replay
  where replay.run_id = v_locked_run_id;

  if v_replay_count >= v_replay_limit then
    return jsonb_build_object(
      'mobileRunOperationError', jsonb_build_object(
        'code', '55000',
        'message', 'This listing run has too many saved operation receipts'
      )
    );
  end if;

  begin
    if p_operation = 'retry' then
      v_result := public.retry_pipeline_run(p_run_id);
    else
      v_result := public.cancel_pipeline_run(p_run_id);
    end if;
  exception
    when sqlstate 'P0001' or sqlstate 'P0002' or sqlstate '55000' then
      get stacked diagnostics
        v_error_code = returned_sqlstate,
        v_error_message = message_text;
      v_result := jsonb_build_object(
        'mobileRunOperationError', jsonb_build_object(
          'code', v_error_code,
          'message', v_error_message
        )
      );
  end;

  insert into private.mobile_run_operation_replays (
    user_id,
    idempotency_key,
    requested_run_id,
    run_id,
    operation,
    result
  ) values (
    v_user_id,
    p_idempotency_key,
    p_run_id,
    v_locked_run_id,
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
