-- Issue #716: the tenant contract for measured per-run provider consumption.
--
-- On the shared stale local stack, the exclusive lease applies only
-- 20260811123000_reconcile_durable_seller_voice_context.sql before this file.
-- This transaction then rolls every fixture back without changing migration
-- history. A clean temporary database reaches the same schema through both
-- ordered #774 migrations.

begin;

-- This file now exercises #774 behavior as well as #716. Fail before fixtures
-- unless the exact reconciliation contract is installed: usage accounting,
-- typed provider-contact provenance, and the four-argument outcome capability.
select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'pipeline_run_provider_usage'
      and column_name = 'transcriptions'
  ) and (
    select count(*) = 2
    from information_schema.columns
    where table_schema = 'private'
      and table_name = 'mobile_item_submission_voice_handoffs'
      and column_name in (
        'terminal_voice_outcome',
        'transcription_provider_contacted'
      )
  ) and exists (
    select 1
    from pg_constraint constraint_record
    where constraint_record.conrelid =
          'private.mobile_item_submission_voice_handoffs'::regclass
      and constraint_record.conname =
          'mobile_voice_terminal_provider_provenance_check'
      and constraint_record.convalidated
  ) and to_regprocedure(
    'public.record_pipeline_run_voice_outcome(uuid,uuid,text,boolean)'
  ) is not null and to_regprocedure(
    'public.record_pipeline_run_voice_outcome(uuid,uuid,text)'
  ) is null and exists (
    select 1
    from pg_proc procedure
    where procedure.oid =
          'public.record_pipeline_run_provider_usage(uuid,uuid,jsonb)'::regprocedure
      and procedure.prosecdef
      and procedure.proconfig @> array['search_path=""']::text[]
      and position(
        'private.provider_usage_record_is_strict'
        in pg_get_functiondef(procedure.oid)
      ) > 0
      and position('for update' in lower(pg_get_functiondef(procedure.oid))) > 0
  ) and exists (
    select 1 from pg_proc procedure
    where procedure.oid =
          'private.provider_usage_record_is_strict(jsonb)'::regprocedure
      and procedure.prosecdef
      and procedure.proconfig @> array['search_path=""']::text[]
  ) as require_issue_774_schema \gset
\if :require_issue_774_schema
\else
\echo 'pipeline_run_provider_usage.test.sql requires the exact issue #774 reconciliation schema'
\quit 3
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
    union all select count(*)::integer from public.ebay_listing_sync_state where user_id = p_user_id
    union all select count(*)::integer from public.ebay_listing_sync_conflicts where user_id = p_user_id
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
\endif

-- ---------------------------------------------------------------------------
-- Issue #724's post-completion writer.
--
-- CI installs every branch migration and sets pgtap_ci.require_installed_migrations,
-- so there the real migration is what these assertions run against. A shared
-- local stack that is behind this branch injects the same DDL inside this
-- transaction instead, and it rolls back with every fixture below.
--
-- The copy is byte-identical to the migration file, asserted offline by
-- src/lib/provider-usage/post-completion-migration.test.ts so the two cannot
-- drift apart unnoticed.
-- ---------------------------------------------------------------------------
select to_regprocedure(
  'public.record_guided_correction_provider_usage(text,jsonb)'
) is not null as post_completion_installed \gset
select to_regclass('pgtap_ci.require_installed_migrations') is not null
  as require_installed_migration \gset
\if :post_completion_installed
\else
\if :require_installed_migration
\echo 'pipeline_run_provider_usage.test.sql requires the issue #724 post-completion migration'
\quit 3
\endif
-- >>> BEGIN inline copy of supabase/migrations/20260813030000_post_completion_provider_usage.sql
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
-- <<< END inline copy of supabase/migrations/20260813030000_post_completion_provider_usage.sql
\endif

