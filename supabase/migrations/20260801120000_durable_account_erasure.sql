-- Issue #384: durable, resumable, tenant-isolated account erasure.
--
-- Shape
-- -----
-- `begin_account_erasure` commits one generation per tenant and freezes the
-- private Storage manifest. `advance_account_erasure` reconciles credits, drops
-- every SnapList-owned tenant row, and reports the provider identity work that
-- Postgres cannot perform. `finalize_account_erasure` re-proves zero owned
-- residue, records the caller's verified provider absence, and only then writes
-- a terminal status. External provider calls stay outside Postgres.
--
-- Status vocabulary (hub-approved, do not collapse)
-- -------------------------------------------------
--   deletion_requested
--   deletion_in_progress
--   deletion_completed
--   deletion_completed_with_retained_records
--   deletion_needs_attention
--
-- `deletion_completed_with_retained_records` is a success state, not a partial
-- failure. It is written when something survives that SnapList does not own and
-- never claims to delete: the OpenAI-held transcription copy
-- (`hosted-transcription-provider-copy` is `provider-owned` in
-- docs/contracts/lean-mvp-retention-v1.json) and the live eBay listing, which
-- stays eBay's record because erasure never ends listings. Reporting a flat
-- `deletion_completed` in those cases would contradict ADR-0012.
--
-- Advisory lock order
-- -------------------
-- Migration 20260731030000 fixes the transaction-wide order: snaplist:pipeline-
-- retention, then pipeline-daily / pipeline-minute, then ai-item-credit:<seller>,
-- then trophy-run-order:<seller>. `account-erasure:<seller>` is appended to the
-- END of that order, so this migration:
--   * acquires snaplist:pipeline-retention and ai-item-credit:<seller> before
--     account-erasure:<seller> inside `advance_account_erasure`;
--   * never acquires trophy-run-order, because the only trigger that takes it
--     fires on INSERT/UPDATE of public.pipeline_runs and erasure only deletes.
-- The fence itself takes no advisory lock in any branch — it is one indexed
-- digest lookup — so it cannot participate in that order at all and cannot
-- serialize traffic for tenants who are not being erased. The `zzz_` trigger
-- name is still deliberate: firing after every other BEFORE row trigger means a
-- mutation is rejected only once the triggers that would have taken seller
-- locks have already run, so the fence never changes which locks a rejected
-- statement had acquired.
--
-- Fencing is a committed-row check, not a lock handshake: a mutation that read
-- its fence before `begin` committed may still land afterwards. `advance` and
-- `finalize` each re-prove zero owned residue, and no NEW work can start once
-- the row is committed, so such a write is deleted on the next attempt instead
-- of surviving into a completion claim.
--
-- Deliberately out of scope: private.app_attest_challenges and
-- private.app_attest_keys. They carry no tenant column, and the retention
-- contract names the App Attest retention capability, not this one, as their
-- executor.

create function private.account_erasure_user_digest(p_user_id text)
returns bytea
language sql
immutable
security definer
set search_path = ''
as $$
  select extensions.digest('snaplist:account-erasure:v1:' || p_user_id, 'sha256')
$$;

comment on function private.account_erasure_user_digest(text) is
  'Keyed lookup for an erased tenant. A Clerk user id carries enough entropy '
  'that a SHA-256 digest is not recoverable by enumeration, so the terminal '
  'receipt can still fence and answer replays without retaining the raw id.';

revoke all on function private.account_erasure_user_digest(text)
  from public, anon, authenticated, service_role;

