-- Reconcile issue #774 after an unreleased older migration body was applied to
-- the shared local stack. The preceding 20260811120000 migration remains the
-- clean-install authority; this migration must converge both that fresh schema
-- and the older applied body without replacing retained tables or data.

do $reconciliation_prerequisites$
begin
  if to_regclass('private.mobile_item_submission_voice_handoffs') is null
    or to_regclass('private.item_seller_voice_contexts') is null
    or to_regclass('public.pipeline_run_provider_usage') is null
    or to_regprocedure(
      'public.record_raw_seller_voice_transcription_outcome(text,uuid,text)'
    ) is null
    or to_regprocedure(
      'private.provider_usage_entries_coarse(jsonb,text[],integer)'
    ) is null
    or to_regprocedure(
      'private.fence_account_erasure_tenant_mutation()'
    ) is null
    or not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'pipeline_run_provider_usage'
        and column_name = 'transcriptions'
        and data_type = 'jsonb'
    )
    or not exists (
      select 1
      from information_schema.triggers
      where trigger_schema = 'public'
        and event_object_schema = 'public'
        and event_object_table = 'pipeline_runs'
        and trigger_name = 'retain_pipeline_seller_context'
    )
    or not exists (
      select 1
      from information_schema.triggers
      where trigger_schema = 'private'
        and event_object_schema = 'private'
        and event_object_table = 'item_seller_voice_contexts'
        and trigger_name = 'zzz_fence_account_erasure_tenant_mutation'
    )
    or not exists (
      select 1
      from pg_class relation
      where relation.oid = 'private.item_seller_voice_contexts'::regclass
        and relation.relrowsecurity
    ) then
    raise exception using
      errcode = '55000',
      message = 'Issue 774 reconciliation prerequisites are missing';
  end if;
end
$reconciliation_prerequisites$;

alter table private.mobile_item_submission_voice_handoffs
  add column if not exists terminal_voice_outcome text,
  add column if not exists transcription_provider_contacted boolean;

-- Legacy transcription_outcome remains the conservative disclosure signal.
-- It did not record whether a hosted provider was contacted, so new provenance
-- remains null instead of inventing a historical fact.

do $reconcile_provenance_constraint$
declare
  v_existing_provenance_definition text;
  v_canonical_provenance_definition constant text := $provenance_constraint$CHECK (terminal_voice_outcome IS NULL AND transcription_provider_contacted IS NULL OR (terminal_voice_outcome = ANY (ARRAY['transcribed'::text, 'empty'::text, 'unsupported'::text, 'timed-out'::text, 'failed'::text])) AND transcription_provider_contacted IS NOT NULL AND ((terminal_voice_outcome <> ALL (ARRAY['transcribed'::text, 'empty'::text])) OR transcription_provider_contacted) AND (terminal_voice_outcome <> 'unsupported'::text OR NOT transcription_provider_contacted))$provenance_constraint$;
begin
  select pg_get_constraintdef(constraint_record.oid, true)
  into v_existing_provenance_definition
  from pg_constraint constraint_record
  where constraint_record.conrelid =
        'private.mobile_item_submission_voice_handoffs'::regclass
    and constraint_record.conname =
        'mobile_voice_terminal_provider_provenance_check'
    and constraint_record.contype = 'c';

  if v_existing_provenance_definition is distinct from
      v_canonical_provenance_definition then
    alter table private.mobile_item_submission_voice_handoffs
      drop constraint if exists mobile_voice_terminal_provider_provenance_check;

    alter table private.mobile_item_submission_voice_handoffs
      add constraint mobile_voice_terminal_provider_provenance_check check (
        (
          terminal_voice_outcome is null
          and transcription_provider_contacted is null
        ) or (
          terminal_voice_outcome in (
            'transcribed', 'empty', 'unsupported', 'timed-out', 'failed'
          )
          and transcription_provider_contacted is not null
          and (
            terminal_voice_outcome not in ('transcribed', 'empty')
            or transcription_provider_contacted
          )
          and (
            terminal_voice_outcome <> 'unsupported'
            or not transcription_provider_contacted
          )
        )
      ) not valid;
  end if;
