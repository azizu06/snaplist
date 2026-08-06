-- Issue #716: the tenant contract for measured per-run provider consumption.
--
-- On a shared local stack the migration is applied INSIDE this transaction and
-- rolled back with it, so the delta is proved against the live schema without a
-- database reset and without leaving the stack mutated.

begin;

-- CI builds a clean stack from every migration and sets this flag, so there the
-- contract runs against the installed surface and must not replace it. A shared
-- local stack may not have applied this branch migration without a reset; there
-- the same DDL is injected inside this transaction and rolled back at EOF.
-- Keep the block below identical to the migration it mirrors:
-- supabase/migrations/20260806140000_pipeline_run_provider_usage.sql.
select to_regclass('pgtap_ci.require_installed_migrations') is not null
  as require_installed_migration \gset
\if :require_installed_migration
\else
-- Issue #716: record what each pipeline run actually consumed at paid providers,
-- so the SnapList Pro allowance is set on measured data instead of a model.
--
-- Counts, never currency. The only dollar figure stored is the one the Apify
-- Actor reports for its own run; converting tokens to dollars is a reporting
-- concern and would bake a rate card into the pipeline.
--
-- No content. Every column is a count, a role name, a provider name, or a model
-- id the registry resolved. The structural checks below reject a payload that
-- carries anything else rather than storing it.

-- Rejects a usage payload whose object keys stray outside the allowlist. An
-- allowlist rather than a size cap alone: a prompt echo or a leaked credential
-- has to arrive under SOME key, and an unnamed key is refused at the boundary.
create or replace function private.provider_usage_entries_coarse(
  p_entries jsonb,
  p_allowed text[],
  p_max_entries integer
)
returns boolean
language plpgsql
immutable
security definer
set search_path = ''
as $$
begin
  if jsonb_typeof(p_entries) is distinct from 'array'
    or jsonb_array_length(p_entries) > p_max_entries then
    return false;
  end if;
  return not exists (
    select 1
    from jsonb_array_elements(p_entries) entry
    where jsonb_typeof(entry) is distinct from 'object'
      or entry - p_allowed <> '{}'::jsonb
  );
end;
$$;

revoke all on function private.provider_usage_entries_coarse(jsonb, text[], integer)
  from public, anon, authenticated, service_role;

create table public.pipeline_run_provider_usage (
  run_id uuid primary key,
  user_id text not null,
  item_id uuid not null,
  schema_version smallint not null,
  model_calls integer not null,
  input_tokens bigint not null,
  cached_input_tokens bigint not null,
  output_tokens bigint not null,
  reasoning_tokens bigint not null,
  sold_comp_attempts integer not null,
  sold_comp_results integer not null,
  -- Null when no firing strategy reported a charge. Distinct from zero: an
  -- unreported charge is unknown, not free.
  sold_comp_charged_usd numeric(12, 6),
  models jsonb not null,
  sold_comps jsonb not null,
  recorded_at timestamptz not null default statement_timestamp(),

  constraint pipeline_run_provider_usage_schema_version_check
    check (schema_version = 1),
  constraint pipeline_run_provider_usage_counts_check check (
    model_calls >= 0
    and input_tokens >= 0
    and cached_input_tokens >= 0
    and output_tokens >= 0
    and reasoning_tokens >= 0
    and sold_comp_attempts >= 0
    and sold_comp_results >= 0
    and (sold_comp_charged_usd is null or sold_comp_charged_usd >= 0)
  ),
  constraint pipeline_run_provider_usage_models_check check (
    private.provider_usage_entries_coarse(
      models,
      array[
        'role', 'provider', 'model', 'calls', 'inputTokens',
        'cachedInputTokens', 'outputTokens', 'reasoningTokens'
      ],
      64
    )
  ),
  constraint pipeline_run_provider_usage_sold_comps_check check (
    private.provider_usage_entries_coarse(
      sold_comps,
      array['strategy', 'attempts', 'results', 'chargedUsd'],
      16
    )
  ),
  constraint pipeline_run_provider_usage_run_fkey
    foreign key (run_id, item_id, user_id)
    references public.pipeline_runs (id, item_id, user_id)
    on delete cascade
);

comment on table public.pipeline_run_provider_usage is
  'Tenant-owned measured provider consumption for one pipeline run: token counts by role and sold-comp retrieval counts. Never prompts, responses, secrets, or seller content.';
comment on column public.pipeline_run_provider_usage.sold_comp_charged_usd is
  'Sum of what sold-comp providers reported charging for their own runs. Null when nothing reported a charge — unknown, not free.';

