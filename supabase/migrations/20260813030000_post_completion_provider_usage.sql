-- Issue #724: attribute a guided correction's provider spend to the run it
-- corrects, so the percentile artifact #716 exists to inform is not biased low
-- for exactly the runs the free-tier promise covers.
--
-- ADR-0008 makes the included guided correction part of the SAME AI item run on
-- the SAME credit. Both correction paths — the web identity correction and the
-- native Sharpen correction — run the pricing router and the listing generator
-- AFTER that run has completed. They hold no worker lease and the run is no
-- longer `running`, so `record_pipeline_run_provider_usage` refuses them by
-- construction, and their tokens have been discarded.
--
-- The lease-fenced running-path writer is NOT touched here. What this adds is a
-- second, narrower capability for the one thing that provably happened after
-- completion: a correction that already committed.
--
-- The security property #716 established stands unchanged. `insert` and
-- `update` on public.pipeline_run_provider_usage remain revoked from every
-- runtime role including service_role. The only new privilege is `execute` on
-- one security-definer function whose authority is a consumed guided-correction
-- capability, and which reads the tenant, the item, and the target run off that
-- stored capability rather than accepting them from the caller.

-- ---------------------------------------------------------------------------
-- The initial/correction split.
--
-- A corrected run's row becomes the run's TOTAL spend, which is what the
-- allowance decision needs. Summing the correction in without a trace would
-- make that total unauditable, so the pre-correction measurement is snapshotted
-- verbatim on the first top-up.
--
--   initial_usage is null  -> no correction landed; the row IS the initial
--                             analysis. Every historical row reads this way, so
--                             no backfill is needed and none is performed.
--   initial_usage not null -> the columns are the run total, and the
--                             correction is (columns - initial_usage).
-- ---------------------------------------------------------------------------

-- Validates the snapshot with the same content-free allowlist the columns it
-- mirrors are already held to. Immutable so a CHECK constraint may call it,
-- exactly as private.provider_usage_entries_coarse is called today.
create or replace function private.provider_usage_initial_snapshot_is_strict(
  p_snapshot jsonb
)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $$
  select jsonb_typeof(p_snapshot) = 'object'
    and p_snapshot - array[
      'modelCalls', 'inputTokens', 'cachedInputTokens', 'outputTokens',
      'reasoningTokens', 'soldCompAttempts', 'soldCompResults',
      'soldCompChargedUsd', 'models', 'transcriptions', 'soldComps'
    ] = '{}'::jsonb
    and p_snapshot ?& array[
      'modelCalls', 'inputTokens', 'cachedInputTokens', 'outputTokens',
      'reasoningTokens', 'soldCompAttempts', 'soldCompResults',
      'soldCompChargedUsd', 'models', 'transcriptions', 'soldComps'
    ]
    and private.provider_usage_entries_coarse(
      p_snapshot->'models',
      array[
        'role', 'provider', 'model', 'calls', 'inputTokens',
        'cachedInputTokens', 'outputTokens', 'reasoningTokens'
      ],
      64
    )
    and private.provider_usage_entries_coarse(
      p_snapshot->'transcriptions',
      array['role', 'provider', 'model', 'calls', 'chargedUsd'],
      16
    )
    and private.provider_usage_entries_coarse(
      p_snapshot->'soldComps',
      array['strategy', 'attempts', 'results', 'chargedUsd'],
      16
    );
$$;

revoke all on function private.provider_usage_initial_snapshot_is_strict(jsonb)
  from public, anon, authenticated, service_role;

alter table public.pipeline_run_provider_usage
  add column initial_usage jsonb,
  add column correction_count integer not null default 0,
  add column corrected_at timestamptz;

alter table public.pipeline_run_provider_usage
  add constraint pipeline_run_provider_usage_correction_split_check check (
    (
      initial_usage is null
      and correction_count = 0
      and corrected_at is null
    ) or (
      initial_usage is not null
      and correction_count > 0
      and corrected_at is not null
    )
  ),
  add constraint pipeline_run_provider_usage_initial_usage_check check (
    initial_usage is null
    or private.provider_usage_initial_snapshot_is_strict(initial_usage)
  );