select plan(78);

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
   '88880000-0000-4000-8000-000000000717'::uuid),
  ('11110000-0000-4000-8000-000000000718'::uuid, 'user_pgtap_716_a',
   '88880000-0000-4000-8000-000000000718'::uuid)
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
   statement_timestamp() + interval '5 minutes'),
  ('22220000-0000-4000-8000-000000000718', 'user_pgtap_716_a',
   '11110000-0000-4000-8000-000000000718', 'running', 'generating',
   'cost-pgtap-716-empty-upgrade', 1, statement_timestamp(), statement_timestamp(),
   '33330000-0000-4000-8000-000000000718',
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

select extensions.throws_ok(
  $$select public.record_pipeline_run_provider_usage(
      '22220000-0000-4000-8000-000000000716'::uuid,
      '33330000-0000-4000-8000-000000000716'::uuid,
      '{"schemaVersion":1,"modelCalls":1,"inputTokens":0,"cachedInputTokens":0,"outputTokens":0,"reasoningTokens":0,"models":[],"transcriptions":[{"role":"sellerContext","provider":"openai","model":"gpt-4o-mini-transcribe","calls":1}],"soldComps":[]}'::jsonb
    )$$,
  '22023',
  'Invalid provider usage record',
  'a transcription receipt with a missing field is rejected before persistence'
);

select extensions.throws_ok(
  $$select public.record_pipeline_run_provider_usage(
      '22220000-0000-4000-8000-000000000716'::uuid,
      '33330000-0000-4000-8000-000000000716'::uuid,
      '{"schemaVersion":1,"modelCalls":1,"inputTokens":0,"cachedInputTokens":0,"outputTokens":0,"reasoningTokens":0,"models":[],"transcriptions":[{"role":"sellerContext","provider":"openai","model":"gpt-4o-mini-transcribe","calls":"1","chargedUsd":null}],"soldComps":[]}'::jsonb
    )$$,
  '22023',
  'Invalid provider usage record',
  'a transcription receipt with a wrong field type is rejected before persistence'
);

select extensions.throws_ok(
  $$select public.record_pipeline_run_provider_usage(
      '22220000-0000-4000-8000-000000000716'::uuid,
      '33330000-0000-4000-8000-000000000716'::uuid,
      '{"schemaVersion":1,"modelCalls":1,"inputTokens":0,"cachedInputTokens":0,"outputTokens":0,"reasoningTokens":0,"models":[],"transcriptions":[{"role":"sellerContext","provider":"openai","model":"gpt-4o-mini-transcribe","calls":1,"chargedUsd":null,"transcript":"PRIVATE_SENTINEL"}],"soldComps":[]}'::jsonb
    )$$,
  '22023',
  'Invalid provider usage record',
  'a transcription receipt with an extra text field is rejected without echoing it'
);

select extensions.throws_ok(
  $$select public.record_pipeline_run_provider_usage(
      '22220000-0000-4000-8000-000000000716'::uuid,
      '33330000-0000-4000-8000-000000000716'::uuid,
      '{"schemaVersion":1,"modelCalls":"PRIVATE_SENTINEL","inputTokens":0,"cachedInputTokens":0,"outputTokens":0,"reasoningTokens":0,"models":[],"transcriptions":[],"soldComps":[]}'::jsonb
    )$$,
  '22023',
  'Invalid provider usage record',
  'a malformed numeric scalar is rejected without echoing it'
);

select lives_ok(
  $$select public.record_pipeline_run_provider_usage(
      '22220000-0000-4000-8000-000000000716'::uuid,
      '33330000-0000-4000-8000-000000000716'::uuid,
      '{"schemaVersion":1,"modelCalls":2,"inputTokens":3000,"cachedInputTokens":640,"outputTokens":400,"reasoningTokens":64,"models":[{"role":"vision","provider":"openai","model":"resolved-vision","calls":1,"inputTokens":2000,"cachedInputTokens":640,"outputTokens":250,"reasoningTokens":64},{"role":"listing","provider":"openai","model":"resolved-listing","calls":1,"inputTokens":1000,"cachedInputTokens":0,"outputTokens":150,"reasoningTokens":0}],"soldComps":[{"strategy":"apify","attempts":1,"results":9,"chargedUsd":0.0247}]}'::jsonb
    )$$,
  'the worker records the run cost through its lease'
);

-- An exact redelivery is already satisfied without doubling the number the
-- allowance is set from.
select is(
  (select public.record_pipeline_run_provider_usage(
      '22220000-0000-4000-8000-000000000716'::uuid,
      '33330000-0000-4000-8000-000000000716'::uuid,
      '{"schemaVersion":1,"modelCalls":2,"inputTokens":3000,"cachedInputTokens":640,"outputTokens":400,"reasoningTokens":64,"models":[{"role":"vision","provider":"openai","model":"resolved-vision","calls":1,"inputTokens":2000,"cachedInputTokens":640,"outputTokens":250,"reasoningTokens":64},{"role":"listing","provider":"openai","model":"resolved-listing","calls":1,"inputTokens":1000,"cachedInputTokens":0,"outputTokens":150,"reasoningTokens":0}],"soldComps":[{"strategy":"apify","attempts":1,"results":9,"chargedUsd":0.0247}]}'::jsonb
    )),
  true,
  'an exact full-usage replay reports durable success'
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

-- A rolling upgrade may inherit a complete old-worker usage row before the
-- voice checkpoint exists. The late transcription receipt merges into that
-- full authority exactly once, and a different identity conflicts visibly.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select public.record_pipeline_run_provider_usage(
      '22220000-0000-4000-8000-000000000716'::uuid,
      '33330000-0000-4000-8000-000000000716'::uuid,
      '{"schemaVersion":1,"modelCalls":1,"inputTokens":0,"cachedInputTokens":0,"outputTokens":0,"reasoningTokens":0,"models":[],"transcriptions":[{"role":"sellerContext","provider":"openai","model":"gpt-4o-mini-transcribe","calls":1,"chargedUsd":null}],"soldComps":[]}'::jsonb
    )),
  true,
  'an old-worker full-first row accepts one late transcription receipt'
);
reset role;

select is(
  (select row(
      model_calls,
      input_tokens,
      jsonb_array_length(models),
      transcriptions->0->>'model',
      (transcriptions->0->>'calls')::integer
    )::text
   from public.pipeline_run_provider_usage
   where run_id = '22220000-0000-4000-8000-000000000716'),
  row(3, 3000::bigint, 2, 'gpt-4o-mini-transcribe', 1)::text,
  'the late receipt preserves full usage and adds one transcription call'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select public.record_pipeline_run_provider_usage(
      '22220000-0000-4000-8000-000000000716'::uuid,
      '33330000-0000-4000-8000-000000000716'::uuid,
      '{"schemaVersion":1,"modelCalls":1,"inputTokens":0,"cachedInputTokens":0,"outputTokens":0,"reasoningTokens":0,"models":[],"transcriptions":[{"role":"sellerContext","provider":"openai","model":"gpt-4o-mini-transcribe","calls":1,"chargedUsd":null}],"soldComps":[]}'::jsonb
    )),
  true,
  'the exact late transcription replay reports durable success'
);
reset role;

