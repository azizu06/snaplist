-- Issue #705. eBay cannot accept Supabase signed URLs whose embedded object
-- path pushes them over its 500-character limit. Replace them with a short,
-- random bearer capability. Raw tokens are returned once and never stored.
create table public.ebay_photo_access_tokens (
  token_digest bytea primary key,
  user_id text not null,
  item_id uuid not null,
  storage_bucket text not null default 'photos'
    check (storage_bucket = 'photos'),
  storage_path text not null check (char_length(storage_path) between 1 and 1024),
  media_type text not null check (char_length(media_type) between 1 and 255),
  expires_at timestamp with time zone not null,
  created_at timestamp with time zone not null default statement_timestamp(),
  foreign key (item_id, user_id)
    references public.items (id, user_id) on delete cascade,
  check (octet_length(token_digest) = 32),
  check (expires_at > created_at)
);

comment on table public.ebay_photo_access_tokens is
  'Tenant-owned digests for short, expiring eBay photo bearer capabilities. Raw tokens are never stored.';

create index ebay_photo_access_tokens_item_idx
  on public.ebay_photo_access_tokens (user_id, item_id);

alter table public.ebay_photo_access_tokens enable row level security;

revoke all on table public.ebay_photo_access_tokens
  from public, anon, authenticated, service_role;
grant select, delete on table public.ebay_photo_access_tokens to authenticated;

create policy ebay_photo_access_tokens_select_own
  on public.ebay_photo_access_tokens
  for select
  to authenticated
  using ((select public.clerk_user_id()) = user_id);

create policy ebay_photo_access_tokens_delete_own
  on public.ebay_photo_access_tokens
  for delete
  to authenticated
  using ((select public.clerk_user_id()) = user_id);

-- Serialize token issuance/revocation with account erasure. The account
-- generation and a token insert cannot both commit in opposite orders.
create function private.lock_ebay_photo_access_token_erasure()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text;
begin
  for v_user_id in
    select distinct candidate.user_id
    from (
      values
        (case when tg_op = 'INSERT' then null else old.user_id end),
        (case when tg_op = 'DELETE' then null else new.user_id end)
    ) candidate(user_id)
    where candidate.user_id is not null
    order by candidate.user_id
  loop
    perform private.lock_account_erasure(v_user_id);
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.lock_ebay_photo_access_token_erasure()
  from public, anon, authenticated, service_role;

create trigger zzy_lock_ebay_photo_access_token_erasure
  before insert or update or delete on public.ebay_photo_access_tokens
  for each row execute function private.lock_ebay_photo_access_token_erasure();

create trigger zzz_fence_account_erasure_tenant_mutation
  before insert or update or delete on public.ebay_photo_access_tokens
  for each row execute function private.fence_account_erasure_tenant_mutation();