-- One generation per tenant, forever. While erasure runs the row also carries
-- the raw working identifiers the deletion needs; every one of them is scrubbed
-- when a completed status is written, leaving a keyed fence/replay receipt.
create table private.account_erasure_generations (
  generation_id uuid primary key default gen_random_uuid(),
  user_id_digest bytea not null unique,
  idempotency_key_digest bytea not null,
  status text not null default 'deletion_requested',
  retained_records text[] not null default '{}'::text[],
  deferrals text[] not null default '{}'::text[],
  attention_reasons text[] not null default '{}'::text[],
  user_id text,
  idempotency_key uuid,
  clerk_user_id text,
  revenuecat_app_user_ids text[] not null default '{}'::text[],
  started_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz,
  constraint account_erasure_generations_user_shape
    check (user_id is null or user_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  constraint account_erasure_generations_status
    check (status in (
      'deletion_requested',
      'deletion_in_progress',
      'deletion_completed',
      'deletion_completed_with_retained_records',
      'deletion_needs_attention'
    )),
  constraint account_erasure_generations_completion
    check (
      (status in ('deletion_completed', 'deletion_completed_with_retained_records'))
      = (completed_at is not null)
    ),
  -- A completed erasure keeps no raw identifier of the account it erased.
  constraint account_erasure_generations_scrubbed
    check (
      status not in ('deletion_completed', 'deletion_completed_with_retained_records')
      or (
        user_id is null
        and idempotency_key is null
        and clerk_user_id is null
        and cardinality(revenuecat_app_user_ids) = 0
        and cardinality(deferrals) = 0
      )
    ),
  -- Anything still working, or waiting on a person, keeps what it needs to resume.
  constraint account_erasure_generations_working_record
    check (
      status in ('deletion_completed', 'deletion_completed_with_retained_records')
      or (user_id is not null and idempotency_key is not null)
    ),
  constraint account_erasure_generations_retained_records
    check (retained_records <@ array[
      'hosted-transcription-provider-copy',
      'ebay-live-listing'
    ]::text[]),
  constraint account_erasure_generations_deferrals
    check (deferrals <@ array[
      'private-storage-objects-pending',
      'ebay-provider-authority-pending',
      'guest-claim-in-progress',
      'mixed-tenant-storage-cleanup'
    ]::text[]),
  constraint account_erasure_generations_attention_reasons
    check (
      attention_reasons <@ array[
        'clerk-identity-deletion-unverified',
        'revenuecat-customer-deletion-unverified',
        'deferral-window-exceeded'
      ]::text[]
      and (cardinality(attention_reasons) > 0) = (status = 'deletion_needs_attention')
    )
);

create table private.account_erasure_storage_manifest (
  generation_id uuid not null
    references private.account_erasure_generations(generation_id)
    on delete cascade,
  bucket_id text not null,
  object_name text not null,
  selected_at timestamptz not null default statement_timestamp(),
  verified_absent_at timestamptz,
  primary key (generation_id, bucket_id, object_name),
  constraint account_erasure_storage_manifest_path
    check (char_length(object_name) between 1 and 1024)
);

create index account_erasure_storage_pending_idx
  on private.account_erasure_storage_manifest (generation_id, bucket_id, object_name)
  where verified_absent_at is null;

create index account_erasure_generations_receipt_retention_idx
  on private.account_erasure_generations (completed_at)
  where completed_at is not null;

alter table private.account_erasure_generations enable row level security;
alter table private.account_erasure_generations force row level security;
alter table private.account_erasure_storage_manifest enable row level security;
alter table private.account_erasure_storage_manifest force row level security;

revoke all on table private.account_erasure_generations
  from public, anon, authenticated, service_role;
revoke all on table private.account_erasure_storage_manifest
  from public, anon, authenticated, service_role;

comment on table private.account_erasure_generations is
  'Issue #384: one erasure generation per tenant. Holds raw working identifiers '
  'only while erasure is unfinished; a completed row keeps digests, the terminal '
  'status, and retained-record categories so replay and the mutation fence stay '
  'truthful, and is pruned 30 days after completion.';
comment on table private.account_erasure_storage_manifest is
  'Issue #384 resumable private Storage selection. Completion requires verified '
  'catalog absence for every row, and the manifest is dropped with the terminal '
  'status.';

create function private.account_erasure_service_role_required()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Account erasure service authorization is required';
  end if;
end;
$$;

revoke all on function private.account_erasure_service_role_required()
  from public, anon, authenticated, service_role;

create function private.lock_account_erasure(p_user_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(char_length(p_user_id), 0) not between 1 and 255
    or p_user_id !~ '^[A-Za-z0-9_-]+$' then
    raise exception using errcode = '22023', message = 'Invalid account erasure tenant';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('account-erasure:' || p_user_id, 0)
  );
end;
$$;

revoke all on function private.lock_account_erasure(text)
  from public, anon, authenticated, service_role;

-- True when every field that differs between two versions of a row is named in
-- p_allowed. This is what stops a narrow provider exception from authorising an
-- arbitrary edit to the same row.
create function private.account_erasure_delta_confined(
  p_old jsonb,
  p_new jsonb,
  p_allowed text[]
)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $$
  select (p_old - p_allowed) = (p_new - p_allowed)
$$;

revoke all on function private.account_erasure_delta_confined(jsonb, jsonb, text[])
  from public, anon, authenticated, service_role;

create function private.assert_account_erasure_mutation_allowed(
  p_user_id text,
  p_allow_provider_completion boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(p_user_id, '') = '' then return; end if;
  if coalesce(auth.jwt()->>'role', '') = 'service_role'
    and current_setting('app.account_erasure_internal', true) = 'true' then
    return;
  end if;
  if p_allow_provider_completion then return; end if;
  if exists (
    select 1
    from private.account_erasure_generations generation
    where generation.user_id_digest = private.account_erasure_user_digest(p_user_id)
  ) then
    raise exception using
      errcode = '55000',
      message = 'Account erasure has started for this account';
  end if;
end;
$$;

revoke all on function private.assert_account_erasure_mutation_allowed(text, boolean)
  from public, anon, authenticated, service_role;

create function private.fence_account_erasure_tenant_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb := '{}'::jsonb;
  v_new jsonb := '{}'::jsonb;
  v_user_id text;
  v_context_free_exception boolean := false;
  v_provider_completion_row boolean := false;
  v_provider_user_id text := current_setting(
    'app.account_erasure_provider_completion_user_id', true
  );
  v_provider_resource_id text := current_setting(
    'app.account_erasure_provider_completion_resource_id', true
  );
  v_provider_operation text := current_setting(
    'app.account_erasure_provider_completion_operation', true
  );
begin
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;

  -- Two exceptions carry no provider-completion context, so each is pinned to an
  -- exact transition AND an exact allowed-field delta. Without the delta check a
  -- bare "publishing -> failed" predicate would authorise any other change to
  -- the same row in the same statement: price, title, item binding.
  v_context_free_exception :=
    (
      -- An in-flight publish recording its own terminal failure and releasing the
      -- claim it holds. Nothing else on the row may move.
      tg_table_schema = 'public'
      and tg_table_name = 'listings'
      and tg_op = 'UPDATE'
      and v_old->>'ebay_status' = 'publishing'
      and v_new->>'ebay_status' = 'failed'
      and v_old->>'ebay_publish_claim_id' is not null
      and v_new->>'ebay_publish_claim_id' is null
      and private.account_erasure_delta_confined(v_old, v_new, array[
        'ebay_status',
        'ebay_publish_claim_id',
        'ebay_publish_claimed_at',
        'ebay_publish_connection_generation',
        'ebay_publish_binding',
        'updated_at'
      ])
    )
    or (
      -- Releasing a dispatch lease. A delete only removes tenant data; an update
      -- may settle or shorten a lease but never extend one, because extending it
      -- would prolong provider work the seller has asked to end.
      tg_table_schema = 'private'
      and tg_table_name = 'ebay_provider_dispatch_leases'
      and (
        tg_op = 'DELETE'
        or (
          tg_op = 'UPDATE'
          and (v_new->>'expires_at')::timestamptz <= (v_old->>'expires_at')::timestamptz
          and private.account_erasure_delta_confined(v_old, v_new, array[
            'expires_at',
            'attempted_at',
            'attempt_token',
            'publish_claim_id',
            'publish_binding',
            'connection_generation'
          ])
        )
      )
    );

  -- These require the provider-completion context that
  -- private.assert_ebay_dispatch_completion sets only after proving a live,
  -- generation-matched lease for this exact tenant, resource, and operation.
  v_provider_completion_row :=
    (
      tg_table_schema = 'private'
      and tg_table_name = 'ebay_messaging_account_generations'
      and tg_op = 'INSERT'
    )
    or (
      v_provider_operation = 'publish'
      and tg_table_schema = 'public'
      and tg_table_name = 'listings'
      and tg_op = 'UPDATE'
      and v_old->>'id' = v_provider_resource_id
      and v_old->>'ebay_status' = 'publishing'
      and v_new->>'ebay_status' = 'published'
    )
    or (
      v_provider_operation = 'reprice'
      and tg_table_schema = 'public'
      and tg_table_name in ('reprice_suggestions', 'items', 'listings')
      and tg_op = 'UPDATE'
      and (
        (
          tg_table_name = 'reprice_suggestions'
          and v_old->>'listing_id' = v_provider_resource_id
        )
        or (
          tg_table_name = 'listings'
          and v_old->>'id' = v_provider_resource_id
        )
        or (
          tg_table_name = 'items'
          and exists (
            select 1
            from public.listings listing
            where listing.id::text = v_provider_resource_id
              and listing.user_id = v_provider_user_id
              and listing.item_id::text = v_old->>'id'
          )
        )
      )
    );

  for v_user_id in
    select distinct candidate.user_id
    from (
      values
        (v_old->>'user_id'),
        (v_new->>'user_id'),
        (v_old->>'guest_user_id'),
        (v_new->>'guest_user_id'),
        (v_old->>'claim_idempotency_user_id'),
        (v_new->>'claim_idempotency_user_id'),
        (v_old->>'claim_target_user_id'),
        (v_new->>'claim_target_user_id'),
        (split_part(coalesce(v_old->>'storage_path', ''), '/', 1)),
        (split_part(coalesce(v_new->>'storage_path', ''), '/', 1))
      union all
      select split_part(path.value, '/', 1)
      from jsonb_array_elements_text(
        coalesce(v_old->'photo_paths', '[]'::jsonb)
      ) path(value)
      union all
      select split_part(path.value, '/', 1)
      from jsonb_array_elements_text(
        coalesce(v_new->'photo_paths', '[]'::jsonb)
      ) path(value)
    ) candidate(user_id)
    where candidate.user_id ~ '^[A-Za-z0-9_-]{1,255}$'
    order by candidate.user_id
  loop
    perform private.assert_account_erasure_mutation_allowed(
      v_user_id,
      v_context_free_exception
        or (v_provider_completion_row and v_provider_user_id = v_user_id)
    );
  end loop;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.fence_account_erasure_tenant_mutation()
  from public, anon, authenticated, service_role;

create or replace function private.assert_ebay_dispatch_completion(
  p_user_id text,
  p_resource_id uuid,
  p_operation text,
  p_account_generation uuid,
  p_attempt_token uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account private.ebay_messaging_account_generations%rowtype;
begin
  -- Body unchanged from migration 20260723143000; the only addition is the
  -- transaction-scoped context below, so this migration does not reorder the
  -- account lock or weaken the seller_erased check.
  v_account := private.lock_ebay_messaging_account(p_user_id);
  if v_account.seller_erased
    or v_account.generation is distinct from p_account_generation then
    raise exception using
      errcode = '40001',
      message = 'eBay account generation changed before local completion';
  end if;

  perform 1
  from private.ebay_provider_dispatch_leases lease
  where lease.user_id = p_user_id
    and lease.message_id = p_resource_id
    and lease.dispatch_kind = p_operation
    and lease.account_generation = p_account_generation
    and lease.attempt_token = p_attempt_token
    and lease.expires_at > statement_timestamp()
  for update;
  if not found then
    raise exception using
      errcode = '40001',
      message = 'eBay provider dispatch lease expired before local completion';
  end if;

  -- Transaction-scoped, and read back by the erasure fence so a provider round
  -- trip proved above can still land its own result after erasure has begun.
  perform set_config(
    'app.account_erasure_provider_completion_user_id', p_user_id, true
  );
  perform set_config(
    'app.account_erasure_provider_completion_resource_id', p_resource_id::text, true
  );
  perform set_config(
    'app.account_erasure_provider_completion_operation', p_operation, true
  );
end;
$$;

revoke all on function private.assert_ebay_dispatch_completion(
  text, uuid, text, uuid, uuid
) from public, anon, authenticated, service_role;

-- `zzz_` is load-bearing: row triggers fire in name order, so this one runs
-- after every other BEFORE trigger and account-erasure:<seller> is therefore the
-- last seller-scoped lock any mutation path can take.
do $account_erasure_triggers$
declare
  v_table text;
begin
  foreach v_table in array array[
    'public.items',
    'public.listings',
    'public.export_handoffs',
    'public.messages',
    'public.embeddings',
    'public.prediction_logs',
    'public.user_settings',
    'public.ebay_connections',
    'public.subscriptions',
    'public.notifications',
    'public.reprice_suggestions',
    'public.ebay_message_sync_state',
    'public.ebay_unresolved_questions',
    'public.message_policy_decisions',
    'public.message_attachments',
    'public.billing_customers',
    'public.billing_checkout_reservations',
    'public.ai_item_allowance_periods',
    'public.ai_item_credit_reservations',
    'public.revenuecat_customer_bindings',
    'public.pipeline_runs',
    'public.pipeline_run_history_order_versions',
    'public.pricing_evidence_snapshots',
    'public.ebay_oauth_sessions',
    'private.ebay_messaging_account_generations',
    'private.ebay_seller_account_generations',
    'private.ebay_provider_dispatch_leases',
    'private.ebay_buyer_identity_provenance',
    'private.ebay_buyer_identity_observations',
    'private.ebay_erased_buyer_generation_tombstones',
    'private.ebay_sandbox_fallback_bindings',
    'private.ebay_unmappable_connection_quarantines',
    'private.ebay_seller_identity_tenants',
    'private.pipeline_run_usage_reservations',
    'private.pipeline_staging_cleanup_intents',
    'private.legacy_pipeline_usage_reservations',
    'private.mobile_item_submissions',
    'private.mobile_item_submission_voice_handoffs',
    'private.mobile_listing_review_saves',
    'private.mobile_run_operation_replays',
    'private.guided_correction_completion_capabilities',
    'private.verified_guest_capabilities',
    'private.storekit_ai_item_period_events',
    'private.revenuecat_webhook_events',
    'private.guest_draft_recoveries',
    'private.pipeline_storage_cleanup_jobs',
    'private.message_photo_object_deletion_queue'
  ] loop
    execute format(
      'create trigger zzz_fence_account_erasure_tenant_mutation '
        || 'before insert or update or delete on %s for each row '
        || 'execute function private.fence_account_erasure_tenant_mutation()',
      v_table::regclass
    );
  end loop;
end;
$account_erasure_triggers$;

create function private.fence_account_erasure_storage_object()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb := '{}'::jsonb;
  v_new jsonb := '{}'::jsonb;
  v_user_id text;
begin
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  for v_user_id in
    select distinct candidate.user_id
    from (
      values
        (case when v_old->>'bucket_id' in ('photos', 'message-photos')
          then split_part(coalesce(v_old->>'name', ''), '/', 1) end),
        (case when v_new->>'bucket_id' in ('photos', 'message-photos')
          then split_part(coalesce(v_new->>'name', ''), '/', 1) end)
    ) candidate(user_id)
    where candidate.user_id ~ '^[A-Za-z0-9_-]{1,255}$'
    order by candidate.user_id
  loop
    -- Removing an object only advances erasure, so a delete is always allowed.
    perform private.assert_account_erasure_mutation_allowed(
      v_user_id,
      tg_op = 'DELETE'
    );
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.fence_account_erasure_storage_object()
  from public, anon, authenticated, service_role;

create trigger zzz_fence_account_erasure_storage_object
before insert or update or delete on storage.objects
for each row execute function private.fence_account_erasure_storage_object();

create function private.account_erasure_payload(p_generation_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  select jsonb_build_object(
    'generation_id', generation.generation_id,
    'status', generation.status,
    'retained_records', to_jsonb(generation.retained_records),
    'deferrals', to_jsonb(generation.deferrals),
    'attention_reasons', to_jsonb(generation.attention_reasons),
    -- Absent identity is null, never an object with a null inside it. advance
    -- is what captures clerk_user_id, so every payload before it — including
    -- the one begin_account_erasure returns — would otherwise carry
    -- {"clerk_user_id": null}, which the client's schema rejects. That failure
    -- lands after the generation row has already committed and started
    -- fencing, so the account would be left unwritable and unerasable.
    'identity', case
      when generation.clerk_user_id is null then 'null'::jsonb
      else jsonb_build_object(
        'clerk_user_id', generation.clerk_user_id,
        'revenuecat_app_user_ids', to_jsonb(generation.revenuecat_app_user_ids)
      )
    end,
    'storage_objects', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'bucket_id', manifest.bucket_id,
          'object_name', manifest.object_name
        ) order by manifest.bucket_id, manifest.object_name
      )
      from private.account_erasure_storage_manifest manifest
      where manifest.generation_id = generation.generation_id
        and manifest.verified_absent_at is null
    ), '[]'::jsonb)
  )
  from private.account_erasure_generations generation
  where generation.generation_id = p_generation_id
