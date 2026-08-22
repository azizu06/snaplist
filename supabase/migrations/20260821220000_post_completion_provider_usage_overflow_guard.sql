-- Issue #820 item 3 (a non-blocking finding from the #818 review of #724):
-- the post-completion writer's overflow guard named every persisted numeric
-- bound EXCEPT the four that can actually overflow. `input_tokens`,
-- `cached_input_tokens`, `output_tokens`, and `reasoning_tokens` are each
-- individually bounded at int64 max by private.provider_usage_record_is_strict,
-- so `stored + incoming` can still exceed the `bigint` column those four are
-- stored in and surface as an opaque "bigint out of range" error -- exactly the
-- error the guard's comment already says it exists to keep the caller from
-- seeing.
--
-- Separately, the merge functions only DEDUPE identical (role, provider,
-- model) triples (and sold-comp strategies): 64 existing plus 64 disjoint
-- incoming entries merge to 128, past this table's own
-- pipeline_run_provider_usage_models_check (64) / _sold_comps_check (16) from
-- 20260806200000. The header comment in 20260813030000 claiming the merge
-- "keeps a corrected run inside the 64/16 entry bounds the table enforces" is
-- not true in general -- correcting the claim here since the comment it lives
-- in has already shipped and is not itself worth a migration edit. This guard
-- makes that failure the same deliberate 22023 this function already raises
-- for every other bound, instead of an opaque CHECK violation against a table
-- the caller never touched directly.
--
-- Both are practically unreachable today (five roles times two providers, and
-- a correction runs exactly `listing` plus `pricingAgent`), which is why this
-- ships as a standalone hardening pass rather than having blocked #818.
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

  -- Once only. A redelivered report is answered rather than added again, for
  -- the same reason the running path refuses to double a run's measured cost.
  if v_cap.provider_usage_recorded_at is not null then
    return true;
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
  -- 20260813030000 originally guarded.
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
  set provider_usage_recorded_at = v_now
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
do $overflow_guard_postconditions$
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
end;
$overflow_guard_postconditions$;
