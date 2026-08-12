-- Issue #774: carry the already-accepted optional voice receipt through the
-- durable worker without widening its database or Storage authority.

-- The worker may see voice only when the handoff agrees with every identity on
-- the claimed run. The receipt remains private processing input metadata; raw
-- bytes and transcript content never enter the queue envelope.
create or replace function private.pipeline_worker_context_json(p_run_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'run', jsonb_build_object(
      'id', run.id,
      'user_id', run.user_id,
      'item_id', run.item_id,
      'listing_id', run.listing_id,
      'status', run.status,
      'stage', run.stage,
      'schema_version', run.schema_version,
      'attempt_count', run.attempt_count,
      'max_attempts', run.max_attempts,
      'autopilot_enabled', coalesce(
        (to_jsonb(run) #>> '{capture_input,autopilot_enabled}')::boolean,
        run.autopilot_enabled
      ),
      'checkpoint', run.checkpoint,
      'lease_token', run.lease_token,
      'lease_expires_at', run.lease_expires_at,
      'next_attempt_at', run.next_attempt_at,
      'recovery_id', run.recovery_id,
      'recovery_token_hash', run.recovery_token_hash
    ),
    'item', jsonb_build_object(
      'id', item.id,
      'user_id', item.user_id,
      'photos', item.photos,
      'photo_identity_kind', item.photo_identity_kind,
      'photo_identity_fingerprint', item.photo_identity_fingerprint,
      'attributes', item.attributes,
      'condition', item.condition,
      'cost_basis', item.cost_basis,
      'review_revision', item.review_revision,
      'review_content_revision', item.review_content_revision
    ),
    'voice', case
      when handoff.run_id is null then null
      else jsonb_build_object(
        'receipt', jsonb_build_object(
          'version', (handoff.receipt->>'version')::integer,
          'storagePath', handoff.receipt->>'storage_path',
          'contentSha256', handoff.receipt->>'content_sha256',
          'byteLength', (handoff.receipt->>'byte_length')::integer,
          'durationMs', (handoff.receipt->>'duration_ms')::integer,
          'locale', handoff.receipt->>'locale',
          'mediaType', handoff.receipt->>'media_type'
        )
      )
    end
  )
  from public.pipeline_runs run
  join public.items item
    on item.id = run.item_id
   and item.user_id = run.user_id
  left join private.mobile_item_submission_voice_handoffs handoff
    on handoff.run_id = run.id
   and handoff.user_id = run.user_id
   and handoff.item_id = run.item_id
   and handoff.state = 'accepted'
  where run.id = p_run_id;
$$;

revoke all on function private.pipeline_worker_context_json(uuid)
  from public, anon, authenticated, service_role;

-- Keep the local processing result separate from whether seller audio crossed
-- the hosted-provider boundary. Existing rows predate that distinction and are
-- conservatively treated as provider-contacted; the new worker always supplies
-- the explicit boolean.
alter table private.mobile_item_submission_voice_handoffs
  add column terminal_voice_outcome text,
  add column transcription_provider_contacted boolean;

update private.mobile_item_submission_voice_handoffs
set terminal_voice_outcome = transcription_outcome,
    transcription_provider_contacted = true
where transcription_outcome is not null;

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
  );

comment on column private.mobile_item_submission_voice_handoffs.terminal_voice_outcome is
  'Terminal local voice-processing outcome used for retry-safe cleanup, including outcomes reached before any provider contact.';
comment on column private.mobile_item_submission_voice_handoffs.transcription_provider_contacted is
  'Explicit provider-contact provenance. Account erasure discloses a hosted copy only when this is true.';

-- Retire the earlier unreleased three-argument candidate during exact local
-- replay as well as rolling worker upgrades. Fresh installs do not have it.
drop function if exists public.record_pipeline_run_voice_outcome(
  uuid, uuid, text
);

-- A terminal voice result is useful here only as a durable raw-audio deletion
-- trigger. Tenant identity comes from the still-live run lease and cannot be
-- asserted by the caller. The existing cleanup function remains the single
-- idempotent source of the handoff outcome and retryable cleanup job.
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