select is(
  (select row(model_calls, jsonb_array_length(models), jsonb_array_length(transcriptions))::text
   from public.pipeline_run_provider_usage
   where run_id = '22220000-0000-4000-8000-000000000716'),
  row(3, 2, 1)::text,
  'the exact late transcription replay does not double any usage'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select extensions.throws_ok(
  $$select public.record_pipeline_run_provider_usage(
      '22220000-0000-4000-8000-000000000716'::uuid,
      '33330000-0000-4000-8000-000000000716'::uuid,
      '{"schemaVersion":1,"modelCalls":1,"inputTokens":0,"cachedInputTokens":0,"outputTokens":0,"reasoningTokens":0,"models":[],"transcriptions":[{"role":"sellerContext","provider":"openai","model":"different-transcription-model","calls":1,"chargedUsd":null}],"soldComps":[]}'::jsonb
    )$$,
  '55000',
  'Provider usage conflicts with the durable run receipt',
  'a different late transcription identity conflicts instead of reporting success'
);
reset role;

select is(
  (select row(model_calls, transcriptions->0->>'model')::text
   from public.pipeline_run_provider_usage
   where run_id = '22220000-0000-4000-8000-000000000716'),
  row(3, 'gpt-4o-mini-transcribe')::text,
  'an incompatible late receipt leaves the durable usage unchanged'
);

-- A failed attempt persists only its paid transcription receipt. The replay
-- fills the remaining run usage without repeating or overwriting that call.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select lives_ok(
  $$select public.record_pipeline_run_provider_usage(
      '22220000-0000-4000-8000-000000000717'::uuid,
      '33330000-0000-4000-8000-000000000717'::uuid,
      '{"schemaVersion":1,"modelCalls":1,"inputTokens":0,"cachedInputTokens":0,"outputTokens":0,"reasoningTokens":0,"models":[],"transcriptions":[{"role":"sellerContext","provider":"openai","model":"gpt-4o-mini-transcribe","calls":1,"chargedUsd":null}],"soldComps":[]}'::jsonb
    )$$,
  'a failed attempt records one content-free transcription receipt'
);

select lives_ok(
  $$select public.record_pipeline_run_provider_usage(
      '22220000-0000-4000-8000-000000000717'::uuid,
      '33330000-0000-4000-8000-000000000717'::uuid,
      '{"schemaVersion":1,"modelCalls":2,"inputTokens":3000,"cachedInputTokens":640,"outputTokens":400,"reasoningTokens":64,"models":[{"role":"vision","provider":"openai","model":"resolved-vision","calls":1,"inputTokens":2000,"cachedInputTokens":640,"outputTokens":250,"reasoningTokens":64},{"role":"listing","provider":"openai","model":"resolved-listing","calls":1,"inputTokens":1000,"cachedInputTokens":0,"outputTokens":150,"reasoningTokens":0}],"transcriptions":[],"soldComps":[]}'::jsonb
    )$$,
  'a successful replay fills non-transcription usage'
);
reset role;

select is(
  (select row(
      model_calls,
      input_tokens,
      jsonb_array_length(models),
      (transcriptions->0->>'calls')::integer
    )::text
   from public.pipeline_run_provider_usage
   where run_id = '22220000-0000-4000-8000-000000000717'),
  row(3, 3000::bigint, 2, 1)::text,
  'replay usage is combined while the transcription total stays one'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.record_pipeline_run_provider_usage(
      '22220000-0000-4000-8000-000000000717'::uuid,
      '33330000-0000-4000-8000-000000000717'::uuid,
      '{"schemaVersion":1,"modelCalls":2,"inputTokens":3000,"cachedInputTokens":640,"outputTokens":400,"reasoningTokens":64,"models":[{"role":"vision","provider":"openai","model":"resolved-vision","calls":1,"inputTokens":2000,"cachedInputTokens":640,"outputTokens":250,"reasoningTokens":64},{"role":"listing","provider":"openai","model":"resolved-listing","calls":1,"inputTokens":1000,"cachedInputTokens":0,"outputTokens":150,"reasoningTokens":0}],"transcriptions":[],"soldComps":[]}'::jsonb
    )$$,
  'the same replay receipt is accepted idempotently'
);
reset role;

select is(
  (select row(
      model_calls,
      input_tokens,
      jsonb_array_length(models),
      (transcriptions->0->>'calls')::integer
    )::text
   from public.pipeline_run_provider_usage
   where run_id = '22220000-0000-4000-8000-000000000717'),
  row(3, 3000::bigint, 2, 1)::text,
  'replaying the same success does not double any recorded attempt'
);

-- An old worker may have persisted a canonical all-zero row before any paid
-- provider call. A rolling-upgrade worker may add exactly one late content-free
-- transcription receipt to that row, but no other identity.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.record_pipeline_run_provider_usage(
      '22220000-0000-4000-8000-000000000718'::uuid,
      '33330000-0000-4000-8000-000000000718'::uuid,
      '{"schemaVersion":1,"modelCalls":0,"inputTokens":0,"cachedInputTokens":0,"outputTokens":0,"reasoningTokens":0,"models":[],"transcriptions":[],"soldComps":[]}'::jsonb
    )$$,
  'an all-zero old-worker row is recorded before a late transcription'
);
select is(
  (select public.record_pipeline_run_provider_usage(
      '22220000-0000-4000-8000-000000000718'::uuid,
      '33330000-0000-4000-8000-000000000718'::uuid,
      '{"schemaVersion":1,"modelCalls":1,"inputTokens":0,"cachedInputTokens":0,"outputTokens":0,"reasoningTokens":0,"models":[],"transcriptions":[{"role":"sellerContext","provider":"openai","model":"gpt-4o-mini-transcribe","calls":1,"chargedUsd":null}],"soldComps":[]}'::jsonb
    )),
  true,
  'an all-zero old-worker row accepts one late transcription receipt'
);
reset role;

select is(
  (select row(model_calls, jsonb_array_length(models), jsonb_array_length(transcriptions))::text
   from public.pipeline_run_provider_usage
   where run_id = '22220000-0000-4000-8000-000000000718'),
  row(1, 0, 1)::text,
  'the all-zero merge stores exactly one transcription call'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select public.record_pipeline_run_provider_usage(
      '22220000-0000-4000-8000-000000000718'::uuid,
      '33330000-0000-4000-8000-000000000718'::uuid,
      '{"schemaVersion":1,"modelCalls":1,"inputTokens":0,"cachedInputTokens":0,"outputTokens":0,"reasoningTokens":0,"models":[],"transcriptions":[{"role":"sellerContext","provider":"openai","model":"gpt-4o-mini-transcribe","calls":1,"chargedUsd":null}],"soldComps":[]}'::jsonb
    )),
  true,
  'the all-zero late receipt replays idempotently'
);
reset role;

