-- Issue #384: durable, resumable, tenant-isolated account erasure.
-- External provider calls remain outside Postgres. Trusted server authority may
-- acknowledge only the blocker ids named by ADR-0012's singular retention matrix.

create table private.account_erasure_generations (
  generation_id uuid primary key default gen_random_uuid(),
  user_id text not null unique,
  idempotency_key uuid not null,
  status text not null default 'deleting',
  blockers text[] not null default '{}'::text[],
  started_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz,
  constraint account_erasure_generations_user_shape
    check (user_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  constraint account_erasure_generations_status
    check (status in ('deleting', 'blocked', 'complete')),
  constraint account_erasure_generations_completion
    check ((status = 'complete') = (completed_at is not null)),
  constraint account_erasure_generations_idempotency
    unique (user_id, idempotency_key)
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

alter table private.account_erasure_generations enable row level security;
alter table private.account_erasure_generations force row level security;
alter table private.account_erasure_storage_manifest enable row level security;
alter table private.account_erasure_storage_manifest force row level security;

revoke all on table private.account_erasure_generations
  from public, anon, authenticated, service_role;
revoke all on table private.account_erasure_storage_manifest
  from public, anon, authenticated, service_role;

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

create function private.assert_account_erasure_mutation_allowed(
  p_user_id text,
  p_allow_existing_provider_completion boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_internal boolean :=
    coalesce(auth.jwt()->>'role', '') = 'service_role'
    and current_setting('app.account_erasure_internal', true) = 'true';
begin
  if coalesce(p_user_id, '') = '' then return; end if;
  perform private.lock_account_erasure(p_user_id);
  if exists (
    select 1
    from private.account_erasure_generations generation
    where generation.user_id = p_user_id
  ) and not v_internal and not p_allow_existing_provider_completion then
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
  v_allow_existing_provider_completion boolean := false;
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

  v_allow_existing_provider_completion :=
    (
      tg_table_schema = 'public'
      and tg_table_name = 'listings'
      and tg_op = 'UPDATE'
      and v_old->>'ebay_status' = 'publishing'
      and v_new->>'ebay_status' = 'failed'
    )
    or (
      tg_table_schema = 'private'
      and tg_table_name = 'ebay_provider_dispatch_leases'
      and tg_op in ('UPDATE', 'DELETE')
    );

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
      v_allow_existing_provider_completion
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
    select account.* into v_account
    from private.ebay_messaging_account_generations account
    where account.user_id = p_user_id;
    if found and (
      v_account.seller_erased
      or v_account.generation is distinct from p_account_generation
    ) then
      raise exception using
        errcode = '40001',
        message = 'eBay account generation changed before local completion';
    end if;
    raise exception using
      errcode = '40001',
      message = 'eBay provider dispatch lease expired before local completion';
  end if;

  perform set_config('app.account_erasure_provider_completion_user_id', p_user_id, true);
  perform set_config('app.account_erasure_provider_completion_resource_id', p_resource_id::text, true);
  perform set_config('app.account_erasure_provider_completion_operation', p_operation, true);

  v_account := private.lock_ebay_messaging_account(p_user_id);
  if v_account.seller_erased
    or v_account.generation is distinct from p_account_generation then
    raise exception using
      errcode = '40001',
      message = 'eBay account generation changed before local completion';
  end if;
end;
$$;

revoke all on function private.assert_ebay_dispatch_completion(
  text, uuid, text, uuid, uuid
) from public, anon, authenticated, service_role;

do $account_erasure_triggers$
declare
  v_table regclass;
begin
  foreach v_table in array array[
    'public.items'::regclass,
    'public.listings'::regclass,
    'public.messages'::regclass,
    'public.embeddings'::regclass,
    'public.prediction_logs'::regclass,
    'public.user_settings'::regclass,
    'public.ebay_connections'::regclass,
    'public.subscriptions'::regclass,
    'public.notifications'::regclass,
    'public.reprice_suggestions'::regclass,
    'public.ebay_message_sync_state'::regclass,
    'public.ebay_unresolved_questions'::regclass,
    'public.message_policy_decisions'::regclass,
    'public.message_attachments'::regclass,
    'public.billing_customers'::regclass,
    'public.billing_checkout_reservations'::regclass,
    'public.ai_item_allowance_periods'::regclass,
    'public.ai_item_credit_reservations'::regclass,
    'public.revenuecat_customer_bindings'::regclass,
    'public.pipeline_runs'::regclass,
    'public.pricing_evidence_snapshots'::regclass,
    'public.ebay_oauth_sessions'::regclass,
    'private.ebay_messaging_account_generations'::regclass,
    'private.ebay_seller_account_generations'::regclass,
    'private.ebay_provider_dispatch_leases'::regclass,
    'private.ebay_buyer_identity_provenance'::regclass,
    'private.ebay_buyer_identity_observations'::regclass,
    'private.ebay_erased_buyer_generation_tombstones'::regclass,
    'private.ebay_sandbox_fallback_bindings'::regclass,
    'private.ebay_unmappable_connection_quarantines'::regclass,
    'private.ebay_seller_identity_tenants'::regclass,
    'private.pipeline_run_usage_reservations'::regclass,
    'private.pipeline_staging_cleanup_intents'::regclass,
    'private.legacy_pipeline_usage_reservations'::regclass,
    'private.mobile_item_submissions'::regclass,
    'private.mobile_run_operation_replays'::regclass,
    'private.guided_correction_completion_capabilities'::regclass,
    'private.storekit_ai_item_period_events'::regclass,
    'private.revenuecat_webhook_events'::regclass,
    'private.guest_draft_recoveries'::regclass,
    'private.pipeline_storage_cleanup_jobs'::regclass,
    'private.message_photo_object_deletion_queue'::regclass
  ] loop
    execute format(
      'create trigger fence_account_erasure_tenant_mutation '
        || 'before insert or update or delete on %s for each row '
        || 'execute function private.fence_account_erasure_tenant_mutation()',
      v_table
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

create trigger fence_account_erasure_storage_object
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
    ), '[]'::jsonb),
    'blockers', to_jsonb(generation.blockers)
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
begin
  perform private.account_erasure_service_role_required();
  if p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'Account erasure Idempotency-Key is required';
  end if;
  perform private.lock_account_erasure(p_user_id);

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
  where generation.user_id = p_user_id
  for update;
  if found and v_generation.idempotency_key is distinct from p_idempotency_key then
    raise exception using
      errcode = '23505',
      message = 'Account erasure Idempotency-Key is already bound';
  end if;
  if not found then
    insert into private.account_erasure_generations (user_id, idempotency_key)
    values (p_user_id, p_idempotency_key)
    returning * into v_generation;
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

  if exists (
    select 1
    from private.account_erasure_storage_manifest manifest
    where manifest.generation_id = v_generation.generation_id
      and manifest.verified_absent_at is null
  ) and v_generation.status <> 'complete' then
    update private.account_erasure_generations
    set status = 'deleting',
        blockers = '{}'::text[],
        updated_at = statement_timestamp()
    where generation_id = v_generation.generation_id;
  end if;

  return private.account_erasure_payload(v_generation.generation_id);
end;
$$;

revoke all on function public.begin_account_erasure(text, uuid)
  from public, anon, authenticated;
revoke all on function public.begin_account_erasure(text, uuid)
  from service_role;
grant execute on function public.begin_account_erasure(text, uuid)
  to service_role;

create or replace function public.begin_guest_draft_claim(
  p_recovery_id uuid,
  p_guest_user_id text,
  p_recovery_token_hash text,
  p_target_user_id text,
  p_idempotency_key uuid,
  p_claim_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recovery private.guest_draft_recoveries%rowtype;
  v_objects jsonb;
  v_retry_after integer;
  v_bound_recovery_id uuid;
begin
  perform private.guest_claim_service_role_required();
  if coalesce(char_length(p_target_user_id), 0) not between 1 and 255
    or p_target_user_id !~ '^[A-Za-z0-9_-]+$'
    or p_target_user_id = p_guest_user_id
    or p_idempotency_key is null
    or p_claim_lease_seconds not between 30 and 3600 then
    raise exception using errcode = '22023', message = 'Invalid guest claim request';
  end if;

  perform private.lock_account_erasure(p_target_user_id);
  if exists (
    select 1
    from private.account_erasure_generations generation
    where generation.user_id = p_target_user_id
  ) then
    raise exception using
      errcode = '55000',
      message = 'Account erasure has started for this account';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'guest-claim-idempotency:' || p_target_user_id || ':'
        || p_idempotency_key::text,
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended('guest-recovery:' || p_recovery_id::text, 0)
  );
  select * into v_recovery
  from private.guest_draft_recoveries recovery
  where recovery.id = p_recovery_id
    and recovery.guest_user_id = p_guest_user_id
    and recovery.recovery_token_hash = p_recovery_token_hash
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Guest recovery not found';
  end if;

  if v_recovery.claim_idempotency_user_id is not null then
    if v_recovery.claim_idempotency_user_id is distinct from p_target_user_id then
      raise exception using errcode = 'P0002', message = 'Guest recovery not found';
    end if;
    if v_recovery.claim_idempotency_key is distinct from p_idempotency_key then
      raise exception using
        errcode = '23505',
        message = 'Guest claim Idempotency-Key is already bound';
    end if;
  end if;

  select recovery.id into v_bound_recovery_id
  from private.guest_draft_recoveries recovery
  where recovery.claim_idempotency_user_id = p_target_user_id
    and recovery.claim_idempotency_key = p_idempotency_key;
  if found and v_bound_recovery_id <> v_recovery.id then
    raise exception using
      errcode = '23505',
      message = 'Guest claim Idempotency-Key is already bound';
  end if;

  if v_recovery.claim_idempotency_key is null then
    update private.guest_draft_recoveries recovery
    set claim_idempotency_user_id = p_target_user_id,
        claim_idempotency_key = p_idempotency_key,
        updated_at = statement_timestamp()
    where recovery.id = v_recovery.id
    returning * into v_recovery;
  end if;

  if v_recovery.state not in ('claimed', 'expired')
    and statement_timestamp() >= v_recovery.expires_at then
    v_recovery := private.expire_guest_recovery_locked(v_recovery.id);
  end if;
  if v_recovery.state in ('claimed', 'expired') then
    return private.guest_terminal_outcome_for_target(
      v_recovery, p_target_user_id
    );
  end if;

  if v_recovery.state = 'copying'
    and v_recovery.claim_lease_expires_at > statement_timestamp() then
    v_retry_after := greatest(
      1,
      ceil(extract(epoch from (
        v_recovery.claim_lease_expires_at - statement_timestamp()
      )))::integer
    );
    return jsonb_build_object(
      'outcome', 'in_progress',
      'retryAfterSeconds', v_retry_after
    );
  end if;

  if v_recovery.state = 'copying' then
    perform private.queue_guest_claim_copy_cleanup(
      v_recovery,
      v_recovery.claim_target_user_id,
      v_recovery.claim_lease_token
    );
  end if;

  update private.guest_draft_recoveries recovery
  set state = 'copying',
      claim_target_user_id = p_target_user_id,
      claim_lease_token = gen_random_uuid(),
      claim_lease_expires_at = statement_timestamp()
        + make_interval(secs => p_claim_lease_seconds),
      updated_at = statement_timestamp()
  where recovery.id = v_recovery.id
  returning * into v_recovery;

  select jsonb_agg(
    jsonb_build_object(
      'sourcePath', entry.value->>'sourcePath',
      'destinationPath', p_target_user_id || '/guest-claims/'
        || v_recovery.id::text || '/' || v_recovery.claim_lease_token::text
        || '/' || entry.ordinality::text,
      'sha256', entry.value->>'sha256',
      'byteLength', (entry.value->>'byteLength')::bigint,
      'encryption', entry.value->'encryption'
    ) order by entry.ordinality
  ) into v_objects
  from jsonb_array_elements(v_recovery.storage_manifest)
    with ordinality entry(value, ordinality);

  return jsonb_build_object(
    'outcome', 'copy_required',
    'claimLeaseToken', v_recovery.claim_lease_token,
    'expiresAt', v_recovery.expires_at,
    'itemId', v_recovery.item_id,
    'runId', v_recovery.pipeline_run_id,
    'draftId', v_recovery.draft_id,
    'objects', v_objects
  );
end;
$$;

revoke all on function public.begin_guest_draft_claim(
  uuid, text, text, text, uuid, integer
) from public, anon, authenticated;
grant execute on function public.begin_guest_draft_claim(
  uuid, text, text, text, uuid, integer
) to service_role;

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
    raise exception using errcode = 'P0002', message = 'Account erasure generation not found';
  end if;
  perform private.lock_account_erasure(v_user_id);
  perform 1
  from private.account_erasure_storage_manifest manifest
  where manifest.generation_id = p_generation_id
    and manifest.bucket_id = p_bucket_id
    and manifest.object_name = p_object_name
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Account erasure Storage object not found';
  end if;
  if exists (
    select 1 from storage.objects object
    where object.bucket_id = p_bucket_id and object.name = p_object_name
  ) then
    raise exception using errcode = '55000', message = 'Account erasure Storage object still exists';
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
  from public, anon, authenticated;
revoke all on function public.confirm_account_erasure_storage_absence(uuid, text, text)
  from service_role;
grant execute on function public.confirm_account_erasure_storage_absence(uuid, text, text)
  to service_role;

create function private.account_erasure_owned_row_count(p_user_id text)
returns integer
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce(sum(residue.count), 0)::integer
  from (
    select count(*)::integer count from public.items where user_id = p_user_id
    union all select count(*)::integer from public.listings where user_id = p_user_id
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
    union all select count(*)::integer from private.mobile_run_operation_replays where user_id = p_user_id
    union all select count(*)::integer from private.guided_correction_completion_capabilities where user_id = p_user_id
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

create function public.advance_account_erasure(
  p_generation_id uuid,
  p_resolved_blockers text[] default '{}'::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_generation private.account_erasure_generations%rowtype;
  v_allowed_blockers constant text[] := array[
    'hosted-transcription-retention',
    'ebay-publish-receipt-obligations',
    'clerk-identity-retention',
    'apple-revenuecat-reference-obligations'
  ];
  v_blockers text[] := '{}'::text[];
  v_queue_ids bigint[] := '{}'::bigint[];
  v_queue_id bigint;
  v_run_id uuid;
  v_oauth_result jsonb;
  v_completion_payload jsonb;
begin
  perform private.account_erasure_service_role_required();
  if exists (
    select 1
    from unnest(coalesce(p_resolved_blockers, '{}'::text[])) blocker
    where not (blocker = any(v_allowed_blockers))
  ) then
    raise exception using errcode = '22023', message = 'Unknown account erasure blocker proof';
  end if;

  select * into v_generation
  from private.account_erasure_generations generation
  where generation.generation_id = p_generation_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Account erasure generation not found';
  end if;
  perform private.lock_account_erasure(v_generation.user_id);
  select * into v_generation
  from private.account_erasure_generations generation
  where generation.generation_id = p_generation_id
  for update;
  if v_generation.status = 'complete' then
    return private.account_erasure_payload(p_generation_id);
  end if;

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
    update private.account_erasure_generations
    set status = 'deleting', blockers = '{}'::text[], updated_at = statement_timestamp()
    where generation_id = p_generation_id;
    return private.account_erasure_payload(p_generation_id);
  end if;

  if not ('hosted-transcription-retention' = any(coalesce(p_resolved_blockers, '{}'::text[]))) then
    v_blockers := array_append(v_blockers, 'hosted-transcription-retention');
  end if;
  if not ('clerk-identity-retention' = any(coalesce(p_resolved_blockers, '{}'::text[]))) then
    v_blockers := array_append(v_blockers, 'clerk-identity-retention');
  end if;
  if not ('ebay-publish-receipt-obligations' = any(coalesce(p_resolved_blockers, '{}'::text[])))
    and exists (
      select 1 from public.listings listing
      where listing.user_id = v_generation.user_id
        and listing.platform = 'ebay'
        and (listing.ebay_listing_id is not null or listing.status = 'published')
    ) then
    v_blockers := array_append(v_blockers, 'ebay-publish-receipt-obligations');
  end if;
  if not ('apple-revenuecat-reference-obligations' = any(coalesce(p_resolved_blockers, '{}'::text[])))
    and (
      exists (select 1 from public.revenuecat_customer_bindings where user_id = v_generation.user_id)
      or exists (select 1 from private.revenuecat_webhook_events where user_id = v_generation.user_id)
      or exists (select 1 from private.storekit_ai_item_period_events where user_id = v_generation.user_id)
      or exists (select 1 from public.subscriptions where user_id = v_generation.user_id)
    ) then
    v_blockers := array_append(v_blockers, 'apple-revenuecat-reference-obligations');
  end if;
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
    v_blockers := array_append(v_blockers, 'external-ebay-authority-pending');
  end if;
  if exists (
    select 1 from private.guest_draft_recoveries recovery
    where recovery.claim_target_user_id = v_generation.user_id
      and recovery.state = 'copying'
  ) then
    v_blockers := array_append(v_blockers, 'guest-claim-active');
  end if;
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
    v_blockers := array_append(v_blockers, 'mixed-storage-cleanup-authority');
  end if;
  if cardinality(v_blockers) > 0 then
    update private.account_erasure_generations
    set status = 'blocked', blockers = v_blockers, updated_at = statement_timestamp()
    where generation_id = p_generation_id;
    return private.account_erasure_payload(p_generation_id);
  end if;

  perform set_config('app.account_erasure_internal', 'true', true);
  perform pg_advisory_xact_lock(hashtextextended('snaplist:pipeline-retention', 0));
  perform pg_advisory_xact_lock(
    hashtextextended('ai-item-credit:' || v_generation.user_id, 0)
  );

  select coalesce(array_agg(run.queue_message_id order by run.queue_message_id), '{}'::bigint[])
  into v_queue_ids
  from public.pipeline_runs run
  where run.user_id = v_generation.user_id
    and run.queue_message_id is not null;
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
  delete from public.pricing_evidence_snapshots where user_id = v_generation.user_id;
  delete from public.message_policy_decisions where user_id = v_generation.user_id;
  delete from public.message_attachments where user_id = v_generation.user_id;
  delete from public.notifications where user_id = v_generation.user_id;
  delete from public.messages where user_id = v_generation.user_id;
  delete from private.mobile_item_submissions where user_id = v_generation.user_id;
  delete from private.mobile_run_operation_replays where user_id = v_generation.user_id;
  delete from private.pipeline_run_usage_reservations where user_id = v_generation.user_id;
  delete from private.legacy_pipeline_usage_reservations where user_id = v_generation.user_id;
  delete from public.ai_item_credit_reservations where user_id = v_generation.user_id;
  delete from private.storekit_ai_item_period_events where user_id = v_generation.user_id;
  delete from public.ai_item_allowance_periods where user_id = v_generation.user_id;
  delete from public.reprice_suggestions where user_id = v_generation.user_id;
  delete from public.prediction_logs where user_id = v_generation.user_id;
  delete from public.embeddings where user_id = v_generation.user_id;
  delete from public.pipeline_runs where user_id = v_generation.user_id;
  delete from public.listings where user_id = v_generation.user_id;
  delete from public.items where user_id = v_generation.user_id;

  delete from private.guest_draft_recoveries recovery
  where recovery.guest_user_id = v_generation.user_id
    or (
      recovery.claim_target_user_id = v_generation.user_id
      and recovery.state = 'claimed'
    );
  update private.guest_draft_recoveries recovery
  set claim_idempotency_user_id = null,
      claim_idempotency_key = null,
      claim_target_user_id = null
  where recovery.claim_idempotency_user_id = v_generation.user_id
    and recovery.state not in ('copying', 'claimed');

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
    raise exception using errcode = '55000', message = 'Mobile eBay OAuth erasure is incomplete';
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
      select 1 from storage.objects object
      where object.bucket_id in ('photos', 'message-photos')
        and split_part(object.name, '/', 1) = v_generation.user_id
    )
    or exists (
      select 1 from pgmq.q_pipeline_jobs queue where queue.msg_id = any(v_queue_ids)
    )
    or exists (
      select 1 from pgmq.a_pipeline_jobs archive where archive.msg_id = any(v_queue_ids)
    ) then
    raise exception using errcode = '55000', message = 'Mandatory account erasure proof is incomplete';
  end if;

  v_completion_payload := jsonb_build_object(
    'generation_id', p_generation_id,
    'status', 'complete',
    'storage_objects', '[]'::jsonb,
    'blockers', '[]'::jsonb
  );
  delete from private.account_erasure_generations
  where generation_id = p_generation_id;
  if not found then
    raise exception using errcode = '55000', message = 'Account erasure receipt scrub failed';
  end if;
  return v_completion_payload;
end;
$$;

revoke all on function public.advance_account_erasure(uuid, text[])
  from public, anon, authenticated;
revoke all on function public.advance_account_erasure(uuid, text[])
  from service_role;
grant execute on function public.advance_account_erasure(uuid, text[])
  to service_role;

comment on table private.account_erasure_generations is
  'Issue #384 durable one-generation-per-tenant account erasure authority and mutation fence.';
comment on table private.account_erasure_storage_manifest is
  'Issue #384 resumable private Storage selection; completion requires verified catalog absence.';