create index pipeline_run_provider_usage_recorded_at_idx
  on public.pipeline_run_provider_usage (recorded_at desc, run_id);

alter table public.pipeline_run_provider_usage enable row level security;

revoke all on table public.pipeline_run_provider_usage
  from public, anon, authenticated, service_role;
grant select on table public.pipeline_run_provider_usage to authenticated;

create policy pipeline_run_provider_usage_select_own
  on public.pipeline_run_provider_usage
  for select
  to authenticated
  using ((select public.clerk_user_id()) = user_id);

-- The seventh and last run-scoped worker capability (ADR-0007). Ownership is
-- read off the leased run, never accepted from the caller, so this adds no
-- generic table surface and no service-role bypass.
create or replace function public.record_pipeline_run_provider_usage(
  p_run_id uuid,
  p_lease_token uuid,
  p_usage jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text;
  v_item_id uuid;
  v_charged numeric(12, 6);
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Pipeline worker authorization is required';
  end if;

  if jsonb_typeof(p_usage) is distinct from 'object'
    or octet_length(p_usage::text) > 65536
    or (p_usage->>'schemaVersion') is distinct from '1'
    or p_usage - array[
         'schemaVersion', 'modelCalls', 'inputTokens', 'cachedInputTokens',
         'outputTokens', 'reasoningTokens', 'models', 'soldComps'
       ] <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'Invalid provider usage record';
  end if;

  select pr.user_id, pr.item_id
  into v_user_id, v_item_id
  from public.pipeline_runs pr
  where pr.id = p_run_id
    and pr.status = 'running'
    and pr.lease_token = p_lease_token
    and pr.lease_expires_at > now();

  if not found then
    raise exception using
      errcode = '55000',
      message = 'Pipeline worker lease is stale or missing';
  end if;

  select sum((entry->>'chargedUsd')::numeric)
  into v_charged
  from jsonb_array_elements(coalesce(p_usage->'soldComps', '[]'::jsonb)) entry
  where entry->>'chargedUsd' is not null;

  -- First write wins. A run records once at completion; a duplicate could only
  -- come from redelivery, and silently doubling a run's measured cost would
  -- corrupt the very number the allowance is set from.
  insert into public.pipeline_run_provider_usage (
    run_id, user_id, item_id, schema_version, model_calls,
    input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
    sold_comp_attempts, sold_comp_results, sold_comp_charged_usd,
    models, sold_comps
  )
  values (
    p_run_id,
    v_user_id,
    v_item_id,
    1,
    coalesce((p_usage->>'modelCalls')::integer, 0),
    coalesce((p_usage->>'inputTokens')::bigint, 0),
    coalesce((p_usage->>'cachedInputTokens')::bigint, 0),
    coalesce((p_usage->>'outputTokens')::bigint, 0),
    coalesce((p_usage->>'reasoningTokens')::bigint, 0),
    coalesce((
      select sum((entry->>'attempts')::integer)
      from jsonb_array_elements(coalesce(p_usage->'soldComps', '[]'::jsonb)) entry
    ), 0),
    coalesce((
      select sum((entry->>'results')::integer)
      from jsonb_array_elements(coalesce(p_usage->'soldComps', '[]'::jsonb)) entry
    ), 0),
    v_charged,
    coalesce(p_usage->'models', '[]'::jsonb),
    coalesce(p_usage->'soldComps', '[]'::jsonb)
  )
  on conflict (run_id) do nothing;

  return true;
end;
$$;

revoke all on function public.record_pipeline_run_provider_usage(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_pipeline_run_provider_usage(uuid, uuid, jsonb)
  to service_role;

-- The artifact the allowance decision consumes: median and p95 consumption per
-- COMPLETED AI item run over a date range. Completion comes from the run's own
-- status, so a failed or abandoned attempt cannot drag the distribution.
--
-- Read-only and security INVOKER: it has no privileges of its own, so a caller
-- sees exactly the runs its own role may see. No runtime role is granted
-- execute; this is an operator query, and nothing in the product reads it.
create or replace function public.pipeline_run_provider_usage_percentiles(
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  measure text,
  unit text,
  run_count bigint,
  median numeric,
  p95 numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with completed as (
    select u.*
    from public.pipeline_run_provider_usage u
    join public.pipeline_runs r on r.id = u.run_id
    where r.status = 'succeeded'
      and u.recorded_at >= p_from
      and u.recorded_at < p_to
  ),
  measured as (
    select 'model_calls' as measure, 'calls' as unit, model_calls::numeric as value from completed
    union all
    select 'input_tokens', 'tokens', input_tokens::numeric from completed
    union all
    select 'cached_input_tokens', 'tokens', cached_input_tokens::numeric from completed
    union all
    select 'output_tokens', 'tokens', output_tokens::numeric from completed
    union all
    select 'reasoning_tokens', 'tokens', reasoning_tokens::numeric from completed
    union all
    select 'sold_comp_results', 'results', sold_comp_results::numeric from completed
    union all
    -- Runs where no provider reported a charge are excluded rather than counted
    -- as zero, so an unmetered strategy cannot pull the reported charge down.
    select 'sold_comp_charged_usd', 'usd', sold_comp_charged_usd
    from completed
    where sold_comp_charged_usd is not null
  )
  select
    measure,
    unit,
    count(*) as run_count,
    percentile_cont(0.5) within group (order by value) as median,
    percentile_cont(0.95) within group (order by value) as p95
  from measured
  group by measure, unit
  order by measure;
$$;

revoke all on function public.pipeline_run_provider_usage_percentiles(timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
\endif

select plan(24);

-- ---------------------------------------------------------------------------
-- Table privileges: sellers read their own row, and no runtime role — the
-- worker's service_role included — gets a direct write surface. Every write
-- goes through the lease-scoped RPC.
-- ---------------------------------------------------------------------------

select ok(
  has_table_privilege('authenticated', 'public.pipeline_run_provider_usage', 'select'),
  'authenticated sellers may read their own run cost through tenant RLS'
);
select ok(
  not has_table_privilege('authenticated', 'public.pipeline_run_provider_usage', 'insert'),
  'authenticated sellers cannot write cost records'
);
select ok(
  not has_table_privilege('authenticated', 'public.pipeline_run_provider_usage', 'update'),
  'authenticated sellers cannot alter cost records'
);
select ok(
  not has_table_privilege('authenticated', 'public.pipeline_run_provider_usage', 'delete'),
  'authenticated sellers cannot delete cost records'
);
select ok(
  not has_table_privilege('service_role', 'public.pipeline_run_provider_usage', 'select'),
  'the worker identity has no direct read of the cost table'
);
select ok(
  not has_table_privilege('service_role', 'public.pipeline_run_provider_usage', 'insert'),
  'the worker identity cannot bypass the run-scoped RPC to write cost'
);
select ok(
  not has_table_privilege('service_role', 'public.pipeline_run_provider_usage', 'update'),
  'the worker identity cannot alter a recorded cost'
);
select ok(
  not has_table_privilege('service_role', 'public.pipeline_run_provider_usage', 'delete'),
  'the worker identity cannot delete a recorded cost'
);
select ok(
  (select relrowsecurity from pg_class
   where oid = 'public.pipeline_run_provider_usage'::regclass),
  'row level security is enabled on the cost table'
);

-- The allowance query is an operator artifact, not a product surface.
select ok(
  not has_function_privilege(
    'authenticated',
    'public.pipeline_run_provider_usage_percentiles(timestamptz, timestamptz)',
    'execute'
  ),
  'sellers cannot execute the allowance percentile query'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.pipeline_run_provider_usage_percentiles(timestamptz, timestamptz)',
    'execute'
  ),
  'no runtime role can execute the allowance percentile query'
);

-- ---------------------------------------------------------------------------
-- Fixtures: two tenants, each with one leased running pipeline run.
-- ---------------------------------------------------------------------------

insert into public.items (
  id, user_id, photos, attributes, condition, identification,
  review_revision, review_content_revision,
  photo_identity_kind, photo_identity_fingerprint
)
select
  ids.item_id,
  ids.user_id,
  array[ids.user_id || '/items/photo-0.jpg'],
  '{"brand":"Cost"}'::jsonb,
  'good',
  '{"kind":"fixture"}'::jsonb,
  ids.revision,
  ids.revision,
  'legacy_path_v0',
  encode(sha256(convert_to(
    array_to_json(array[ids.user_id || '/items/photo-0.jpg'])::text, 'UTF8'
  )), 'hex')
from (values
  ('11110000-0000-4000-8000-000000000716'::uuid, 'user_pgtap_716_a',
   '88880000-0000-4000-8000-000000000716'::uuid),
  ('11110000-0000-4000-8000-000000000717'::uuid, 'user_pgtap_716_b',
   '88880000-0000-4000-8000-000000000717'::uuid)
) as ids(item_id, user_id, revision);

insert into public.pipeline_runs (
  id, user_id, item_id, status, stage, idempotency_key,
  attempt_count, started_at, last_attempted_at,
  lease_token, lease_expires_at
)
values
  ('22220000-0000-4000-8000-000000000716', 'user_pgtap_716_a',
   '11110000-0000-4000-8000-000000000716', 'running', 'generating',
   'cost-pgtap-716-a', 1, statement_timestamp(), statement_timestamp(),
   '33330000-0000-4000-8000-000000000716',
   statement_timestamp() + interval '5 minutes'),
  ('22220000-0000-4000-8000-000000000717', 'user_pgtap_716_b',
   '11110000-0000-4000-8000-000000000717', 'running', 'generating',
   'cost-pgtap-716-b', 1, statement_timestamp(), statement_timestamp(),
   '33330000-0000-4000-8000-000000000717',
   statement_timestamp() + interval '5 minutes');

-- ---------------------------------------------------------------------------
-- The RPC: worker-only, lease-scoped, ownership read off the run.
-- ---------------------------------------------------------------------------

select ok(
  not has_function_privilege(
    'authenticated',
    'public.record_pipeline_run_provider_usage(uuid, uuid, jsonb)',
    'execute'
  ),
  'a seller cannot invoke the cost writer at all'
);

set local role service_role;

-- The grant alone is not the gate: the function checks the presenting JWT, so a
-- non-worker claim is refused even from the role that holds execute.
select set_config(
  'request.jwt.claims',
  '{"sub":"user_pgtap_716_a","role":"authenticated"}',
  true
);
select extensions.throws_ok(
  $$select public.record_pipeline_run_provider_usage(
      '22220000-0000-4000-8000-000000000716'::uuid,
      '33330000-0000-4000-8000-000000000716'::uuid,
      '{"schemaVersion":1,"modelCalls":1,"inputTokens":10,"cachedInputTokens":0,"outputTokens":2,"reasoningTokens":0,"models":[],"soldComps":[]}'::jsonb
    )$$,
  '42501',
  'Pipeline worker authorization is required',
  'a non-worker claim cannot write a cost record'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select extensions.throws_ok(
  $$select public.record_pipeline_run_provider_usage(
      '22220000-0000-4000-8000-000000000716'::uuid,
      '99990000-0000-4000-8000-000000000716'::uuid,
      '{"schemaVersion":1,"modelCalls":1,"inputTokens":10,"cachedInputTokens":0,"outputTokens":2,"reasoningTokens":0,"models":[],"soldComps":[]}'::jsonb
    )$$,
  '55000',
  'Pipeline worker lease is stale or missing',
  'a wrong lease token cannot record cost against a run'
);

select extensions.throws_ok(
  $$select public.record_pipeline_run_provider_usage(
      '22220000-0000-4000-8000-000000000716'::uuid,
      '33330000-0000-4000-8000-000000000716'::uuid,
      '{"schemaVersion":1,"modelCalls":1,"inputTokens":10,"cachedInputTokens":0,"outputTokens":2,"reasoningTokens":0,"models":[],"soldComps":[],"prompt":"Grandmother 1968 Seiko"}'::jsonb
    )$$,
  '22023',
  'Invalid provider usage record',
  'a payload carrying an unnamed key is refused rather than stored'
);

select lives_ok(
  $$select public.record_pipeline_run_provider_usage(
      '22220000-0000-4000-8000-000000000716'::uuid,
      '33330000-0000-4000-8000-000000000716'::uuid,
      '{"schemaVersion":1,"modelCalls":2,"inputTokens":3000,"cachedInputTokens":640,"outputTokens":400,"reasoningTokens":64,"models":[{"role":"vision","provider":"openai","model":"resolved-vision","calls":1,"inputTokens":2000,"cachedInputTokens":640,"outputTokens":250,"reasoningTokens":64},{"role":"listing","provider":"openai","model":"resolved-listing","calls":1,"inputTokens":1000,"cachedInputTokens":0,"outputTokens":150,"reasoningTokens":0}],"soldComps":[{"strategy":"apify","attempts":1,"results":9,"chargedUsd":0.0247}]}'::jsonb
    )$$,
  'the worker records the run cost through its lease'
);

-- A redelivery cannot double the number the allowance is set from.
select lives_ok(
  $$select public.record_pipeline_run_provider_usage(
      '22220000-0000-4000-8000-000000000716'::uuid,
      '33330000-0000-4000-8000-000000000716'::uuid,
      '{"schemaVersion":1,"modelCalls":99,"inputTokens":999999,"cachedInputTokens":0,"outputTokens":0,"reasoningTokens":0,"models":[],"soldComps":[]}'::jsonb
    )$$,
  'a duplicate record for the same run is accepted without erroring'
);
reset role;

select is(
  (select row(model_calls, input_tokens, sold_comp_results, sold_comp_charged_usd)::text
   from public.pipeline_run_provider_usage
   where run_id = '22220000-0000-4000-8000-000000000716'),
  row(2, 3000::bigint, 9, 0.024700::numeric(12,6))::text,
  'the first record stands and the duplicate did not overwrite or double it'
);

select is(
  (select user_id from public.pipeline_run_provider_usage
   where run_id = '22220000-0000-4000-8000-000000000716'),
  'user_pgtap_716_a',
  'ownership is derived from the leased run, never asserted by the caller'
);

-- ---------------------------------------------------------------------------
-- Tenant isolation.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"user_pgtap_716_b","role":"authenticated"}',
  true
);
select is(
  (select count(*) from public.pipeline_run_provider_usage)::int,
  0,
  'another tenant cannot see this run cost'
);
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"user_pgtap_716_a","role":"authenticated"}',
  true
);
select is(
  (select count(*) from public.pipeline_run_provider_usage)::int,
  1,
  'the owning seller sees their own run cost'
);
reset role;

