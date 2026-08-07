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

-- Account erasure coverage (#384). A tenant table is only erasable if erasure
-- both fences it and counts it: the fence stops a late write from resurrecting
-- rows after erasure starts, and the count is the residue proof erasure reports
-- completion against. Rows themselves go with the run — the composite foreign
-- key above cascades from public.pipeline_runs, which advance_account_erasure
-- already deletes.
create trigger zzz_fence_account_erasure_tenant_mutation
  before insert or update or delete on public.pipeline_run_provider_usage
  for each row execute function private.fence_account_erasure_tenant_mutation();

-- Re-declared in full, as every migration that adds a tenant table does: the
-- function is one flat union and Postgres has no way to extend it in place.
create or replace function private.account_erasure_owned_row_count(p_user_id text)
returns integer
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce(sum(residue.count), 0)::integer
  from (
    select count(*)::integer as count from public.items where user_id = p_user_id
    union all select count(*)::integer from public.listings where user_id = p_user_id
    union all select count(*)::integer from public.export_handoffs where user_id = p_user_id
    union all select count(*)::integer from public.messages where user_id = p_user_id
    union all select count(*)::integer from public.embeddings where user_id = p_user_id
    union all select count(*)::integer from public.prediction_logs where user_id = p_user_id
    union all select count(*)::integer from public.user_settings where user_id = p_user_id
    union all select count(*)::integer from public.activation_guidance_completions where user_id = p_user_id
    union all select count(*)::integer from public.ebay_photo_access_tokens where user_id = p_user_id
    union all select count(*)::integer from public.ebay_connections where user_id = p_user_id
    union all select count(*)::integer from public.subscriptions where user_id = p_user_id
    union all select count(*)::integer from public.notifications where user_id = p_user_id
    union all select count(*)::integer from public.reprice_suggestions where user_id = p_user_id
    union all select count(*)::integer from public.ebay_message_sync_state where user_id = p_user_id
    union all select count(*)::integer from public.ebay_unresolved_questions where user_id = p_user_id
    union all select count(*)::integer from public.message_policy_decisions where user_id = p_user_id
    union all select count(*)::integer from public.message_attachments where user_id = p_user_id
    union all select count(*)::integer from public.billing_customers where user_id = p_user_id
    union all select count(*)::integer from public.billing_checkout_reservations where user_id = p_user_id
    union all select count(*)::integer from public.ai_item_allowance_periods where user_id = p_user_id
    union all select count(*)::integer from public.ai_item_credit_reservations where user_id = p_user_id
    union all select count(*)::integer from public.revenuecat_customer_bindings where user_id = p_user_id
    union all select count(*)::integer from public.pipeline_runs where user_id = p_user_id
    union all select count(*)::integer from public.pipeline_run_provider_usage where user_id = p_user_id
    union all select count(*)::integer from public.pipeline_run_history_order_versions where user_id = p_user_id
    union all select count(*)::integer from public.pricing_evidence_snapshots where user_id = p_user_id
    union all select count(*)::integer from public.ebay_oauth_sessions where user_id = p_user_id
    union all select count(*)::integer from public.included_offer_device_claims where user_id = p_user_id
    union all select count(*)::integer from public.included_offer_support_overrides where user_id = p_user_id
    union all select count(*)::integer from private.ebay_messaging_account_generations where user_id = p_user_id
    union all select count(*)::integer from private.ebay_seller_account_generations where user_id = p_user_id
    union all select count(*)::integer from private.ebay_provider_dispatch_leases where user_id = p_user_id
    union all select count(*)::integer from private.ebay_buyer_identity_provenance where user_id = p_user_id
    union all select count(*)::integer from private.ebay_buyer_identity_observations where user_id = p_user_id
    union all select count(*)::integer from private.ebay_erased_buyer_generation_tombstones where user_id = p_user_id
    union all select count(*)::integer from private.ebay_sandbox_fallback_bindings where user_id = p_user_id
    union all select count(*)::integer from private.ebay_unmappable_connection_quarantines where user_id = p_user_id
    union all select count(*)::integer from private.ebay_seller_identity_tenants where user_id = p_user_id
    union all select count(*)::integer from private.pipeline_run_usage_reservations where user_id = p_user_id
    union all select count(*)::integer from private.pipeline_staging_cleanup_intents where user_id = p_user_id
    union all select count(*)::integer from private.legacy_pipeline_usage_reservations where user_id = p_user_id
    union all select count(*)::integer from private.mobile_item_submissions where user_id = p_user_id
    union all select count(*)::integer from private.mobile_item_submission_voice_handoffs where user_id = p_user_id
    union all select count(*)::integer from private.mobile_listing_review_saves where user_id = p_user_id
    union all select count(*)::integer from private.mobile_guided_corrections where user_id = p_user_id
    union all select count(*)::integer from private.mobile_run_operation_replays where user_id = p_user_id
    union all select count(*)::integer from private.guided_correction_completion_capabilities where user_id = p_user_id
    union all select count(*)::integer from private.verified_guest_capabilities where user_id = p_user_id
    union all select count(*)::integer from private.storekit_ai_item_period_events where user_id = p_user_id
    union all select count(*)::integer from private.revenuecat_webhook_events where user_id = p_user_id
    union all select count(*)::integer from private.guest_claim_handoffs where guest_user_id = p_user_id
    union all select count(*)::integer
      from private.guest_draft_recoveries
      where p_user_id in (guest_user_id, claim_idempotency_user_id, claim_target_user_id)
    union all select count(*)::integer
      from private.pipeline_storage_cleanup_jobs job
      where exists (
        select 1 from unnest(job.photo_paths) path
        where split_part(path, '/', 1) = p_user_id
      )
    union all select count(*)::integer
      from private.message_photo_object_deletion_queue
      where split_part(storage_path, '/', 1) = p_user_id
  ) residue
$$;

revoke all on function private.account_erasure_owned_row_count(text)
  from public, anon, authenticated, service_role;