comment on column public.pipeline_run_provider_usage.initial_usage is
  'Content-free snapshot of this run''s measurement BEFORE any guided correction topped it up. Null means no correction landed and the columns are the initial analysis; otherwise the correction is the columns minus this.';
comment on column public.pipeline_run_provider_usage.correction_count is
  'How many guided corrections have been folded into this row. Zero for an uncorrected run.';

-- ---------------------------------------------------------------------------
-- The write once marker on the existing correction capability.
--
-- The capability is already the audit record for a correction: one row per
-- authorized attempt, hash-addressed, bound by foreign key to the tenant, the
-- item, and the listing. Recording the usage against it keeps the audit in one
-- place and makes the report idempotent without a second table.
-- ---------------------------------------------------------------------------

alter table private.guided_correction_completion_capabilities
  add column provider_usage_recorded_at timestamptz;

alter table private.guided_correction_completion_capabilities
  add constraint guided_correction_capability_usage_recorded_check check (
    provider_usage_recorded_at is null
    or (
      consumed_at is not null
      and provider_usage_recorded_at >= consumed_at
    )
  );

comment on column
  private.guided_correction_completion_capabilities.provider_usage_recorded_at is
  'When this correction''s provider spend was folded into the originating run''s usage row. Null until it lands; set once, so a retried report cannot double-count.';

-- ---------------------------------------------------------------------------
-- Merges. A run total must stay one entry per (role, provider, model) and one
-- per sold-comp strategy, or a corrected run would drift past the 64/16 entry
-- bounds the table enforces and stop diffing cleanly against an uncorrected one.
-- ---------------------------------------------------------------------------

create or replace function private.provider_usage_merge_models(
  p_existing jsonb,
  p_incoming jsonb
)
returns jsonb
language sql
immutable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'role', merged.role,
        'provider', merged.provider,
        'model', merged.model,
        'calls', merged.calls,
        'inputTokens', merged.input_tokens,
        'cachedInputTokens', merged.cached_input_tokens,
        'outputTokens', merged.output_tokens,
        'reasoningTokens', merged.reasoning_tokens
      )
      order by merged.role, merged.provider, merged.model
    ),
    '[]'::jsonb
  )
  from (
    select
      entry->>'role' as role,
      entry->>'provider' as provider,
      entry->>'model' as model,
      sum((entry->>'calls')::numeric) as calls,
      sum((entry->>'inputTokens')::numeric) as input_tokens,
      sum((entry->>'cachedInputTokens')::numeric) as cached_input_tokens,
      sum((entry->>'outputTokens')::numeric) as output_tokens,
      sum((entry->>'reasoningTokens')::numeric) as reasoning_tokens
    from jsonb_array_elements(
      coalesce(p_existing, '[]'::jsonb) || coalesce(p_incoming, '[]'::jsonb)
    ) entry
    group by 1, 2, 3
  ) merged;
$$;

revoke all on function private.provider_usage_merge_models(jsonb, jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.provider_usage_merge_sold_comps(
  p_existing jsonb,
  p_incoming jsonb
)
returns jsonb
language sql
immutable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'strategy', merged.strategy,
        'attempts', merged.attempts,
        'results', merged.results,
        'chargedUsd', merged.charged_usd
      )
      order by merged.strategy
    ),
    '[]'::jsonb
  )
  from (
    select
      entry->>'strategy' as strategy,
      sum((entry->>'attempts')::numeric) as attempts,
      sum((entry->>'results')::numeric) as results,
      -- sum() ignores SQL NULLs and returns NULL when every input is one, which
      -- is exactly the null-preserving rule the table documents: a strategy that
      -- reported no charge stays unknown rather than becoming zero.
      sum((entry->>'chargedUsd')::numeric) as charged_usd
    from jsonb_array_elements(
      coalesce(p_existing, '[]'::jsonb) || coalesce(p_incoming, '[]'::jsonb)
    ) entry
    group by 1
  ) merged;