-- ---------------------------------------------------------------------------
-- The allowance artifact: median and p95 per COMPLETED run over a range.
--
-- Four succeeded runs carry 1000/2000/3000/4000 input tokens; two of them
-- report a sold-comp charge and two report none. The leased run recorded above
-- is still `running`, so its 3000 tokens must not appear in any measure.
-- ---------------------------------------------------------------------------

insert into public.items (
  id, user_id, photos, attributes, condition, identification,
  review_revision, review_content_revision,
  photo_identity_kind, photo_identity_fingerprint
)
select
  ('11110000-0000-4000-8000-00000071600' || n)::uuid,
  'user_pgtap_716_a',
  array['user_pgtap_716_a/items/completed-' || n || '.jpg'],
  '{"brand":"Cost"}'::jsonb,
  'good',
  '{"kind":"fixture"}'::jsonb,
  ('88880000-0000-4000-8000-00000071600' || n)::uuid,
  ('88880000-0000-4000-8000-00000071600' || n)::uuid,
  'legacy_path_v0',
  encode(sha256(convert_to(
    array_to_json(array['user_pgtap_716_a/items/completed-' || n || '.jpg'])::text,
    'UTF8'
  )), 'hex')
from generate_series(1, 4) as n;

insert into public.pipeline_runs (
  id, user_id, item_id, status, stage, idempotency_key,
  attempt_count, started_at, last_attempted_at, completed_at
)
select
  ('22220000-0000-4000-8000-00000071600' || n)::uuid,
  'user_pgtap_716_a',
  ('11110000-0000-4000-8000-00000071600' || n)::uuid,
  'succeeded',
  'completed',
  'cost-pgtap-716-completed-' || n,
  1,
  statement_timestamp(),
  statement_timestamp(),
  statement_timestamp()