-- Structured seller voice remains useful for the lifetime of the retained item,
-- after the operational run checkpoint is pruned. Keep one private, typed row:
-- no raw audio, prompt, response body, or provider-private payload can fit here.
create table private.item_seller_voice_contexts (
  item_id uuid primary key,
  user_id text not null,
  transcript text not null,
  language text,
  provenance text not null default 'seller_voice',
  verification text not null default 'unverified',
  retained_at timestamptz not null default statement_timestamp(),

  constraint item_seller_voice_contexts_transcript_check check (
    octet_length(transcript) between 1 and 4096
  ),
  constraint item_seller_voice_contexts_language_check check (
    language is null or octet_length(language) between 1 and 255
  ),
  constraint item_seller_voice_contexts_provenance_check check (
    provenance = 'seller_voice'
  ),
  constraint item_seller_voice_contexts_verification_check check (
    verification = 'unverified'
  ),
  constraint item_seller_voice_contexts_item_owner_fkey
    foreign key (item_id, user_id)
    references public.items (id, user_id)
    on update cascade
    on delete cascade
);

alter table private.item_seller_voice_contexts enable row level security;
revoke all on table private.item_seller_voice_contexts
  from public, anon, authenticated, service_role;

create trigger zzz_fence_account_erasure_tenant_mutation
  before insert or update or delete on private.item_seller_voice_contexts
  for each row execute function private.fence_account_erasure_tenant_mutation();

-- Account erasure requires every tenant table to be both mutation-fenced and
-- included in its terminal residue proof. Rows normally cascade with items,
-- but the explicit count prevents erasure from reporting completion if that
-- cascade is ever blocked or weakened.
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
    union all select count(*)::integer from private.item_seller_voice_contexts where user_id = p_user_id
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

comment on table private.item_seller_voice_contexts is
  'One bounded structured seller-voice transcript/language authority retained with its tenant-owned item. No raw audio or provider payloads.';

create or replace function private.retain_pipeline_seller_context()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'succeeded'
    and old.status is distinct from new.status
    and new.checkpoint ? 'voice' then
    if new.checkpoint #>> '{voice,outcome}' = 'transcribed' then
      insert into private.item_seller_voice_contexts (
        item_id,
        user_id,
        transcript,
        language,
        provenance,
        verification
      ) values (
        new.item_id,
        new.user_id,
        new.checkpoint #>> '{voice,sellerContext,text}',
        new.checkpoint #>> '{voice,sellerContext,language}',
        new.checkpoint #>> '{voice,sellerContext,provenance}',
        new.checkpoint #>> '{voice,sellerContext,verification}'
      )
      on conflict (item_id) do update
      set user_id = excluded.user_id,
          transcript = excluded.transcript,
          language = excluded.language,
          provenance = excluded.provenance,
          verification = excluded.verification,
          retained_at = statement_timestamp();
    else
      delete from private.item_seller_voice_contexts context
      where context.item_id = new.item_id
        and context.user_id = new.user_id;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.retain_pipeline_seller_context()
  from public, anon, authenticated, service_role;

create trigger retain_pipeline_seller_context
after update of status on public.pipeline_runs
for each row execute function private.retain_pipeline_seller_context();

-- The transcription API reports neither token counts nor a billed charge. Keep
-- one aggregate routing/call receipt so the run is still cost-auditable without
-- fabricating zero usage or retaining any audio, transcript, or provider body.
alter table public.pipeline_run_provider_usage
  add column transcriptions jsonb not null default '[]'::jsonb;

alter table public.pipeline_run_provider_usage
  add constraint pipeline_run_provider_usage_transcriptions_check check (
    private.provider_usage_entries_coarse(
      transcriptions,
      array['role', 'provider', 'model', 'calls', 'chargedUsd'],
      16
    )
  );

comment on column public.pipeline_run_provider_usage.transcriptions is
  'Aggregate transcription role/provider/model/call receipts only. chargedUsd is null when the provider reports no charge; never audio, transcript, or provider payloads.';

-- Validate the JSON scalar before converting it. The length/shape gate makes
-- the numeric conversion unreachable for seller text or an oversized scalar,
-- so every rejected payload uses the fixed content-free RPC error below.
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