select is(
  (select row(model_calls, jsonb_array_length(transcriptions))::text
   from public.pipeline_run_provider_usage
   where run_id = '22220000-0000-4000-8000-000000000718'),
  row(1, 1)::text,
  'the all-zero exact replay does not double the receipt'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select extensions.throws_ok(
  $$select public.record_pipeline_run_provider_usage(
      '22220000-0000-4000-8000-000000000718'::uuid,
      '33330000-0000-4000-8000-000000000718'::uuid,
      '{"schemaVersion":1,"modelCalls":1,"inputTokens":0,"cachedInputTokens":0,"outputTokens":0,"reasoningTokens":0,"models":[],"transcriptions":[{"role":"sellerContext","provider":"openai","model":"different-transcription-model","calls":1,"chargedUsd":null}],"soldComps":[]}'::jsonb
    )$$,
  '55000',
  'Provider usage conflicts with the durable run receipt',
  'a different late receipt conflicts with the all-zero old-worker row'
);
reset role;

select is(
  (select row(model_calls, transcriptions->0->>'model')::text
   from public.pipeline_run_provider_usage
   where run_id = '22220000-0000-4000-8000-000000000718'),
  row(1, 'gpt-4o-mini-transcribe')::text,
  'the all-zero conflict leaves the accepted receipt unchanged'
);

-- ---------------------------------------------------------------------------
-- Issue #724: the post-completion correction writer.
--
-- A guided correction runs the pricing router and the listing generator AFTER
-- its run completed, so it holds no lease and the run is no longer `running`.
-- Its authority is instead the guided-correction capability that has ALREADY
-- committed the correction, and the tenant, the item, and the target run are
-- read off that stored capability rather than accepted from the caller.
--
-- Fixtures: a capability chain per tenant. A reservation is unique per pipeline
-- run and must own one, so each capability gets its own carrier run. Those runs
-- are foreign-key ballast: the corrected run is named by expected_run_id, and
-- the writer never reads a reservation's own run.
-- ---------------------------------------------------------------------------

insert into public.pipeline_runs (
  id, user_id, item_id, status, stage, idempotency_key,
  attempt_count, started_at, last_attempted_at, lease_token, lease_expires_at
)
select
  carrier.run_id,
  carrier.user_id,
  carrier.item_id,
  'running',
  'generating',
  carrier.idempotency_key,
  1,
  statement_timestamp(),
  statement_timestamp(),
  carrier.lease_token,
  statement_timestamp() + interval '5 minutes'
from (values
  ('2222aaaa-0000-4000-8000-000000000721'::uuid, 'user_pgtap_716_a',
   '11110000-0000-4000-8000-000000000716'::uuid, 'cost-724-a1',
   '3333aaaa-0000-4000-8000-000000000721'::uuid),
  ('2222aaaa-0000-4000-8000-000000000722'::uuid, 'user_pgtap_716_a',
   '11110000-0000-4000-8000-000000000716'::uuid, 'cost-724-a2',
   '3333aaaa-0000-4000-8000-000000000722'::uuid),
  ('2222aaaa-0000-4000-8000-000000000723'::uuid, 'user_pgtap_716_a',
   '11110000-0000-4000-8000-000000000716'::uuid, 'cost-724-a3',
   '3333aaaa-0000-4000-8000-000000000723'::uuid),
  ('2222aaaa-0000-4000-8000-000000000724'::uuid, 'user_pgtap_716_a',
   '11110000-0000-4000-8000-000000000716'::uuid, 'cost-724-a4',
   '3333aaaa-0000-4000-8000-000000000724'::uuid),
  ('2222aaaa-0000-4000-8000-000000000725'::uuid, 'user_pgtap_716_a',
   '11110000-0000-4000-8000-000000000716'::uuid, 'cost-724-a5',
   '3333aaaa-0000-4000-8000-000000000725'::uuid),
  ('2222aaaa-0000-4000-8000-000000000726'::uuid, 'user_pgtap_716_a',
   '11110000-0000-4000-8000-000000000716'::uuid, 'cost-724-a6',
   '3333aaaa-0000-4000-8000-000000000726'::uuid),
  ('2222bbbb-0000-4000-8000-000000000727'::uuid, 'user_pgtap_716_b',
   '11110000-0000-4000-8000-000000000717'::uuid, 'cost-724-b1',
   '3333bbbb-0000-4000-8000-000000000727'::uuid)
) as carrier(run_id, user_id, item_id, idempotency_key, lease_token);

insert into public.listings (
  id, user_id, item_id, platform, title, description, copy, status,
  run_id, source_review_revision
) values
  ('77770000-0000-4000-8000-000000000716', 'user_pgtap_716_a',
   '11110000-0000-4000-8000-000000000716', 'ebay', 'Corrected fixture',
   'Corrected fixture listing.', '{}'::jsonb, 'draft',
   '22220000-0000-4000-8000-000000000716',
   '88880000-0000-4000-8000-000000000716'),
  ('77770000-0000-4000-8000-000000000717', 'user_pgtap_716_b',
   '11110000-0000-4000-8000-000000000717', 'ebay', 'Other tenant fixture',
   'Other tenant fixture listing.', '{}'::jsonb, 'draft',
   '22220000-0000-4000-8000-000000000717',
   '88880000-0000-4000-8000-000000000717');

insert into public.ai_item_allowance_periods (
  id, user_id, source, period_key, period_start, expires_date, state, allowance
) values
  ('78780000-0000-4000-8000-000000000716', 'user_pgtap_716_a',
   'included', 'included-first-run', '-infinity', 'infinity', 'active', 1),
  ('78780000-0000-4000-8000-000000000717', 'user_pgtap_716_b',
   'included', 'included-first-run', '-infinity', 'infinity', 'active', 1);

insert into public.ai_item_credit_reservations (
  id, user_id, pipeline_run_id, item_id, allowance_period_id, logical_run_key,
  photo_set_fingerprint, state
)
select
  fixture.reservation_id,
  fixture.user_id,
  fixture.carrier_run_id,
  fixture.item_id,
  fixture.period_id,
  fixture.logical_run_key,
  encode(sha256(convert_to(fixture.logical_run_key, 'UTF8')), 'hex'),
  'reserved'
from (values
  ('79790000-0000-4000-8000-000000000721'::uuid, 'user_pgtap_716_a',
   '2222aaaa-0000-4000-8000-000000000721'::uuid,
   '11110000-0000-4000-8000-000000000716'::uuid,
   '78780000-0000-4000-8000-000000000716'::uuid, 'cost-724-a1'),
  ('79790000-0000-4000-8000-000000000722'::uuid, 'user_pgtap_716_a',
   '2222aaaa-0000-4000-8000-000000000722'::uuid,
   '11110000-0000-4000-8000-000000000716'::uuid,
   '78780000-0000-4000-8000-000000000716'::uuid, 'cost-724-a2'),
  ('79790000-0000-4000-8000-000000000723'::uuid, 'user_pgtap_716_a',
   '2222aaaa-0000-4000-8000-000000000723'::uuid,
   '11110000-0000-4000-8000-000000000716'::uuid,
   '78780000-0000-4000-8000-000000000716'::uuid, 'cost-724-a3'),
  ('79790000-0000-4000-8000-000000000724'::uuid, 'user_pgtap_716_a',
   '2222aaaa-0000-4000-8000-000000000724'::uuid,
   '11110000-0000-4000-8000-000000000716'::uuid,
   '78780000-0000-4000-8000-000000000716'::uuid, 'cost-724-a4'),
  ('79790000-0000-4000-8000-000000000725'::uuid, 'user_pgtap_716_a',
   '2222aaaa-0000-4000-8000-000000000725'::uuid,
   '11110000-0000-4000-8000-000000000716'::uuid,
   '78780000-0000-4000-8000-000000000716'::uuid, 'cost-724-a5'),
  ('79790000-0000-4000-8000-000000000726'::uuid, 'user_pgtap_716_a',
   '2222aaaa-0000-4000-8000-000000000726'::uuid,
   '11110000-0000-4000-8000-000000000716'::uuid,
   '78780000-0000-4000-8000-000000000716'::uuid, 'cost-724-a6'),
  ('79790000-0000-4000-8000-000000000727'::uuid, 'user_pgtap_716_b',
   '2222bbbb-0000-4000-8000-000000000727'::uuid,
   '11110000-0000-4000-8000-000000000717'::uuid,
   '78780000-0000-4000-8000-000000000717'::uuid, 'cost-724-b1')
) as fixture(
  reservation_id, user_id, carrier_run_id, item_id, period_id, logical_run_key
);

-- The tokens themselves never reach the database: only their hash is stored,
-- exactly as the correction paths present them.
insert into private.guided_correction_completion_capabilities (
  reservation_id, token_hash, user_id, item_id, listing_id,
  completion_run_id, expected_run_id, expected_review_revision,
  created_at, expires_at, consumed_at
)
select
  fixture.reservation_id,
  encode(sha256(convert_to(fixture.token, 'UTF8')), 'hex'),
  fixture.user_id,
  fixture.item_id,
  fixture.listing_id,
  fixture.completion_run_id,
  fixture.expected_run_id,
  fixture.review_revision,
  fixture.created_at,
  fixture.created_at + interval '5 minutes',
  fixture.consumed_at
from (values
  -- The correction that committed and may report what it spent.
  ('79790000-0000-4000-8000-000000000721'::uuid, rpad('c724a1', 43, 'x'),
   'user_pgtap_716_a', '11110000-0000-4000-8000-000000000716'::uuid,
   '77770000-0000-4000-8000-000000000716'::uuid,
   '7a7a0000-0000-4000-8000-000000000721'::uuid,
   '22220000-0000-4000-8000-000000000716'::uuid,
   '88880000-0000-4000-8000-000000000716'::uuid,
   statement_timestamp(), statement_timestamp()),
  -- A second correction on the same run, on its own capability.
  ('79790000-0000-4000-8000-000000000722'::uuid, rpad('c724a2', 43, 'x'),
   'user_pgtap_716_a', '11110000-0000-4000-8000-000000000716'::uuid,
   '77770000-0000-4000-8000-000000000716'::uuid,
   '7a7a0000-0000-4000-8000-000000000722'::uuid,
   '22220000-0000-4000-8000-000000000716'::uuid,
   '88880000-0000-4000-8000-000000000716'::uuid,
   statement_timestamp(), statement_timestamp()),
  -- Authorized but never committed: no correction happened, so no spend may be
  -- attributed to one.
  ('79790000-0000-4000-8000-000000000723'::uuid, rpad('c724a3', 43, 'x'),
   'user_pgtap_716_a', '11110000-0000-4000-8000-000000000716'::uuid,
   '77770000-0000-4000-8000-000000000716'::uuid,
   '7a7a0000-0000-4000-8000-000000000723'::uuid,
   '22220000-0000-4000-8000-000000000716'::uuid,
   '88880000-0000-4000-8000-000000000716'::uuid,
   statement_timestamp(), null),
  -- Committed long enough ago that the write window has closed.
  ('79790000-0000-4000-8000-000000000724'::uuid, rpad('c724a4', 43, 'x'),
   'user_pgtap_716_a', '11110000-0000-4000-8000-000000000716'::uuid,
   '77770000-0000-4000-8000-000000000716'::uuid,
   '7a7a0000-0000-4000-8000-000000000724'::uuid,
   '22220000-0000-4000-8000-000000000716'::uuid,
   '88880000-0000-4000-8000-000000000716'::uuid,
   statement_timestamp() - interval '30 minutes',
   statement_timestamp() - interval '30 minutes'),
  -- A correction on a listing that carried no originating run.
  ('79790000-0000-4000-8000-000000000725'::uuid, rpad('c724a5', 43, 'x'),
   'user_pgtap_716_a', '11110000-0000-4000-8000-000000000716'::uuid,
   '77770000-0000-4000-8000-000000000716'::uuid,
   '7a7a0000-0000-4000-8000-000000000725'::uuid,
   null,
   '88880000-0000-4000-8000-000000000716'::uuid,
   statement_timestamp(), statement_timestamp()),
  -- A correction whose originating run never recorded provider usage.
  ('79790000-0000-4000-8000-000000000726'::uuid, rpad('c724a6', 43, 'x'),
   'user_pgtap_716_a', '11110000-0000-4000-8000-000000000716'::uuid,
   '77770000-0000-4000-8000-000000000716'::uuid,
   '7a7a0000-0000-4000-8000-000000000726'::uuid,
   '2222ffff-0000-4000-8000-000000000724'::uuid,
   '88880000-0000-4000-8000-000000000716'::uuid,
   statement_timestamp(), statement_timestamp()),
  -- The hostile case: a real, fully consumed capability belonging to the OTHER
  -- tenant, pointed at this tenant's run. `expected_run_id` carries no foreign
  -- key, so naming a foreign run is possible; landing on it must not be.
  ('79790000-0000-4000-8000-000000000727'::uuid, rpad('c724b1', 43, 'x'),
   'user_pgtap_716_b', '11110000-0000-4000-8000-000000000717'::uuid,
   '77770000-0000-4000-8000-000000000717'::uuid,
   '7a7a0000-0000-4000-8000-000000000727'::uuid,
   '22220000-0000-4000-8000-000000000716'::uuid,
   '88880000-0000-4000-8000-000000000717'::uuid,
   statement_timestamp(), statement_timestamp())
) as fixture(
  reservation_id, token, user_id, item_id, listing_id, completion_run_id,
  expected_run_id, review_revision, created_at, consumed_at
);

-- The new privilege is execute on one function, and nothing else. #716's
-- revocation of every direct write on the cost table is asserted above and is
-- deliberately not relaxed here.
select ok(
  not has_function_privilege(
    'authenticated',
    'public.record_guided_correction_provider_usage(text, jsonb)',
    'execute'
  ),
  'a seller cannot invoke the post-completion cost writer'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.record_guided_correction_provider_usage(text, jsonb)',
    'execute'
  ),
  'an anonymous caller cannot invoke the post-completion cost writer'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.record_guided_correction_provider_usage(text, jsonb)',
    'execute'
  ),
  'the correction path reaches its cost writer through the worker identity'
);