from generate_series(1, 4) as n;

insert into public.pipeline_run_provider_usage (
  run_id, user_id, item_id, schema_version, model_calls,
  input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
  sold_comp_attempts, sold_comp_results, sold_comp_charged_usd,
  models, sold_comps
)
select
  ('22220000-0000-4000-8000-00000071600' || n)::uuid,
  'user_pgtap_716_a',
  ('11110000-0000-4000-8000-00000071600' || n)::uuid,
  1,
  2,
  n * 1000,
  0,
  100,
  0,
  1,
  5,
  case when n <= 2 then (n * 0.02)::numeric(12, 6) else null end,
  '[]'::jsonb,
  '[]'::jsonb
from generate_series(1, 4) as n;

select is(
  (select row(run_count, median, p95)::text
   from public.pipeline_run_provider_usage_percentiles(
     statement_timestamp() - interval '1 hour',
     statement_timestamp() + interval '1 hour'
   )
   where measure = 'input_tokens'),
  row(4::bigint, 2500::numeric, 3850::numeric)::text,
  'input-token median and p95 cover the four completed runs and exclude the running one'
);

select is(
  (select row(run_count, median)::text
   from public.pipeline_run_provider_usage_percentiles(
     statement_timestamp() - interval '1 hour',
     statement_timestamp() + interval '1 hour'
   )
   where measure = 'sold_comp_charged_usd'),
  row(2::bigint, 0.03::numeric)::text,
  'a run whose providers reported no charge is left out rather than counted as zero'
);

select is(
  (select count(*)::int
   from public.pipeline_run_provider_usage_percentiles(
     statement_timestamp() + interval '1 hour',
     statement_timestamp() + interval '2 hours'
   )),
  0,
  'a date range with no completed runs returns nothing rather than a stale figure'
);

select * from finish();
rollback;