-- Caller supplies only the tenant-owned item and a bounded lifetime. Storage
-- bucket/path/media type are resolved from the locked item and Storage catalog.
create or replace function public.issue_ebay_photo_access_tokens(
  p_item_id uuid,
  p_ttl_seconds integer default 604800
)
returns table (
  photo_ordinal integer,
  token text,
  expires_at timestamp with time zone
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text;
  v_photos text[];
  v_token text;
  v_media_type text;
  v_expires_at timestamp with time zone;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'authenticated' then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  v_user_id := public.clerk_user_id();
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if p_ttl_seconds not between 1 and 604800 then
    raise exception using errcode = '22023', message = 'Invalid photo token lifetime';
  end if;

  select item.photos into v_photos
  from public.items item
  where item.id = p_item_id
    and item.user_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Item not found';
  end if;

  -- A retry supersedes capabilities from the failed attempt.
  delete from public.ebay_photo_access_tokens access
  where access.item_id = p_item_id
    and access.user_id = v_user_id;

  v_expires_at := statement_timestamp() + make_interval(secs => p_ttl_seconds);
  for v_index in 1..coalesce(cardinality(v_photos), 0) loop
    if split_part(v_photos[v_index], '/', 1) is distinct from v_user_id then
      continue;
    end if;
    select coalesce(object.metadata->>'mimetype', 'application/octet-stream')
    into v_media_type
    from storage.objects object
    where object.bucket_id = 'photos'
      and object.name = v_photos[v_index];
    if not found or v_media_type not in (
      'image/jpeg', 'image/png', 'image/webp', 'image/gif',
      'image/avif', 'image/heic', 'image/heif', 'image/tiff', 'image/bmp'
    ) then
      continue;
    end if;

    v_token := translate(
      rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='),
      '+/',
      '-_'
    );
    insert into public.ebay_photo_access_tokens (
      token_digest,
      user_id,
      item_id,
      storage_path,
      media_type,
      expires_at
    ) values (
      extensions.digest(convert_to(v_token, 'UTF8'), 'sha256'),
      v_user_id,
      p_item_id,
      v_photos[v_index],
      v_media_type,
      v_expires_at
    );

    photo_ordinal := v_index - 1;
    token := v_token;
    expires_at := v_expires_at;
    return next;
  end loop;
end;
$$;

revoke all on function public.issue_ebay_photo_access_tokens(uuid, integer)
  from public, anon, service_role;
grant execute on function public.issue_ebay_photo_access_tokens(uuid, integer)
  to authenticated;

-- Public HTTP callers never reach this function. The unauthenticated app route
-- hashes their opaque token, then its server-only secret client resolves one
-- still-live row. Unknown and expired digests both return no row.
create or replace function public.resolve_ebay_photo_access_token(p_token_digest text)
returns table (
  storage_bucket text,
  storage_path text,
  media_type text
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Server authorization required';
  end if;
  if p_token_digest !~ '^[0-9a-f]{64}$' then
    return;
  end if;

  return query
  select access.storage_bucket, access.storage_path, access.media_type
  from public.ebay_photo_access_tokens access
  join public.items item
    on item.id = access.item_id
   and item.user_id = access.user_id
  join storage.objects object
    on object.bucket_id = access.storage_bucket
   and object.name = access.storage_path
  where access.token_digest = decode(p_token_digest, 'hex')
    and access.expires_at > statement_timestamp()
    and access.storage_bucket = 'photos'
    and split_part(access.storage_path, '/', 1) = access.user_id
    and access.storage_path = any(item.photos)
  limit 1;
end;
$$;

revoke all on function public.resolve_ebay_photo_access_token(text)
  from public, anon, authenticated;
grant execute on function public.resolve_ebay_photo_access_token(text)
  to service_role;

-- A photo removed from the item loses its bearer capability in the same
-- transaction. Item deletion is covered by the item_id ON DELETE CASCADE.
create function private.revoke_removed_ebay_photo_access_tokens()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.ebay_photo_access_tokens access
  where access.item_id = new.id
    and access.user_id = new.user_id
    and not (
      access.storage_path = any(coalesce(new.photos, '{}'::text[]))
    );
  return new;
end;
$$;

revoke all on function private.revoke_removed_ebay_photo_access_tokens()
  from public, anon, authenticated, service_role;

create trigger revoke_removed_ebay_photo_access_tokens
  after update of photos on public.items
  for each row execute function private.revoke_removed_ebay_photo_access_tokens();

-- Revoke every bearer capability when erasure begins, before Storage deletion
-- can be deferred. Failure aborts begin_account_erasure; completion can never
-- be reported while a seller capability remains unresolved.
create function private.delete_ebay_photo_access_tokens_for_erasure()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('app.account_erasure_internal', 'true', true);
  delete from public.ebay_photo_access_tokens where user_id = new.user_id;
  perform set_config('app.account_erasure_internal', 'false', true);
  return new;
end;
$$;

revoke all on function private.delete_ebay_photo_access_tokens_for_erasure()
  from public, anon, authenticated, service_role;

create trigger delete_ebay_photo_access_tokens_for_erasure
  after insert on private.account_erasure_generations
  for each row execute function private.delete_ebay_photo_access_tokens_for_erasure();

-- Keep account-erasure completion proof exhaustive after adding this tenant
-- table. This is the latest prior definition plus photo access tokens.
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