set local role service_role;

select set_config(
  'request.jwt.claims',
  '{"sub":"user_pgtap_716_a","role":"authenticated"}',
  true
);
select extensions.throws_ok(
  format(
    $$select public.record_guided_correction_provider_usage(%L, %L::jsonb)$$,
    rpad('c724a1', 43, 'x'),
    '{"schemaVersion":1,"modelCalls":1,"inputTokens":10,"cachedInputTokens":0,"outputTokens":2,"reasoningTokens":0,"models":[],"transcriptions":[],"soldComps":[]}'
  ),
  '42501',
  'Guided correction completion authorization is required',
  'a non-worker claim cannot record correction cost'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select extensions.throws_ok(
  format(
    $$select public.record_guided_correction_provider_usage(%L, %L::jsonb)$$,
    'not-a-capability-token',
    '{"schemaVersion":1,"modelCalls":1,"inputTokens":10,"cachedInputTokens":0,"outputTokens":2,"reasoningTokens":0,"models":[],"transcriptions":[],"soldComps":[]}'
  ),
  '22023',
  'Invalid provider usage record',
  'a malformed capability token is refused before any lookup'
);

select extensions.throws_ok(
  format(
    $$select public.record_guided_correction_provider_usage(%L, %L::jsonb)$$,
    rpad('c724a1', 43, 'x'),
    '{"schemaVersion":1,"modelCalls":1,"inputTokens":10,"cachedInputTokens":0,"outputTokens":2,"reasoningTokens":0,"models":[],"transcriptions":[],"soldComps":[],"prompt":"Grandmother 1968 Seiko"}'
  ),
  '22023',
  'Invalid provider usage record',
  'a correction payload carrying an unnamed key is refused rather than stored'
);

-- A correction never transcribes: the voice context was captured during the
-- original run, under the worker's lease.
select extensions.throws_ok(
  format(
    $$select public.record_guided_correction_provider_usage(%L, %L::jsonb)$$,
    rpad('c724a1', 43, 'x'),
    '{"schemaVersion":1,"modelCalls":1,"inputTokens":10,"cachedInputTokens":0,"outputTokens":2,"reasoningTokens":0,"models":[],"transcriptions":[{"role":"sellerContext","provider":"openai","model":"gpt-4o-mini-transcribe","calls":1,"chargedUsd":null}],"soldComps":[]}'
  ),
  '22023',
  'Invalid provider usage record',
  'a correction cannot claim a transcription it could not have made'
);

select extensions.throws_ok(
  format(
    $$select public.record_guided_correction_provider_usage(%L, %L::jsonb)$$,
    rpad('c724zz', 43, 'x'),
    '{"schemaVersion":1,"modelCalls":1,"inputTokens":10,"cachedInputTokens":0,"outputTokens":2,"reasoningTokens":0,"models":[],"transcriptions":[],"soldComps":[]}'
  ),
  'P0001',
  'Guided correction capability is unavailable',
  'a token no capability hashes to writes nothing'
);

select extensions.throws_ok(
  format(
    $$select public.record_guided_correction_provider_usage(%L, %L::jsonb)$$,
    rpad('c724a3', 43, 'x'),
    '{"schemaVersion":1,"modelCalls":1,"inputTokens":10,"cachedInputTokens":0,"outputTokens":2,"reasoningTokens":0,"models":[],"transcriptions":[],"soldComps":[]}'
  ),
  'P0001',
  'Guided correction capability is unavailable',
  'a capability that never committed a correction cannot record a cost'
);

select extensions.throws_ok(
  format(
    $$select public.record_guided_correction_provider_usage(%L, %L::jsonb)$$,
    rpad('c724a4', 43, 'x'),
    '{"schemaVersion":1,"modelCalls":1,"inputTokens":10,"cachedInputTokens":0,"outputTokens":2,"reasoningTokens":0,"models":[],"transcriptions":[],"soldComps":[]}'
  ),
  'P0001',
  'Guided correction capability is unavailable',
  'a consumed capability stops being a write key once its window closes'
);

select is(
  (select public.record_guided_correction_provider_usage(
      rpad('c724a5', 43, 'x'),
      '{"schemaVersion":1,"modelCalls":1,"inputTokens":10,"cachedInputTokens":0,"outputTokens":2,"reasoningTokens":0,"models":[],"transcriptions":[],"soldComps":[]}'::jsonb
    )),
  false,
  'a correction with no originating run reports that nothing was attributed'
);

select is(
  (select public.record_guided_correction_provider_usage(
      rpad('c724a6', 43, 'x'),
      '{"schemaVersion":1,"modelCalls":1,"inputTokens":10,"cachedInputTokens":0,"outputTokens":2,"reasoningTokens":0,"models":[],"transcriptions":[],"soldComps":[]}'::jsonb
    )),
  false,
  'a correction whose run recorded no usage has nothing to top up'
);

-- ---------------------------------------------------------------------------
-- Tenant isolation for the correction path. The capability is genuine and
-- consumed; only its target belongs to someone else.
-- ---------------------------------------------------------------------------

select is(
  (select public.record_guided_correction_provider_usage(
      rpad('c724b1', 43, 'x'),
      '{"schemaVersion":1,"modelCalls":9,"inputTokens":900000,"cachedInputTokens":0,"outputTokens":90000,"reasoningTokens":0,"models":[],"transcriptions":[],"soldComps":[]}'::jsonb
    )),
  false,
  'a correction cannot record usage onto another tenant''s run'
);
reset role;

select is(
  (select row(
      model_calls, input_tokens, correction_count,
      initial_usage is null, corrected_at is null
    )::text
   from public.pipeline_run_provider_usage
   where run_id = '22220000-0000-4000-8000-000000000716'),
  row(3, 3000::bigint, 0, true, true)::text,
  'the cross-tenant attempt left the target run untouched'
);

select is(
  (select provider_usage_recorded_at is null
   from private.guided_correction_completion_capabilities
   where reservation_id = '79790000-0000-4000-8000-000000000727'),
  true,
  'a refused cross-tenant report is not marked as recorded'
);

-- ---------------------------------------------------------------------------
-- The correction lands: the run total widens, and the split stays recoverable.
-- ---------------------------------------------------------------------------

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select public.record_guided_correction_provider_usage(
      rpad('c724a1', 43, 'x'),
      '{"schemaVersion":1,"modelCalls":2,"inputTokens":1500,"cachedInputTokens":100,"outputTokens":300,"reasoningTokens":20,"models":[{"role":"listing","provider":"openai","model":"resolved-listing","calls":1,"inputTokens":900,"cachedInputTokens":100,"outputTokens":200,"reasoningTokens":20},{"role":"pricingAgent","provider":"openai","model":"resolved-pricing","calls":1,"inputTokens":600,"cachedInputTokens":0,"outputTokens":100,"reasoningTokens":0}],"transcriptions":[],"soldComps":[{"strategy":"apify","attempts":1,"results":7,"chargedUsd":0.0153}]}'::jsonb
    )),
  true,
  'a committed correction records what it spent against its own run'
);
reset role;