end
$reconcile_provenance_constraint$;

alter table private.mobile_item_submission_voice_handoffs
  validate constraint mobile_voice_terminal_provider_provenance_check;

drop function if exists public.record_pipeline_run_voice_outcome(
  uuid, uuid, text
);

create or replace function public.record_pipeline_run_voice_outcome(
  p_run_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_provider_contacted boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text;
  v_terminal_outcome text;
  v_recorded boolean;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Pipeline worker authorization is required';
  end if;
  if p_run_id is null or p_lease_token is null
    or p_outcome is null
    or p_provider_contacted is null
    or p_outcome not in (
      'transcribed', 'empty', 'unsupported', 'timed-out', 'failed'
    )
    or (p_outcome in ('transcribed', 'empty') and not p_provider_contacted)
    or (p_outcome = 'unsupported' and p_provider_contacted) then
    raise exception using
      errcode = '22023',
      message = 'Invalid pipeline seller voice outcome';
  end if;

  select run.user_id into v_user_id
  from public.pipeline_runs run
  where run.id = p_run_id
    and run.status = 'running'
    and run.lease_token = p_lease_token
    and run.lease_expires_at > statement_timestamp()
  for update;
  if not found then
    raise exception using
      errcode = '40001',
      message = 'Pipeline run lease is not active';
  end if;

  select handoff.terminal_voice_outcome into v_terminal_outcome
  from private.mobile_item_submission_voice_handoffs handoff
  where handoff.user_id = v_user_id
    and handoff.run_id = p_run_id
    and handoff.state = 'accepted'
  for update;
  if not found or v_terminal_outcome is not null then
    return false;
  end if;

  v_recorded := public.record_raw_seller_voice_transcription_outcome(
    v_user_id, p_run_id, p_outcome
  );
  if not v_recorded then
    return false;
  end if;

  update private.mobile_item_submission_voice_handoffs handoff
  set terminal_voice_outcome = p_outcome,
      transcription_provider_contacted = p_provider_contacted,
      transcription_outcome = case
        when p_provider_contacted then p_outcome
        else null
      end,
      transcription_outcome_at = case
        when p_provider_contacted then statement_timestamp()
        else null
      end,
      updated_at = statement_timestamp()
  where handoff.user_id = v_user_id
    and handoff.run_id = p_run_id;
  return true;
end;
$$;

revoke all on function public.record_pipeline_run_voice_outcome(
  uuid, uuid, text, boolean
)
  from public, anon, authenticated, service_role;
grant execute on function public.record_pipeline_run_voice_outcome(
  uuid, uuid, text, boolean
)
  to service_role;

create or replace function private.provider_usage_nonnegative_integer(
  p_value jsonb,
  p_max numeric
)
returns boolean
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_text text;
begin
  if jsonb_typeof(p_value) is distinct from 'number' then
    return false;
  end if;
  v_text := p_value #>> '{}';
  if octet_length(v_text) > 20
    or v_text !~ '^(0|[1-9][0-9]*)$' then
    return false;
  end if;
  return v_text::numeric <= p_max;
end;
$$;

revoke all on function private.provider_usage_nonnegative_integer(jsonb, numeric)
  from public, anon, authenticated, service_role;

create or replace function private.provider_usage_nonnegative_decimal(
  p_value jsonb,
  p_max numeric
)
returns boolean
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_text text;
begin
  if jsonb_typeof(p_value) is distinct from 'number' then
    return false;
  end if;
  v_text := p_value #>> '{}';
  if octet_length(v_text) > 32
    or v_text !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$' then
    return false;
  end if;
  return v_text::numeric <= p_max;
end;
$$;

revoke all on function private.provider_usage_nonnegative_decimal(jsonb, numeric)
  from public, anon, authenticated, service_role;

create or replace function private.provider_usage_record_is_strict(p_usage jsonb)
returns boolean
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_models jsonb;
  v_transcriptions jsonb;
  v_sold_comps jsonb;
begin
  if jsonb_typeof(p_usage) is distinct from 'object'
    or octet_length(p_usage::text) > 65536
    or not p_usage ?& array[
      'schemaVersion', 'modelCalls', 'inputTokens', 'cachedInputTokens',
      'outputTokens', 'reasoningTokens', 'models', 'soldComps'
    ]
    or p_usage - array[
      'schemaVersion', 'modelCalls', 'inputTokens', 'cachedInputTokens',
      'outputTokens', 'reasoningTokens', 'models', 'transcriptions',
      'soldComps'
    ] <> '{}'::jsonb
    or p_usage->'schemaVersion' is distinct from '1'::jsonb
    or not private.provider_usage_nonnegative_integer(
      p_usage->'modelCalls', 2147483647
    )
    or not private.provider_usage_nonnegative_integer(
      p_usage->'inputTokens', 9223372036854775807
    )
    or not private.provider_usage_nonnegative_integer(
      p_usage->'cachedInputTokens', 9223372036854775807
    )
    or not private.provider_usage_nonnegative_integer(
      p_usage->'outputTokens', 9223372036854775807
    )
    or not private.provider_usage_nonnegative_integer(
      p_usage->'reasoningTokens', 9223372036854775807
    ) then
    return false;
  end if;

  v_models := p_usage->'models';
  v_transcriptions := coalesce(p_usage->'transcriptions', '[]'::jsonb);
  v_sold_comps := p_usage->'soldComps';
  if jsonb_typeof(v_models) is distinct from 'array'
    or jsonb_array_length(v_models) > 64
    or jsonb_typeof(v_transcriptions) is distinct from 'array'
    or jsonb_array_length(v_transcriptions) > 16
    or jsonb_typeof(v_sold_comps) is distinct from 'array'
    or jsonb_array_length(v_sold_comps) > 16 then
    return false;
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_models) entry
    where jsonb_typeof(entry) is distinct from 'object'
      or not entry ?& array[
        'role', 'provider', 'model', 'calls', 'inputTokens',
        'cachedInputTokens', 'outputTokens', 'reasoningTokens'
      ]
      or entry - array[
        'role', 'provider', 'model', 'calls', 'inputTokens',
        'cachedInputTokens', 'outputTokens', 'reasoningTokens'
      ] <> '{}'::jsonb
      or jsonb_typeof(entry->'role') is distinct from 'string'
      or entry->>'role' not in (
        'vision', 'listing', 'export', 'pricingAgent', 'judge'
      )
      or jsonb_typeof(entry->'provider') is distinct from 'string'
      or entry->>'provider' not in ('openai', 'google')
      or jsonb_typeof(entry->'model') is distinct from 'string'
      or octet_length(entry->>'model') not between 1 and 200
      or not private.provider_usage_nonnegative_integer(
        entry->'calls', 2147483647
      )
      or not private.provider_usage_nonnegative_integer(
        entry->'inputTokens', 9223372036854775807
      )
      or not private.provider_usage_nonnegative_integer(
        entry->'cachedInputTokens', 9223372036854775807
      )
      or not private.provider_usage_nonnegative_integer(
        entry->'outputTokens', 9223372036854775807
      )
      or not private.provider_usage_nonnegative_integer(
        entry->'reasoningTokens', 9223372036854775807
      )
  ) then
    return false;
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_transcriptions) entry
    where jsonb_typeof(entry) is distinct from 'object'
      or not entry ?& array[
        'role', 'provider', 'model', 'calls', 'chargedUsd'
      ]
      or entry - array[
        'role', 'provider', 'model', 'calls', 'chargedUsd'
      ] <> '{}'::jsonb
      or entry->'role' is distinct from '"sellerContext"'::jsonb
      or jsonb_typeof(entry->'provider') is distinct from 'string'
      or entry->>'provider' not in ('openai', 'google')
      or jsonb_typeof(entry->'model') is distinct from 'string'
      or octet_length(entry->>'model') not between 1 and 200
      or not private.provider_usage_nonnegative_integer(
        entry->'calls', 2147483647
      )
      or jsonb_typeof(entry->'chargedUsd') is distinct from 'null'
  ) then
    return false;
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_sold_comps) entry
    where jsonb_typeof(entry) is distinct from 'object'
      or not entry ?& array['strategy', 'attempts', 'results', 'chargedUsd']
      or entry - array['strategy', 'attempts', 'results', 'chargedUsd']
        <> '{}'::jsonb
      or jsonb_typeof(entry->'strategy') is distinct from 'string'
      or octet_length(entry->>'strategy') not between 1 and 64
      or not private.provider_usage_nonnegative_integer(
        entry->'attempts', 2147483647
      )
      or not private.provider_usage_nonnegative_integer(
        entry->'results', 2147483647
      )
      or (
        jsonb_typeof(entry->'chargedUsd') is distinct from 'null'
        and not private.provider_usage_nonnegative_decimal(
          entry->'chargedUsd', 999999.999999
        )
      )
  ) then
    return false;
  end if;

  return true;
