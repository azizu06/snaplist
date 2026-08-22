-- Issue #820 item 4 (a non-blocking finding from the #818 review of #724):
-- a redelivered post-completion report was accepted unconditionally.
--
-- `record_pipeline_run_provider_usage` (the running-path writer, patched in
-- 20260811120000/20260811123000) treats "already recorded" as a question, not
-- an assumption: it re-reads the durable row and compares the incoming
-- payload field by field, returning true only when the replay actually
-- matches what was recorded, and raising `55000 'Provider usage conflicts
-- with the durable run receipt'` otherwise. The post-completion writer's
-- equivalent check --
--   if v_cap.provider_usage_recorded_at is not null then return true; end if;
-- -- answered every replay with success without comparing anything. A
-- transport-level redelivery carrying a genuinely different payload (a worker
-- retry after a partial measurement, a bug in the caller) would have folded
-- silently into "already handled" instead of surfacing the same conflict the
-- running path surfaces for the identical failure mode.
--
-- The capability row is already this correction's one-row audit record
-- (20260813030000's own comment), so the fix stores what was actually
-- recorded on it -- the same shape the running path gets for free from
-- `pipeline_run_provider_usage` being keyed by `run_id`, which a correction's
-- MERGED, additive row can't provide on its own once more than one
-- correction has landed.
alter table private.guided_correction_completion_capabilities
  add column provider_usage_payload jsonb;

-- NOT VALID, permanently. Any environment holding a completion recorded
-- before this migration has `provider_usage_recorded_at` set with
-- `provider_usage_payload` null -- the payload was never captured, so no
-- VALIDATE step can ever make that row satisfy the pairing. A plain CHECK
-- validates every existing row at apply time and would abort the migration
-- on first contact with such a row (repo precedent for NOT VALID in exactly
-- this situation: 20260713003000:61,97; 20260731040000:127,129;
-- 20260811123000:103,109). NOT VALID still enforces the pairing on every
-- INSERT/UPDATE from here forward -- the writer below only ever sets both
-- columns together -- so this is a one-time grandfather for pre-migration
-- rows, not a hole for new ones.
alter table private.guided_correction_completion_capabilities
  add constraint guided_correction_capability_usage_payload_check check (
    (provider_usage_recorded_at is null) = (provider_usage_payload is null)
  ) not valid;

comment on column
  private.guided_correction_completion_capabilities.provider_usage_payload is
  'The exact usage record folded in when provider_usage_recorded_at was set. A replay is compared against this, not re-accepted unconditionally (#820 item 4).';

create or replace function public.record_guided_correction_provider_usage(
  p_completion_token text,
  p_usage jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cap private.guided_correction_completion_capabilities%rowtype;
  v_now timestamptz := statement_timestamp();
  v_stored public.pipeline_run_provider_usage%rowtype;
  v_model_calls numeric;
  v_input_tokens numeric;
  v_cached_input_tokens numeric;
  v_output_tokens numeric;
  v_reasoning_tokens numeric;
  v_sold_comp_attempts numeric := 0;
  v_sold_comp_results numeric := 0;
  v_charged numeric;
  v_models jsonb;
  v_sold_comps jsonb;
  v_merged_models jsonb;
  v_merged_sold_comps jsonb;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Guided correction completion authorization is required';
  end if;

  if p_completion_token !~ '^[A-Za-z0-9_-]{43}$'
    or not private.provider_usage_record_is_strict(p_usage) then
    raise exception using
      errcode = '22023',
      message = 'Invalid provider usage record';
  end if;

  -- A correction never transcribes: the seller's voice context is captured
  -- during the original run, under the worker's lease. Refusing an incoming
  -- transcription here keeps this seam to the two things a correction actually
  -- runs, while the stored transcription receipt is preserved below untouched.
  if coalesce(p_usage->'transcriptions', '[]'::jsonb) <> '[]'::jsonb then
    raise exception using
      errcode = '22023',
      message = 'Invalid provider usage record';
  end if;

  select * into v_cap
  from private.guided_correction_completion_capabilities capability
  where capability.token_hash = encode(
    sha256(convert_to(p_completion_token, 'UTF8')), 'hex'
  )
  for update;

  -- The fence. `consumed_at` is set by complete_guided_review_correction and
  -- complete_mobile_guided_correction and by nothing else, so a token that has
  -- not actually committed a correction — including one still in flight, one
  -- that failed, and one forged — writes nothing. The window bounds an
  -- otherwise permanent write key to an immediate retry.
  if not found
    or v_cap.consumed_at is null
    or v_now >= v_cap.consumed_at + interval '5 minutes' then
    raise exception using
      errcode = 'P0001',
      message = 'Guided correction capability is unavailable';
  end if;

  -- Once only, but a replay is CHECKED, not assumed (#820 item 4). An
  -- identical redelivery is answered the same way the running path answers
  -- one; a payload that has drifted from what was actually recorded is
  -- refused with the same conflict the running path raises for the identical
  -- failure mode, instead of silently reporting success for content that
  -- never landed.
  --
  -- A stored payload of null means this capability was recorded before this
  -- migration shipped -- back when the writer accepted every replay
  -- unconditionally and never captured one to compare against. That payload
  -- cannot be reconstructed after the fact, so a null stored payload is
  -- accepted rather than compared: the old contract for a pre-migration
  -- completion was "any replay succeeds," and this keeps honoring it for
  -- those rows instead of newly rejecting them. `p_usage = null` would
  -- itself evaluate to sql null here, which is not true, so this has to be
  -- its own branch rather than folding into the equality check below.
  if v_cap.provider_usage_recorded_at is not null then
    if v_cap.provider_usage_payload is null
      or p_usage = v_cap.provider_usage_payload then
      return true;
    end if;
    raise exception using
      errcode = '55000',
      message = 'Provider usage conflicts with the durable run receipt';
  end if;

  -- A correction whose listing carried no originating run has no #716 record to
  -- attribute to. That is a real answer, not a failure: the correction happened
  -- and the artifact simply cannot see it.
  if v_cap.expected_run_id is null then
    return false;
  end if;

  -- Tenancy: the row is located by the capability's OWN ownership triple, so a
  -- correction can only ever reach a run belonging to the same tenant and the
  -- same item the capability is bound to by foreign key.
  select stored.* into v_stored
  from public.pipeline_run_provider_usage stored
  where stored.run_id = v_cap.expected_run_id
    and stored.user_id = v_cap.user_id
    and stored.item_id = v_cap.item_id
  for update;

  if not found then
    return false;
  end if;

  v_model_calls := (p_usage->>'modelCalls')::numeric;
  v_input_tokens := (p_usage->>'inputTokens')::numeric;
  v_cached_input_tokens := (p_usage->>'cachedInputTokens')::numeric;
  v_output_tokens := (p_usage->>'outputTokens')::numeric;
  v_reasoning_tokens := (p_usage->>'reasoningTokens')::numeric;
  v_models := p_usage->'models';
  v_sold_comps := p_usage->'soldComps';

  select
    coalesce(sum((entry->>'attempts')::numeric), 0),
    coalesce(sum((entry->>'results')::numeric), 0)
  into v_sold_comp_attempts, v_sold_comp_results
  from jsonb_array_elements(v_sold_comps) entry;

  select sum((entry->>'chargedUsd')::numeric)
  into v_charged
  from jsonb_array_elements(v_sold_comps) entry
  where entry->>'chargedUsd' is not null;

  -- Computed once, checked below, and reused in the update: never merged
  -- twice, and never written without first proving the merge stayed inside
  -- the table's own 64/16 entry bounds.
  v_merged_models := private.provider_usage_merge_models(v_stored.models, v_models);
  v_merged_sold_comps := private.provider_usage_merge_sold_comps(
    v_stored.sold_comps, v_sold_comps
  );

  -- The run TOTAL still has to fit the columns it is stored in. Refusing here
  -- names the reason; letting the update overflow would surface as an opaque
  -- numeric error against a table the caller never touched directly. Every
  -- persisted numeric column that this write can grow is bounded here — the
  -- four bigint token columns included, not only the four integer columns
  -- 20260813030000 originally guarded (#820 item 3).
  if v_stored.model_calls + v_model_calls > 2147483647
    or v_stored.input_tokens + v_input_tokens > 9223372036854775807
    or v_stored.cached_input_tokens + v_cached_input_tokens > 9223372036854775807
    or v_stored.output_tokens + v_output_tokens > 9223372036854775807
    or v_stored.reasoning_tokens + v_reasoning_tokens > 9223372036854775807
    or v_stored.sold_comp_attempts + v_sold_comp_attempts > 2147483647
    or v_stored.sold_comp_results + v_sold_comp_results > 2147483647
    or v_stored.correction_count + 1 > 2147483647
    or coalesce(v_stored.sold_comp_charged_usd, 0) + coalesce(v_charged, 0)
       > 999999.999999
    or jsonb_array_length(v_merged_models) > 64
    or jsonb_array_length(v_merged_sold_comps) > 16 then
    raise exception using
      errcode = '22023',
      message = 'Invalid provider usage record';
  end if;

  update public.pipeline_run_provider_usage stored
  set
    -- Snapshotted on the FIRST correction only. A second correction tops up a
    -- row whose initial measurement is already preserved.
    initial_usage = coalesce(
      stored.initial_usage,
      jsonb_build_object(
        'modelCalls', stored.model_calls,
        'inputTokens', stored.input_tokens,
        'cachedInputTokens', stored.cached_input_tokens,
        'outputTokens', stored.output_tokens,
        'reasoningTokens', stored.reasoning_tokens,
        'soldCompAttempts', stored.sold_comp_attempts,
        'soldCompResults', stored.sold_comp_results,
        'soldCompChargedUsd', stored.sold_comp_charged_usd,
        'models', stored.models,
        'transcriptions', stored.transcriptions,
        'soldComps', stored.sold_comps
      )
    ),
    correction_count = stored.correction_count + 1,
    corrected_at = v_now,
    model_calls = stored.model_calls + v_model_calls,
    input_tokens = stored.input_tokens + v_input_tokens,
    cached_input_tokens = stored.cached_input_tokens + v_cached_input_tokens,
    output_tokens = stored.output_tokens + v_output_tokens,
    reasoning_tokens = stored.reasoning_tokens + v_reasoning_tokens,
    sold_comp_attempts = stored.sold_comp_attempts + v_sold_comp_attempts,
    sold_comp_results = stored.sold_comp_results + v_sold_comp_results,
    sold_comp_charged_usd = case
      when stored.sold_comp_charged_usd is null and v_charged is null then null
      else coalesce(stored.sold_comp_charged_usd, 0) + coalesce(v_charged, 0)
    end,
    models = v_merged_models,
    sold_comps = v_merged_sold_comps
  where stored.run_id = v_cap.expected_run_id;

  update private.guided_correction_completion_capabilities capability
  set
    provider_usage_recorded_at = v_now,
    provider_usage_payload = p_usage
  where capability.reservation_id = v_cap.reservation_id;

  return true;
end;
$$;

revoke all on function public.record_guided_correction_provider_usage(text, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_guided_correction_provider_usage(text, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- Postconditions, scoped to what this migration changed.
-- ---------------------------------------------------------------------------
do $replay_fence_postconditions$
begin
  if not has_function_privilege(
      'service_role',
      'public.record_guided_correction_provider_usage(text,jsonb)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.record_guided_correction_provider_usage(text,jsonb)',
      'EXECUTE'
    )
    or has_function_privilege(
      'anon',
      'public.record_guided_correction_provider_usage(text,jsonb)',
      'EXECUTE'
    ) then
    raise exception
      'The post-completion usage writer must remain reachable only by the worker identity';
  end if;

  if not exists (
    select 1
    from pg_proc procedure
    where procedure.oid =
      'public.record_guided_correction_provider_usage(text,jsonb)'::regprocedure
      and procedure.prosecdef
      and procedure.proconfig @> array['search_path=""']::text[]
  ) then
    raise exception
      'The post-completion usage writer must stay security definer with an empty search_path';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'private'
      and table_name = 'guided_correction_completion_capabilities'
      and column_name = 'provider_usage_payload'
  ) then
    raise exception
      'The replay fence requires provider_usage_payload on the completion capability';
  end if;
end;
$replay_fence_postconditions$;