select is(
  (select row(
      model_calls, input_tokens, cached_input_tokens,
      output_tokens, reasoning_tokens
    )::text
   from public.pipeline_run_provider_usage
   where run_id = '22220000-0000-4000-8000-000000000716'),
  row(5, 4500::bigint, 740::bigint, 700::bigint, 84::bigint)::text,
  'the run total is the initial analysis plus the correction (ADR-0008)'
);

select is(
  (select row(sold_comp_attempts, sold_comp_results, sold_comp_charged_usd)::text
   from public.pipeline_run_provider_usage
   where run_id = '22220000-0000-4000-8000-000000000716'),
  row(2, 16, 0.040000::numeric(12,6))::text,
  'the correction''s sold-comp attempts and charge join the run total'
);

-- A corrected run must stay one entry per (role, provider, model), or it would
-- drift past the entry bounds the table enforces and stop diffing cleanly
-- against an uncorrected run.
select is(
  (select row(
      jsonb_array_length(models),
      (select entry->>'calls' from jsonb_array_elements(models) entry
        where entry->>'role' = 'listing'),
      (select entry->>'inputTokens' from jsonb_array_elements(models) entry
        where entry->>'role' = 'listing')
    )::text
   from public.pipeline_run_provider_usage
   where run_id = '22220000-0000-4000-8000-000000000716'),
  row(3, '2', '1900')::text,
  'a repeated model role merges into one entry rather than appending'
);

