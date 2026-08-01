begin;

select plan(3);

-- Issue #524 fences the included first AI run by physical device, so every
-- non-guest tenant here needs the reserved claim a real redemption would have
-- produced before it can stage a run.
insert into public.included_offer_device_claims
  (claim_id, user_id, idempotency_key, app_attest_key_id, state)
select
  gen_random_uuid(),
  tenant,
  gen_random_uuid()::text,
  'pgtap-key-' || tenant,
  'reserved'
from unnest(array[
  'worker_compat_user'
]) as tenant;

-- Emulate issue #159's separately owned migration surface. The worker reads
-- capture_input through to_jsonb(row), so it remains compatible whether #159's
-- migration lands before or after #160. This transaction rolls every fixture
-- and the temporary replacement function back after the assertions.
alter table public.pipeline_runs
  add column if not exists capture_input jsonb not null default jsonb_build_object(
    'source', 'single',
    'autopilot_enabled', false,
    'photo_count', 0
  );

create temp table pipeline_worker_quota_releases (
  run_id uuid primary key
);

create or replace function public.release_pipeline_run_daily_reservation(
  p_run_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into pg_temp.pipeline_worker_quota_releases (run_id)
  values (p_run_id)
  on conflict do nothing;
  return true;
end;
$$;

create temp table pipeline_worker_compat_state (
  run_id uuid not null,
  message_id bigint not null,
  acquisition jsonb,
  failure jsonb
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

with item as (
  insert into public.items (user_id, photos)
  values ('worker_compat_user', array['worker_compat_user/photo.jpg'])
  returning id
), run as (
  insert into public.pipeline_runs (
    user_id,
    item_id,
    idempotency_key,
    capture_input
  )
  select
    'worker_compat_user',
    item.id,
    'worker-159-compatibility',
    jsonb_build_object(
      'source', 'single',
      'autopilot_enabled', true,
      'photo_count', 1
    )
  from item
  returning id
)
insert into pipeline_worker_compat_state (run_id, message_id)
select run.id, public.enqueue_pipeline_message(run.id, 1::smallint)
from run;

update pipeline_worker_compat_state
set acquisition = public.claim_pipeline_run_attempt(run_id, message_id, 60);

select is(
  (select acquisition #>> '{context,run,autopilot_enabled}' from pipeline_worker_compat_state),
  'true',
  'worker derives the #159 capture-time autopilot snapshot'
);

update pipeline_worker_compat_state
set failure = public.finish_pipeline_run_attempt(
  run_id,
  (acquisition #>> '{context,run,lease_token}')::uuid,
  false,
  30,
  'compatibility_terminal',
  'The compatibility fixture ended safely.'
);

select is(
  (select failure->>'status' from pipeline_worker_compat_state),
  'failed',
  'terminal worker outcome persists before quota release'
);

select is(
  (select count(*)::integer from pipeline_worker_quota_releases),
  1,
  'terminal worker outcome reuses the #159 quota release seam exactly once'
);

select * from finish();
rollback;