$$;

revoke all on function private.provider_usage_merge_sold_comps(jsonb, jsonb)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The post-completion writer.
--
-- Authority is a guided-correction capability that has ALREADY been consumed,
-- inside a bounded window after it was. That ordering is the point: the
-- correction is durable before its cost is reported, so a bookkeeping outage can
-- never cost a seller the work they confirmed, and a capability that never
-- committed a correction cannot write anything at all.
-- ---------------------------------------------------------------------------
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

  -- The run TOTAL still has to fit the columns it is stored in. Refusing here
  -- names the reason; letting the update overflow would surface as an opaque
  -- numeric error against a table the caller never touched directly.
  if v_stored.model_calls + v_model_calls > 2147483647
    or v_stored.sold_comp_attempts + v_sold_comp_attempts > 2147483647
    or v_stored.sold_comp_results + v_sold_comp_results > 2147483647
    or v_stored.correction_count + 1 > 2147483647
    or coalesce(v_stored.sold_comp_charged_usd, 0) + coalesce(v_charged, 0)
       > 999999.999999 then
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
    models = private.provider_usage_merge_models(stored.models, v_models),
    sold_comps = private.provider_usage_merge_sold_comps(
      stored.sold_comps, v_sold_comps
    )
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

-- Correction spend is now part of what this reports (#724 AC5). The measures and
-- the completed-run scope are unchanged; what a run's row MEANS has widened from
-- "one successful attempt's analysis" to "that analysis plus every included
-- guided correction folded into it".
comment on function public.pipeline_run_provider_usage_percentiles(
  timestamptz, timestamptz
) is
  'Median and p95 measured provider consumption per COMPLETED AI item run over a date range. A corrected run contributes its initial analysis PLUS its included guided corrections, matching ADR-0008 (one run, one credit); pipeline_run_provider_usage.initial_usage recovers the pre-correction split. Operator query only: no runtime role holds execute.';

-- ---------------------------------------------------------------------------
-- Postconditions. The properties this migration must not have broken, asserted
-- rather than assumed.
-- ---------------------------------------------------------------------------
do $post_completion_postconditions$
begin
  if has_table_privilege(
      'service_role', 'public.pipeline_run_provider_usage', 'insert'
    )
    or has_table_privilege(
      'service_role', 'public.pipeline_run_provider_usage', 'update'
    )
    or has_table_privilege(
      'authenticated', 'public.pipeline_run_provider_usage', 'insert'
    )
    or has_table_privilege(
      'authenticated', 'public.pipeline_run_provider_usage', 'update'
    ) then
    raise exception
      'Post-completion usage must not grant a direct write on the cost table';
  end if;

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
      'The post-completion usage writer must be reachable only by the worker identity';
  end if;

  if (
      select count(*)
      from pg_proc procedure
      where procedure.oid in (
        'public.record_guided_correction_provider_usage(text,jsonb)'::regprocedure,
        'private.provider_usage_initial_snapshot_is_strict(jsonb)'::regprocedure,
        'private.provider_usage_merge_models(jsonb,jsonb)'::regprocedure,
        'private.provider_usage_merge_sold_comps(jsonb,jsonb)'::regprocedure
      )
        and procedure.prosecdef
        and procedure.proconfig @> array['search_path=""']::text[]
    ) <> 4 then
    raise exception
      'Every post-completion usage function must be security definer with an empty search_path';
  end if;

  -- The running path is this migration's explicit non-goal. If its lease fence
  -- is gone, something in here reached a surface it does not own.
  if position(
      'lease_expires_at'
      in pg_get_functiondef(
        'public.record_pipeline_run_provider_usage(uuid,uuid,jsonb)'::regprocedure
      )
    ) = 0 then
    raise exception 'The running-path lease fence must remain intact';
  end if;
end;
$post_completion_postconditions$;