select is(
  (select row(
      jsonb_array_length(sold_comps),
      sold_comps->0->>'strategy',
      sold_comps->0->>'attempts',
      sold_comps->0->>'results'
    )::text
   from public.pipeline_run_provider_usage
   where run_id = '22220000-0000-4000-8000-000000000716'),
  row(1, 'apify', '2', '16')::text,
  'a repeated sold-comp strategy merges into one entry'
);

select is(
  (select row(
      jsonb_array_length(transcriptions),
      transcriptions->0->>'model'
    )::text
   from public.pipeline_run_provider_usage
   where run_id = '22220000-0000-4000-8000-000000000716'),
  row(1, 'gpt-4o-mini-transcribe')::text,
  'the run''s transcription receipt is preserved through a correction'
);

-- The split (#724 AC4). The correction is never silently summed away: the
-- pre-correction measurement is snapshotted verbatim on the first top-up.
select is(
  (select row(
      initial_usage->>'modelCalls',
      initial_usage->>'inputTokens',
      initial_usage->>'soldCompResults',
      (initial_usage->>'soldCompChargedUsd')::numeric,
      jsonb_array_length(initial_usage->'models')
    )::text
   from public.pipeline_run_provider_usage
   where run_id = '22220000-0000-4000-8000-000000000716'),
  row('3', '3000', '9', 0.024700::numeric, 2)::text,
  'initial_usage preserves the pre-correction measurement verbatim'
);

select is(
  (select row(
      model_calls - (initial_usage->>'modelCalls')::integer,
      input_tokens - (initial_usage->>'inputTokens')::bigint,
      sold_comp_charged_usd - (initial_usage->>'soldCompChargedUsd')::numeric
    )::text
   from public.pipeline_run_provider_usage
   where run_id = '22220000-0000-4000-8000-000000000716'),
  row(2, 1500::bigint, 0.015300::numeric)::text,
  'a reader recovers the correction as the total minus the initial measurement'
);

select is(
  (select row(correction_count, corrected_at is not null)::text
   from public.pipeline_run_provider_usage
   where run_id = '22220000-0000-4000-8000-000000000716'),
  row(1, true)::text,
  'the row records that exactly one correction was folded in'
);

select is(
  (select provider_usage_recorded_at is not null
   from private.guided_correction_completion_capabilities
   where reservation_id = '79790000-0000-4000-8000-000000000721'),
  true,
  'the capability is marked once its correction cost has landed'
);

-- A redelivered report is answered rather than added again, for the same reason
-- the running path refuses to double a run's measured cost.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select public.record_guided_correction_provider_usage(
      rpad('c724a1', 43, 'x'),
      '{"schemaVersion":1,"modelCalls":2,"inputTokens":1500,"cachedInputTokens":100,"outputTokens":300,"reasoningTokens":20,"models":[{"role":"listing","provider":"openai","model":"resolved-listing","calls":1,"inputTokens":900,"cachedInputTokens":100,"outputTokens":200,"reasoningTokens":20},{"role":"pricingAgent","provider":"openai","model":"resolved-pricing","calls":1,"inputTokens":600,"cachedInputTokens":0,"outputTokens":100,"reasoningTokens":0}],"transcriptions":[],"soldComps":[{"strategy":"apify","attempts":1,"results":7,"chargedUsd":0.0153}]}'::jsonb
    )),
  true,
  'a redelivered correction report reports durable success'
);
reset role;