end;
$$;

revoke all on function private.provider_usage_record_is_strict(jsonb)
  from public, anon, authenticated, service_role;

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
  v_rows integer := 0;
  v_existing public.pipeline_run_provider_usage%rowtype;
  v_existing_transcription_calls numeric := 0;
  v_model_calls numeric := 0;
  v_input_tokens numeric := 0;
  v_cached_input_tokens numeric := 0;
  v_output_tokens numeric := 0;
  v_reasoning_tokens numeric := 0;
  v_sold_comp_attempts numeric := 0;
  v_sold_comp_results numeric := 0;
  v_charged numeric(12, 6);
  v_models jsonb := '[]'::jsonb;
  v_transcriptions jsonb := '[]'::jsonb;
  v_sold_comps jsonb := '[]'::jsonb;
  v_incoming_transcription_only boolean := false;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Pipeline worker authorization is required';
  end if;

  if not private.provider_usage_record_is_strict(p_usage) then
    raise exception using errcode = '22023', message = 'Invalid provider usage record';
  end if;

  v_model_calls := (p_usage->>'modelCalls')::numeric;
  v_input_tokens := (p_usage->>'inputTokens')::numeric;
  v_cached_input_tokens := (p_usage->>'cachedInputTokens')::numeric;
  v_output_tokens := (p_usage->>'outputTokens')::numeric;
  v_reasoning_tokens := (p_usage->>'reasoningTokens')::numeric;
  v_models := p_usage->'models';
  v_transcriptions := coalesce(p_usage->'transcriptions', '[]'::jsonb);
  v_sold_comps := p_usage->'soldComps';

  select pr.user_id, pr.item_id
  into v_user_id, v_item_id
  from public.pipeline_runs pr
  where pr.id = p_run_id
    and pr.status = 'running'
    and pr.lease_token = p_lease_token
    and pr.lease_expires_at > statement_timestamp()
  for update;

  if not found then
    raise exception using
      errcode = '55000',
      message = 'Pipeline worker lease is stale or missing';
  end if;

  select
    coalesce(sum((entry->>'attempts')::numeric), 0),
    coalesce(sum((entry->>'results')::numeric), 0)
  into v_sold_comp_attempts, v_sold_comp_results
  from jsonb_array_elements(v_sold_comps) entry;

  select sum((entry->>'chargedUsd')::numeric)
  into v_charged
  from jsonb_array_elements(v_sold_comps) entry
  where entry->>'chargedUsd' is not null;

  if v_sold_comp_attempts > 2147483647
    or v_sold_comp_results > 2147483647
    or v_charged > 999999.999999 then
    raise exception using
      errcode = '22023',
      message = 'Invalid provider usage record';
  end if;

  v_incoming_transcription_only := case
    when jsonb_typeof(v_transcriptions) = 'array'
      and jsonb_array_length(v_transcriptions) = 1 then
      v_models = '[]'::jsonb
      and v_sold_comps = '[]'::jsonb
      and v_model_calls = 1
      and v_input_tokens = 0
      and v_cached_input_tokens = 0
      and v_output_tokens = 0
      and v_reasoning_tokens = 0
      and v_sold_comp_attempts = 0
      and v_sold_comp_results = 0
      and v_charged is null
      and (v_transcriptions->0) - array[
        'role', 'provider', 'model', 'calls', 'chargedUsd'
      ] = '{}'::jsonb
      and (v_transcriptions->0) ?& array[
        'role', 'provider', 'model', 'calls', 'chargedUsd'
      ]
      and v_transcriptions->0->>'role' = 'sellerContext'
      and nullif(btrim(v_transcriptions->0->>'provider'), '') is not null
      and char_length(v_transcriptions->0->>'provider') <= 64
      and nullif(btrim(v_transcriptions->0->>'model'), '') is not null
      and char_length(v_transcriptions->0->>'model') <= 200
      and v_transcriptions->0->>'calls' = '1'
      and jsonb_typeof(v_transcriptions->0->'chargedUsd') = 'null'
    else false
  end;

  if v_transcriptions <> '[]'::jsonb
    and not v_incoming_transcription_only then
    raise exception using
      errcode = '22023',
      message = 'Invalid provider usage record';
  end if;

  insert into public.pipeline_run_provider_usage (
    run_id, user_id, item_id, schema_version, model_calls,
    input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
    sold_comp_attempts, sold_comp_results, sold_comp_charged_usd,
    models, transcriptions, sold_comps
  )
  values (
    p_run_id,
    v_user_id,
    v_item_id,
    1,
    v_model_calls,
    v_input_tokens,
    v_cached_input_tokens,
    v_output_tokens,
    v_reasoning_tokens,
    v_sold_comp_attempts,
    v_sold_comp_results,
    v_charged,
    v_models,
    v_transcriptions,
    v_sold_comps
  )
  -- A content-free transcription reservation and the remaining run usage may
  -- arrive in either order during a rolling worker upgrade. Merge only those
  -- two complementary shapes; every replay is checked below against the exact
  -- durable projection before success is reported.
  on conflict (run_id) do update set
    model_calls = pipeline_run_provider_usage.model_calls + excluded.model_calls,
    input_tokens = pipeline_run_provider_usage.input_tokens + excluded.input_tokens,
    cached_input_tokens = pipeline_run_provider_usage.cached_input_tokens
      + excluded.cached_input_tokens,
    output_tokens = pipeline_run_provider_usage.output_tokens + excluded.output_tokens,
    reasoning_tokens = pipeline_run_provider_usage.reasoning_tokens
      + excluded.reasoning_tokens,
    sold_comp_attempts = pipeline_run_provider_usage.sold_comp_attempts
      + excluded.sold_comp_attempts,
    sold_comp_results = pipeline_run_provider_usage.sold_comp_results
      + excluded.sold_comp_results,
    sold_comp_charged_usd = case
      when pipeline_run_provider_usage.sold_comp_charged_usd is null
        and excluded.sold_comp_charged_usd is null then null
      else coalesce(pipeline_run_provider_usage.sold_comp_charged_usd, 0)
        + coalesce(excluded.sold_comp_charged_usd, 0)
    end,
    models = case
      when v_incoming_transcription_only
        then pipeline_run_provider_usage.models
      else excluded.models
    end,
    transcriptions = case
      when v_incoming_transcription_only then excluded.transcriptions
      else pipeline_run_provider_usage.transcriptions
    end,
    sold_comps = case
      when v_incoming_transcription_only
        then pipeline_run_provider_usage.sold_comps
      else excluded.sold_comps
    end
  where (
      pipeline_run_provider_usage.models = '[]'::jsonb
      and pipeline_run_provider_usage.sold_comps = '[]'::jsonb
      and pipeline_run_provider_usage.transcriptions <> '[]'::jsonb
      and excluded.transcriptions = '[]'::jsonb
    ) or (
      pipeline_run_provider_usage.transcriptions = '[]'::jsonb
      and (
        pipeline_run_provider_usage.models <> '[]'::jsonb
        or pipeline_run_provider_usage.sold_comps <> '[]'::jsonb
        or (
          pipeline_run_provider_usage.model_calls = 0
          and pipeline_run_provider_usage.input_tokens = 0
          and pipeline_run_provider_usage.cached_input_tokens = 0
          and pipeline_run_provider_usage.output_tokens = 0
          and pipeline_run_provider_usage.reasoning_tokens = 0
          and pipeline_run_provider_usage.sold_comp_attempts = 0
          and pipeline_run_provider_usage.sold_comp_results = 0
          and pipeline_run_provider_usage.sold_comp_charged_usd is null
          and pipeline_run_provider_usage.models = '[]'::jsonb
          and pipeline_run_provider_usage.sold_comps = '[]'::jsonb
        )
      )
      and v_incoming_transcription_only
    );

  get diagnostics v_rows = row_count;
  if v_rows = 1 then
    return true;
  end if;

  select stored.* into v_existing
  from public.pipeline_run_provider_usage stored
  where stored.run_id = p_run_id
  for update;

  if not found then
    raise exception using
      errcode = '55000',
      message = 'Provider usage conflicts with the durable run receipt';
  end if;

  select coalesce(sum((entry->>'calls')::numeric), 0)
  into v_existing_transcription_calls
  from jsonb_array_elements(v_existing.transcriptions) entry;

  if (
      v_incoming_transcription_only
      and v_existing.transcriptions = v_transcriptions
    ) or (
      v_transcriptions = '[]'::jsonb
      and v_existing.model_calls - v_existing_transcription_calls = v_model_calls
      and v_existing.input_tokens = v_input_tokens
      and v_existing.cached_input_tokens = v_cached_input_tokens
      and v_existing.output_tokens = v_output_tokens
      and v_existing.reasoning_tokens = v_reasoning_tokens
      and v_existing.sold_comp_attempts = v_sold_comp_attempts
      and v_existing.sold_comp_results = v_sold_comp_results
      and v_existing.sold_comp_charged_usd is not distinct from v_charged
      and v_existing.models = v_models
      and v_existing.sold_comps = v_sold_comps
    ) then
    return true;
  end if;

  raise exception using
    errcode = '55000',
    message = 'Provider usage conflicts with the durable run receipt';