$$;

revoke all on function private.account_erasure_payload(uuid)
  from public, anon, authenticated, service_role;

create function public.begin_account_erasure(
  p_user_id text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_generation private.account_erasure_generations%rowtype;
  v_digest bytea;
begin
  perform private.account_erasure_service_role_required();
  if p_idempotency_key is null then
    raise exception using
      errcode = '22023',
      message = 'Account erasure Idempotency-Key is required';
  end if;
  perform private.lock_account_erasure(p_user_id);
  v_digest := private.account_erasure_user_digest(p_user_id);

  -- A guest copy mid-flight owns rows in two tenants at once. Let it settle
  -- rather than racing it; the client retries with the same key.
  if exists (
    select 1
    from private.guest_draft_recoveries recovery
    where recovery.claim_target_user_id = p_user_id
      and recovery.state = 'copying'
  ) then
    raise exception using
      errcode = '55000',
      message = 'Guest claim must settle before account erasure starts';
  end if;

  select * into v_generation
  from private.account_erasure_generations generation
  where generation.user_id_digest = v_digest
  for update;

  if found and v_generation.idempotency_key_digest
    is distinct from extensions.digest(p_idempotency_key::text, 'sha256') then
    raise exception using
      errcode = '23505',
      message = 'Account erasure Idempotency-Key is already bound';
  end if;

  if not found then
    insert into private.account_erasure_generations (
      user_id_digest,
      idempotency_key_digest,
      user_id,
      idempotency_key
    )
    values (
      v_digest,
      extensions.digest(p_idempotency_key::text, 'sha256'),
      p_user_id,
      p_idempotency_key
    )
    returning * into v_generation;
  end if;

  -- A terminal replay answers with the generation it already resolved to.
  if v_generation.status in (
    'deletion_completed', 'deletion_completed_with_retained_records'
  ) then
    return private.account_erasure_payload(v_generation.generation_id);
  end if;

  insert into private.account_erasure_storage_manifest (
    generation_id,
    bucket_id,
    object_name
  )
  select v_generation.generation_id, object.bucket_id, object.name
  from storage.objects object
  where object.bucket_id in ('photos', 'message-photos')
    and split_part(object.name, '/', 1) = p_user_id
  on conflict (generation_id, bucket_id, object_name) do nothing;

  return private.account_erasure_payload(v_generation.generation_id);
end;
$$;

revoke all on function public.begin_account_erasure(text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_account_erasure(text, uuid)
  to service_role;

create function public.confirm_account_erasure_storage_absence(
  p_generation_id uuid,
  p_bucket_id text,
  p_object_name text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text;
begin
  perform private.account_erasure_service_role_required();
  select generation.user_id into v_user_id
  from private.account_erasure_generations generation
  where generation.generation_id = p_generation_id;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Account erasure generation not found';
  end if;
  perform private.lock_account_erasure(v_user_id);

  perform 1
  from private.account_erasure_storage_manifest manifest
  where manifest.generation_id = p_generation_id
    and manifest.bucket_id = p_bucket_id
    and manifest.object_name = p_object_name
  for update;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Account erasure Storage object is not in this manifest';
  end if;

  -- Verified absence, not a reported delete result: the catalog is the proof.
  if exists (
    select 1 from storage.objects object
    where object.bucket_id = p_bucket_id and object.name = p_object_name
  ) then
    raise exception using
      errcode = '55000',
      message = 'Account erasure Storage object still exists';
  end if;

  update private.account_erasure_storage_manifest
  set verified_absent_at = coalesce(verified_absent_at, statement_timestamp())
  where generation_id = p_generation_id
    and bucket_id = p_bucket_id
    and object_name = p_object_name;
  return true;
end;
$$;

revoke all on function public.confirm_account_erasure_storage_absence(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.confirm_account_erasure_storage_absence(uuid, text, text)
  to service_role;

-- The completion proof. Every table the fence covers is counted here, so a new
-- tenant table cannot be fenced but left behind, or deleted but left unfenced,
-- without src/lib/account-erasure/fence-coverage.rls.test.ts failing.
create function private.account_erasure_owned_row_count(p_user_id text)
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
    union all select count(*)::integer from public.pipeline_run_history_order_versions where user_id = p_user_id
    union all select count(*)::integer from public.pricing_evidence_snapshots where user_id = p_user_id
    union all select count(*)::integer from public.ebay_oauth_sessions where user_id = p_user_id
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
    union all select count(*)::integer from private.mobile_run_operation_replays where user_id = p_user_id
    union all select count(*)::integer from private.guided_correction_completion_capabilities where user_id = p_user_id
    union all select count(*)::integer from private.verified_guest_capabilities where user_id = p_user_id
    union all select count(*)::integer from private.storekit_ai_item_period_events where user_id = p_user_id
    union all select count(*)::integer from private.revenuecat_webhook_events where user_id = p_user_id
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

create function public.advance_account_erasure(p_generation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_generation private.account_erasure_generations%rowtype;
  v_deferrals text[] := '{}'::text[];
  v_retained text[] := '{}'::text[];
  v_revenuecat_ids text[] := '{}'::text[];
  v_queue_ids bigint[] := '{}'::bigint[];
  v_queue_id bigint;
  v_run_id uuid;
  v_oauth_result jsonb;
begin
  perform private.account_erasure_service_role_required();

  select * into v_generation
  from private.account_erasure_generations generation
  where generation.generation_id = p_generation_id;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Account erasure generation not found';
  end if;
  if v_generation.status in (
    'deletion_completed', 'deletion_completed_with_retained_records'
  ) then
    return private.account_erasure_payload(p_generation_id);
  end if;

  -- Documented order: pipeline-retention, then ai-item-credit, then
  -- account-erasure last. restore_ai_item_credit expects its caller to already
  -- hold the credit lock. trophy-run-order is never needed: this function only
  -- deletes, and the trigger that takes it fires on insert/update.
  perform pg_advisory_xact_lock(hashtextextended('snaplist:pipeline-retention', 0));
  perform pg_advisory_xact_lock(
    hashtextextended('ai-item-credit:' || v_generation.user_id, 0)
  );
  perform private.lock_account_erasure(v_generation.user_id);

  select * into v_generation
  from private.account_erasure_generations generation
  where generation.generation_id = p_generation_id
  for update;
  -- The pre-lock check cannot see a finalize that completed while this call was
  -- waiting for the lock. Re-check under the row lock so a late advance cannot
  -- drag a completed generation back to deletion_in_progress.
  if v_generation.status in (
    'deletion_completed', 'deletion_completed_with_retained_records'
  ) then
    return private.account_erasure_payload(p_generation_id);
  end if;

  -- Re-select Storage: an upload that raced `begin` may have committed since.
  insert into private.account_erasure_storage_manifest (
    generation_id,
    bucket_id,
    object_name
  )
  select p_generation_id, object.bucket_id, object.name
  from storage.objects object
  where object.bucket_id in ('photos', 'message-photos')
    and split_part(object.name, '/', 1) = v_generation.user_id
  on conflict (generation_id, bucket_id, object_name) do nothing;

  if exists (
    select 1
    from private.account_erasure_storage_manifest manifest
    where manifest.generation_id = p_generation_id
      and manifest.verified_absent_at is null
  ) then
    v_deferrals := array_append(v_deferrals, 'private-storage-objects-pending');
  end if;

  -- eBay owns anything already dispatched. Wait for the provider round trip
  -- rather than deleting the local record that explains it.
  if exists (
    select 1 from private.ebay_provider_dispatch_leases lease
    where lease.user_id = v_generation.user_id
      and lease.expires_at > statement_timestamp()
  ) or exists (
    select 1 from public.listings listing
    where listing.user_id = v_generation.user_id
      and listing.platform = 'ebay'
      and listing.ebay_status = 'publishing'
  ) then
    v_deferrals := array_append(v_deferrals, 'ebay-provider-authority-pending');
  end if;

  if exists (
    select 1 from private.guest_draft_recoveries recovery
    where recovery.claim_target_user_id = v_generation.user_id
      and recovery.state = 'copying'
  ) then
    v_deferrals := array_append(v_deferrals, 'guest-claim-in-progress');
  end if;

  -- A cleanup job naming another tenant's objects is not this tenant's row to
  -- delete, and erasure never reaches across a tenant boundary.
  if exists (
    select 1
    from private.pipeline_storage_cleanup_jobs job
    where exists (
      select 1 from unnest(job.photo_paths) path
      where split_part(path, '/', 1) = v_generation.user_id
    ) and exists (
      select 1 from unnest(job.photo_paths) path
      where split_part(path, '/', 1) <> v_generation.user_id
    )
  ) then
    v_deferrals := array_append(v_deferrals, 'mixed-tenant-storage-cleanup');
  end if;

  if cardinality(v_deferrals) > 0 then
    update private.account_erasure_generations
    set status = 'deletion_in_progress',
        deferrals = v_deferrals,
        -- Resuming is the whole point of this state, so leaving the previous
        -- reasons attached would violate the biconditional that ties them to
        -- deletion_needs_attention and strand the erasure here permanently.
        attention_reasons = '{}'::text[],
        updated_at = statement_timestamp()
    where generation_id = p_generation_id;
    return private.account_erasure_payload(p_generation_id);
  end if;

  -- What survives erasure, captured before the rows that prove it are deleted.
  if exists (
    select 1 from public.listings listing
    where listing.user_id = v_generation.user_id
      and listing.platform = 'ebay'
      and (listing.ebay_listing_id is not null or listing.ebay_status = 'published')
  ) then
    v_retained := array_append(v_retained, 'ebay-live-listing');
  end if;
  if exists (
    select 1 from private.mobile_item_submission_voice_handoffs handoff
    where handoff.user_id = v_generation.user_id
      and handoff.transcription_outcome is not null
  ) then
    v_retained := array_append(v_retained, 'hosted-transcription-provider-copy');
  end if;

  -- The provider references the identity phase needs, captured before the rows
  -- holding them go. finalize scrubs them again with the terminal status.
  select coalesce(array_agg(distinct binding.revenuecat_app_user_id), '{}'::text[])
  into v_revenuecat_ids
  from public.revenuecat_customer_bindings binding
  where binding.user_id = v_generation.user_id
    and binding.revenuecat_app_user_id is not null;

  perform set_config('app.account_erasure_internal', 'true', true);

  select coalesce(
    array_agg(run.queue_message_id order by run.queue_message_id), '{}'::bigint[]
  )
  into v_queue_ids
  from public.pipeline_runs run
  where run.user_id = v_generation.user_id
    and run.queue_message_id is not null;

  -- Reservation reconciliation before the credit rows go, as the contract's
  -- ai-item-credits row requires.
  for v_run_id in
    select run.id from public.pipeline_runs run
    where run.user_id = v_generation.user_id
    order by run.id
  loop
    perform private.restore_ai_item_credit(v_run_id);
  end loop;

  foreach v_queue_id in array v_queue_ids loop
    perform pgmq.delete('pipeline_jobs', v_queue_id);
    delete from pgmq.a_pipeline_jobs archive where archive.msg_id = v_queue_id;
  end loop;

  delete from private.guided_correction_completion_capabilities where user_id = v_generation.user_id;
  delete from private.mobile_listing_review_saves where user_id = v_generation.user_id;
  delete from public.pricing_evidence_snapshots where user_id = v_generation.user_id;
  delete from public.message_policy_decisions where user_id = v_generation.user_id;
  delete from public.message_attachments where user_id = v_generation.user_id;
  delete from public.notifications where user_id = v_generation.user_id;
  delete from public.messages where user_id = v_generation.user_id;
  delete from private.mobile_item_submission_voice_handoffs where user_id = v_generation.user_id;
  delete from private.mobile_item_submissions where user_id = v_generation.user_id;
  delete from private.mobile_run_operation_replays where user_id = v_generation.user_id;
  delete from private.verified_guest_capabilities where user_id = v_generation.user_id;
  delete from private.pipeline_run_usage_reservations where user_id = v_generation.user_id;
  delete from private.legacy_pipeline_usage_reservations where user_id = v_generation.user_id;
  delete from public.ai_item_credit_reservations where user_id = v_generation.user_id;
  delete from private.storekit_ai_item_period_events where user_id = v_generation.user_id;
  delete from public.ai_item_allowance_periods where user_id = v_generation.user_id;
  delete from public.reprice_suggestions where user_id = v_generation.user_id;
  delete from public.prediction_logs where user_id = v_generation.user_id;
  delete from public.embeddings where user_id = v_generation.user_id;
  delete from public.pipeline_run_history_order_versions where user_id = v_generation.user_id;
  delete from public.pipeline_runs where user_id = v_generation.user_id;
  -- Assisted-export receipts (migration 20260731040000) already cascade from
  -- both `listings` and `items`, so this delete removes nothing today. It is
  -- here because the completion proof now COUNTS the receipts: leaving their
  -- removal to a foreign key declared in another migration means a later change
  -- to that key would not fail a test, it would strand every erasure at
  -- "Mandatory account erasure work is incomplete" with no way to finish.
  delete from public.export_handoffs where user_id = v_generation.user_id;
  delete from public.listings where user_id = v_generation.user_id;
  delete from public.items where user_id = v_generation.user_id;

  -- A recovery row is shared state. Delete the ones this tenant owns; on a row
  -- another tenant still owns, clear only this tenant's claim identity.
  delete from private.guest_draft_recoveries recovery
  where recovery.guest_user_id = v_generation.user_id
    or (
      recovery.claim_target_user_id = v_generation.user_id
      and recovery.state = 'claimed'
    );
  update private.guest_draft_recoveries recovery
  set claim_idempotency_user_id = null,
      claim_idempotency_key = null
  where recovery.claim_idempotency_user_id = v_generation.user_id;

  delete from private.pipeline_staging_cleanup_intents where user_id = v_generation.user_id;
  delete from private.pipeline_storage_cleanup_jobs job
  where exists (
    select 1 from unnest(job.photo_paths) path
    where split_part(path, '/', 1) = v_generation.user_id
  );
  delete from private.message_photo_object_deletion_queue
  where split_part(storage_path, '/', 1) = v_generation.user_id;

  v_oauth_result := public.delete_mobile_ebay_oauth_sessions_for_account_erasure(
    v_generation.user_id
  );
  if not coalesce((v_oauth_result->>'complete')::boolean, false) then
    raise exception using
      errcode = '55000',
      message = 'Mobile eBay OAuth session erasure is incomplete';
  end if;

  delete from public.ebay_unresolved_questions where user_id = v_generation.user_id;
  delete from public.ebay_message_sync_state where user_id = v_generation.user_id;
  delete from public.ebay_connections where user_id = v_generation.user_id;
  delete from private.ebay_provider_dispatch_leases where user_id = v_generation.user_id;
  delete from private.ebay_buyer_identity_provenance where user_id = v_generation.user_id;
  delete from private.ebay_buyer_identity_observations where user_id = v_generation.user_id;
  delete from private.ebay_erased_buyer_generation_tombstones where user_id = v_generation.user_id;
  delete from private.ebay_sandbox_fallback_bindings where user_id = v_generation.user_id;
  delete from private.ebay_unmappable_connection_quarantines where user_id = v_generation.user_id;
  delete from private.ebay_seller_identity_tenants where user_id = v_generation.user_id;
  delete from private.ebay_seller_account_generations where user_id = v_generation.user_id;
  delete from private.ebay_messaging_account_generations where user_id = v_generation.user_id;

  delete from public.billing_checkout_reservations where user_id = v_generation.user_id;
  delete from public.billing_customers where user_id = v_generation.user_id;
  delete from private.revenuecat_webhook_events where user_id = v_generation.user_id;
  delete from public.revenuecat_customer_bindings where user_id = v_generation.user_id;
  delete from public.subscriptions where user_id = v_generation.user_id;
  delete from public.user_settings where user_id = v_generation.user_id;

  if private.account_erasure_owned_row_count(v_generation.user_id) <> 0
    or exists (
      select 1 from pgmq.q_pipeline_jobs queue where queue.msg_id = any(v_queue_ids)
    )
    or exists (
      select 1 from pgmq.a_pipeline_jobs archive where archive.msg_id = any(v_queue_ids)
    ) then
    raise exception using
      errcode = '55000',
      message = 'Mandatory account erasure work is incomplete';
  end if;

  -- set_config(..., true) is transaction-scoped, not statement-scoped, so the
  -- bypass would otherwise stay open for anything else sharing this
  -- transaction. Close it the moment the deletes are proved.
  perform set_config('app.account_erasure_internal', 'false', true);

  -- Both of these accumulate rather than overwrite, because advance runs again
  -- on every resume and recomputes them from rows a previous pass already
  -- deleted. Overwriting would mean a crash between advance and finalize
  -- silently erases the provider ids the identity phase still needs and the
  -- retained records that make deletion_completed_with_retained_records
  -- truthful, leaving a flat deletion_completed claiming a provider deletion
  -- that never happened. Evidence observed once does not stop being true
  -- because the row that carried it is gone.
  update private.account_erasure_generations
  set status = 'deletion_in_progress',
      deferrals = '{}'::text[],
      retained_records = (
        select coalesce(array_agg(distinct record order by record), '{}'::text[])
        from unnest(retained_records || v_retained) as record
      ),
      clerk_user_id = v_generation.user_id,
      revenuecat_app_user_ids = (
        select coalesce(array_agg(distinct app_user_id order by app_user_id), '{}'::text[])
        from unnest(revenuecat_app_user_ids || v_revenuecat_ids) as app_user_id
      ),
      attention_reasons = '{}'::text[],
      updated_at = statement_timestamp()
  where generation_id = p_generation_id;

  return private.account_erasure_payload(p_generation_id);
end;
$$;

revoke all on function public.advance_account_erasure(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.advance_account_erasure(uuid)
  to service_role;

-- Terminal truth. The caller asserts what it observed at Clerk and RevenueCat;
-- Postgres re-proves everything SnapList owns before any completed status can
-- be written. Provider-owned deletion is never SnapList deletion, so a
-- surviving provider record produces the retained-records status, not silence.
create function public.finalize_account_erasure(
  p_generation_id uuid,
  p_clerk_identity_absent boolean,
  p_revenuecat_customer_absent boolean,
  p_attention_reasons text[] default '{}'::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_generation private.account_erasure_generations%rowtype;
begin
  perform private.account_erasure_service_role_required();

  select * into v_generation
  from private.account_erasure_generations generation
  where generation.generation_id = p_generation_id;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Account erasure generation not found';
  end if;
  if v_generation.status in (
    'deletion_completed', 'deletion_completed_with_retained_records'
  ) then
    return private.account_erasure_payload(p_generation_id);
  end if;

  perform private.lock_account_erasure(v_generation.user_id);
  select * into v_generation
  from private.account_erasure_generations generation
  where generation.generation_id = p_generation_id
  for update;
  -- The check above ran before the lock, so a concurrent finalize can have
  -- completed the generation while this call waited. Re-check now that the row
  -- is held: without this the loser re-stamps completed_at and slides the
  -- receipt's 30-day prune window forward every time it is called.
  if v_generation.status in (
    'deletion_completed', 'deletion_completed_with_retained_records'
  ) then
    return private.account_erasure_payload(p_generation_id);
  end if;

  if cardinality(coalesce(p_attention_reasons, '{}'::text[])) > 0 then
    update private.account_erasure_generations
    set status = 'deletion_needs_attention',
        attention_reasons = p_attention_reasons,
        updated_at = statement_timestamp()
    where generation_id = p_generation_id;
    return private.account_erasure_payload(p_generation_id);
  end if;

  if not coalesce(p_clerk_identity_absent, false) then
    raise exception using
      errcode = '55000',
      message = 'Clerk identity absence is not proved';
  end if;
  if cardinality(v_generation.revenuecat_app_user_ids) > 0
    and not coalesce(p_revenuecat_customer_absent, false) then
    raise exception using
      errcode = '55000',
      message = 'RevenueCat customer absence is not proved';
  end if;

  if private.account_erasure_owned_row_count(v_generation.user_id) <> 0
    or exists (
      select 1 from storage.objects object
      where object.bucket_id in ('photos', 'message-photos')
        and split_part(object.name, '/', 1) = v_generation.user_id
    )
    or exists (
      select 1
      from private.account_erasure_storage_manifest manifest
      where manifest.generation_id = p_generation_id
        and manifest.verified_absent_at is null
    ) then
    raise exception using
      errcode = '55000',
      message = 'Mandatory account erasure work is incomplete';
  end if;

  delete from private.account_erasure_storage_manifest
  where generation_id = p_generation_id;

  update private.account_erasure_generations
  set status = case
        when cardinality(retained_records) > 0
          then 'deletion_completed_with_retained_records'
        else 'deletion_completed'
      end,
      user_id = null,
      idempotency_key = null,
      clerk_user_id = null,
      revenuecat_app_user_ids = '{}'::text[],
      deferrals = '{}'::text[],
      attention_reasons = '{}'::text[],
      completed_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where generation_id = p_generation_id;

  return private.account_erasure_payload(p_generation_id);
end;
$$;

revoke all on function public.finalize_account_erasure(uuid, boolean, boolean, text[])
  from public, anon, authenticated, service_role;
grant execute on function public.finalize_account_erasure(uuid, boolean, boolean, text[])
  to service_role;

-- The keyed receipt outlives completion only long enough to keep the fence and
-- the replay answer honest; then it goes too. Its own retention row lives in
-- docs/contracts/lean-mvp-retention-v1.json.
create function private.prune_account_erasure_receipts(
  p_now timestamptz default statement_timestamp()
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer := 0;
begin
  delete from private.account_erasure_generations
  where completed_at is not null
    and completed_at < p_now - interval '30 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function private.prune_account_erasure_receipts(timestamptz)
  from public, anon, authenticated, service_role;

select cron.schedule(
  'snaplist-account-erasure-receipt-retention-daily',
  '41 3 * * *',
  'select private.prune_account_erasure_receipts(statement_timestamp());'
);