select is(
  (select row(model_calls, input_tokens, correction_count)::text
   from public.pipeline_run_provider_usage
   where run_id = '22220000-0000-4000-8000-000000000716'),
  row(5, 4500::bigint, 1)::text,
  'the redelivery did not double the correction'
);

-- A second correction tops up a row whose initial measurement is already
-- preserved, so the snapshot must not move.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select public.record_guided_correction_provider_usage(
      rpad('c724a2', 43, 'x'),
      '{"schemaVersion":1,"modelCalls":1,"inputTokens":200,"cachedInputTokens":0,"outputTokens":40,"reasoningTokens":0,"models":[{"role":"listing","provider":"openai","model":"resolved-listing","calls":1,"inputTokens":200,"cachedInputTokens":0,"outputTokens":40,"reasoningTokens":0}],"transcriptions":[],"soldComps":[]}'::jsonb
    )),
  true,
  'a second correction on the same run is recorded on its own capability'
);
reset role;

select is(
  (select row(model_calls, input_tokens, correction_count)::text
   from public.pipeline_run_provider_usage
   where run_id = '22220000-0000-4000-8000-000000000716'),
  row(6, 4700::bigint, 2)::text,
  'the second correction widens the run total and is counted'
);

select is(
  (select row(
      initial_usage->>'modelCalls',
      initial_usage->>'inputTokens'
    )::text
   from public.pipeline_run_provider_usage
   where run_id = '22220000-0000-4000-8000-000000000716'),
  row('3', '3000')::text,
  'the initial measurement still reads the same after a second correction'
);

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

-- ---------------------------------------------------------------------------
-- Account erasure coverage (#384). A tenant table erasure neither fences nor
-- counts is a table erasure reports completion over while its rows survive.
-- ---------------------------------------------------------------------------

select ok(
  exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'pipeline_run_provider_usage'
      and t.tgname = 'zzz_fence_account_erasure_tenant_mutation'
  ),
  'the cost table is fenced, so no write can land after erasure starts'
);

select ok(
  (
    select pg_get_functiondef(p.oid)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.proname = 'account_erasure_owned_row_count'
  ) like '%from public.pipeline_run_provider_usage%',
  'erasure counts the cost table, so leftover rows block completion'
);

select * from finish();
rollback;