end;
$$;

revoke all on function public.record_pipeline_run_provider_usage(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_pipeline_run_provider_usage(uuid, uuid, jsonb)
  to service_role;

do $reconciliation_postconditions$
declare
  v_canonical_provenance_definition constant text := $provenance_constraint$CHECK (terminal_voice_outcome IS NULL AND transcription_provider_contacted IS NULL OR (terminal_voice_outcome = ANY (ARRAY['transcribed'::text, 'empty'::text, 'unsupported'::text, 'timed-out'::text, 'failed'::text])) AND transcription_provider_contacted IS NOT NULL AND ((terminal_voice_outcome <> ALL (ARRAY['transcribed'::text, 'empty'::text])) OR transcription_provider_contacted) AND (terminal_voice_outcome <> 'unsupported'::text OR NOT transcription_provider_contacted))$provenance_constraint$;
begin
  if to_regprocedure(
      'public.record_pipeline_run_voice_outcome(uuid,uuid,text,boolean)'
    ) is null
    or to_regprocedure(
      'public.record_pipeline_run_voice_outcome(uuid,uuid,text)'
    ) is not null
    or (
      select count(*)
      from pg_proc procedure
      where procedure.oid in (
        'public.record_pipeline_run_voice_outcome(uuid,uuid,text,boolean)'::regprocedure,
        'private.provider_usage_nonnegative_integer(jsonb,numeric)'::regprocedure,
        'private.provider_usage_nonnegative_decimal(jsonb,numeric)'::regprocedure,
        'private.provider_usage_record_is_strict(jsonb)'::regprocedure,
        'public.record_pipeline_run_provider_usage(uuid,uuid,jsonb)'::regprocedure
      )
        and procedure.prosecdef
        and procedure.proconfig @> array['search_path=""']::text[]
    ) <> 5
    or not has_function_privilege(
      'service_role',
      'public.record_pipeline_run_provider_usage(uuid,uuid,jsonb)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.record_pipeline_run_provider_usage(uuid,uuid,jsonb)',
      'EXECUTE'
    )
    or has_function_privilege(
      'anon',
      'public.record_pipeline_run_provider_usage(uuid,uuid,jsonb)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'public.record_pipeline_run_voice_outcome(uuid,uuid,text,boolean)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.record_pipeline_run_voice_outcome(uuid,uuid,text,boolean)',
      'EXECUTE'
    )
    or has_function_privilege(
      'anon',
      'public.record_pipeline_run_voice_outcome(uuid,uuid,text,boolean)',
      'EXECUTE'
    )
    or has_function_privilege(
      'service_role',
      'private.provider_usage_record_is_strict(jsonb)',
      'EXECUTE'
    )
    or not exists (
      select 1
      from pg_constraint constraint_record
      where constraint_record.conrelid =
            'private.mobile_item_submission_voice_handoffs'::regclass
        and constraint_record.conname =
            'mobile_voice_terminal_provider_provenance_check'
        and constraint_record.contype = 'c'
        and constraint_record.convalidated
        and pg_get_constraintdef(constraint_record.oid, true) =
            v_canonical_provenance_definition
    )
    or not exists (
      select 1
      from information_schema.columns
      where table_schema = 'private'
        and table_name = 'mobile_item_submission_voice_handoffs'
        and column_name = 'terminal_voice_outcome'
        and data_type = 'text'
        and column_default is null
        and is_nullable = 'YES'
    )
    or not exists (
      select 1
      from information_schema.columns
      where table_schema = 'private'
        and table_name = 'mobile_item_submission_voice_handoffs'
        and column_name = 'transcription_provider_contacted'
        and data_type = 'boolean'
        and column_default is null
        and is_nullable = 'YES'
    )
    or not exists (
      select 1
      from pg_trigger trigger_record
      where trigger_record.tgrelid = 'public.pipeline_runs'::regclass
        and trigger_record.tgname = 'retain_pipeline_seller_context'
        and not trigger_record.tgisinternal
        and position(
          'private.retain_pipeline_seller_context()'
          in pg_get_triggerdef(trigger_record.oid)
        ) > 0
    )
    or not exists (
      select 1
      from pg_trigger trigger_record
      where trigger_record.tgrelid =
            'private.item_seller_voice_contexts'::regclass
        and trigger_record.tgname =
            'zzz_fence_account_erasure_tenant_mutation'
        and not trigger_record.tgisinternal
        and position(
          'private.fence_account_erasure_tenant_mutation()'
          in pg_get_triggerdef(trigger_record.oid)
        ) > 0
    )
    or not exists (
      select 1
      from pg_class relation
      where relation.oid = 'private.item_seller_voice_contexts'::regclass
        and relation.relrowsecurity
    )
    or has_table_privilege(
      'service_role', 'private.item_seller_voice_contexts', 'SELECT'
    )
    or has_table_privilege(
      'authenticated', 'private.item_seller_voice_contexts', 'SELECT'
    )
    or has_table_privilege(
      'anon', 'private.item_seller_voice_contexts', 'SELECT'
    ) then
    raise exception using
      errcode = '55000',
      message = 'Issue 774 reconciliation did not converge';
  end if;
end
$reconciliation_postconditions$;
