-- Issue #169: eBay becomes authoritative once a confirmed publish supplies an
-- external listing id. SnapList then holds a COPY of the provider's state, and
-- every disagreement is recorded rather than resolved by last write.
--
-- Two tables, both tenant-owned:
--   ebay_listing_sync_state     — the confirmed provider truth for one listing.
--   ebay_listing_sync_conflicts — where local and provider disagree, and why.
--
-- Reads go through RLS. Writes go through guarded SECURITY DEFINER functions
-- that RE-CHECK every fence inside one statement, because a fence the caller
-- checked can be stale by the time the write lands.

create table public.ebay_listing_sync_state (
  listing_id uuid primary key,
  user_id text not null,
  -- The external identity that started eBay's authority. Not null by
  -- construction: no row may exist before a confirmed publish supplied one.
  ebay_listing_id text not null check (char_length(ebay_listing_id) between 1 and 64),
  marketplace_id text not null check (char_length(marketplace_id) between 1 and 32),
  -- The identity the observation was fetched under. A reconnect or an eBay
  -- account deletion rotates these, and stale sync work must not cross either.
  account_generation uuid not null,
  connection_generation uuid,
  -- Null when the last confirmed answer carried no lifecycle claim (a confirmed
  -- price revision does not observe whether the listing is still active).
  provider_status text
    check (provider_status in ('active', 'ended', 'completed', 'outOfStock')),
  provider_price_value numeric(12, 2) check (provider_price_value >= 0),
  provider_price_currency text check (char_length(provider_price_currency) = 3),
  provider_quantity integer check (provider_quantity between 0 and 1000000),
  provider_observed_at timestamp with time zone not null,
  -- The provider event this row reflects. Redelivery and re-polling of an
  -- unchanged listing both produce this same id, which is what makes at-least-
  -- once notification delivery idempotent without an unbounded event ledger.
  last_event_id text not null check (char_length(last_event_id) between 1 and 255),
  last_event_source text not null check (last_event_source in ('poll', 'notification')),
  -- The item review this sync row was written against. A guided correction
  -- advances it, which fails closed every observation still in flight.
  review_revision uuid not null,
  created_at timestamp with time zone not null default statement_timestamp(),
  updated_at timestamp with time zone not null default statement_timestamp(),
  foreign key (listing_id, user_id)
    references public.listings (id, user_id) on delete cascade,
  -- A price is a value AND a currency, or it is nothing. A bare amount would be
  -- compared against the seller's price with no way to know it is comparable.
  check (
    (provider_price_value is null) = (provider_price_currency is null)
  )
);

comment on table public.ebay_listing_sync_state is
  'Confirmed eBay state for one published listing (issue #169). A copy of provider truth, never SnapList intent.';

create index ebay_listing_sync_state_user_idx
  on public.ebay_listing_sync_state (user_id, provider_observed_at desc);

alter table public.ebay_listing_sync_state enable row level security;

revoke all on table public.ebay_listing_sync_state
  from public, anon, authenticated, service_role;
grant select on table public.ebay_listing_sync_state to authenticated;

create policy ebay_listing_sync_state_select_own
  on public.ebay_listing_sync_state
  for select
  to authenticated
  using ((select public.clerk_user_id()) = user_id);

create table public.ebay_listing_sync_conflicts (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  listing_id uuid not null,
  kind text not null
    check (kind in ('providerDiverged', 'ambiguousAcknowledgement')),
  field text not null check (field in ('status', 'price')),
  ebay_listing_id text not null check (char_length(ebay_listing_id) between 1 and 64),
  -- Rendered for comparison, not for arithmetic. Null on either side means that
  -- side held nothing comparable — never that the two sides agreed.
  local_value text check (char_length(local_value) between 1 and 255),
  provider_value text check (char_length(provider_value) between 1 and 255),
  observed_at timestamp with time zone not null,
  review_revision uuid not null,
  resolved_at timestamp with time zone,
  created_at timestamp with time zone not null default statement_timestamp(),
  foreign key (listing_id, user_id)
    references public.listings (id, user_id) on delete cascade,
  check (resolved_at is null or resolved_at >= created_at)
);

comment on table public.ebay_listing_sync_conflicts is
  'Explicit local/provider divergence and ambiguous acknowledgement per listing dimension (issue #169). Never a silent overwrite.';

-- ONE open conflict per listing dimension. A listing that keeps diverging in the
-- same dimension refreshes the open row instead of accumulating a pile the
-- seller cannot act on; resolved rows stay as history.
create unique index ebay_listing_sync_conflicts_open_idx
  on public.ebay_listing_sync_conflicts (user_id, listing_id, field)
  where resolved_at is null;

alter table public.ebay_listing_sync_conflicts enable row level security;

revoke all on table public.ebay_listing_sync_conflicts
  from public, anon, authenticated, service_role;
grant select on table public.ebay_listing_sync_conflicts to authenticated;

create policy ebay_listing_sync_conflicts_select_own
  on public.ebay_listing_sync_conflicts
  for select
  to authenticated
  using ((select public.clerk_user_id()) = user_id);

-- Serialize sync writes with account erasure, matching every other tenant table:
-- an erasure generation and a sync write cannot commit in opposite orders.
create function private.lock_ebay_listing_sync_erasure()
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
    if coalesce(char_length(v_user_id), 0) not between 1 and 255
      or v_user_id !~ '^[A-Za-z0-9_-]+$' then
      raise exception using
        errcode = '22023',
        message = 'Invalid account erasure tenant';
    end if;
    if not pg_try_advisory_xact_lock(
      hashtextextended('account-erasure:' || v_user_id, 0)
    ) then
      -- This statement can hold a snapshot from before the erasure generation
      -- committed. Wait for the eraser, then require a fresh transaction so the
      -- standard fence cannot decide from stale visibility.
      perform private.lock_account_erasure(v_user_id);
      raise exception using
        errcode = '40001',
        message = 'eBay listing sync must retry after account erasure serialization';
    end if;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.lock_ebay_listing_sync_erasure()
  from public, anon, authenticated, service_role;

create trigger zzy_lock_ebay_listing_sync_erasure
  before insert or update or delete on public.ebay_listing_sync_state
  for each row execute function private.lock_ebay_listing_sync_erasure();

create trigger zzz_fence_account_erasure_tenant_mutation
  before insert or update or delete on public.ebay_listing_sync_state
  for each row execute function private.fence_account_erasure_tenant_mutation();

create trigger zzy_lock_ebay_listing_sync_erasure
  before insert or update or delete on public.ebay_listing_sync_conflicts
  for each row execute function private.lock_ebay_listing_sync_erasure();

create trigger zzz_fence_account_erasure_tenant_mutation
  before insert or update or delete on public.ebay_listing_sync_conflicts
  for each row execute function private.fence_account_erasure_tenant_mutation();

-- Everything the sync service compares against, resolved server-side in one
-- read so the fences cannot be assembled from separately-timed queries. The
-- effective price is returned as its two INPUTS (recommendation + override) so
-- the shared TypeScript precedence stays the single implementation.
create or replace function public.read_ebay_listing_sync_authority(
  p_listing_id uuid
)
returns table (
  listing_id uuid,
  ebay_listing_id text,
  ebay_offer_id text,
  ebay_status text,
  marketplace_id text,
  review_revision uuid,
  suggested_price numeric,
  price_override numeric,
  account_generation uuid,
  connection_generation uuid,
  last_event_id text,
  provider_observed_at timestamp with time zone
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_user_id text := public.clerk_user_id();
begin
  if coalesce(auth.jwt()->>'role', '') <> 'authenticated'
    or nullif(v_user_id, '') is null then
    raise exception using errcode = '42501', message = 'Seller authorization is required';
  end if;

  return query
  select
    listing.id,
    listing.ebay_listing_id,
    listing.ebay_offer_id,
    listing.ebay_status,
    -- The marketplace this listing actually went out on: the sync row once one
    -- exists, else the exact binding admitted at publish. 'EBAY_US' is the last
    -- resort for the operator Sandbox fallback, which publishes without a
    -- per-connection binding; it matches the adapter's own env default.
    coalesce(
      sync.marketplace_id,
      nullif(listing.ebay_publish_binding->>'marketplaceId', ''),
      'EBAY_US'
    ),
    item.review_revision,
    (
      select log.price
      from public.prediction_logs log
      where log.item_id = item.id
        and log.user_id = v_user_id
      order by log.created_at desc
      limit 1
    ),
    item.price_override,
    connection.account_generation,
    connection.connection_generation,
    sync.last_event_id,
    sync.provider_observed_at
  from public.listings listing
  join public.items item
    on item.id = listing.item_id
   and item.user_id = listing.user_id
  left join public.ebay_connections connection
    on connection.user_id = listing.user_id
  left join public.ebay_listing_sync_state sync
    on sync.listing_id = listing.id
   and sync.user_id = listing.user_id
  where listing.id = p_listing_id
    and listing.user_id = v_user_id;
end;
$$;

revoke all on function public.read_ebay_listing_sync_authority(uuid)
  from public, anon, service_role;
grant execute on function public.read_ebay_listing_sync_authority(uuid)
  to authenticated;

-- Persist ONE confirmed provider answer. Returns 'applied' or 'superseded';
-- 'superseded' means another writer moved the row between the caller's read and
-- this statement, and the caller must re-read rather than retry blindly.
--
-- Every fence the service already checked is re-checked HERE, against rows
-- locked in this transaction. That duplication is the point: the service reads
-- without a lock, so only this statement can decide.
create or replace function public.apply_ebay_listing_provider_truth(
  p_listing_id uuid,
  p_event_id text,
  p_event_source text,
  p_ebay_listing_id text,
  p_marketplace_id text,
  p_account_generation uuid,
  p_connection_generation uuid,
  p_provider_status text,
  p_provider_price_value numeric,
  p_provider_price_currency text,
  p_provider_quantity integer,
  p_provider_observed_at timestamp with time zone,
  p_expected_review_revision uuid,
  p_expected_last_event_id text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_listing public.listings%rowtype;
  v_review_revision uuid;
  v_account_generation uuid;
  v_connection_generation uuid;
  v_existing public.ebay_listing_sync_state%rowtype;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'authenticated'
    or nullif(v_user_id, '') is null then
    raise exception using errcode = '42501', message = 'Seller authorization is required';
  end if;
  if not private.is_server_api_request() then
    raise exception using errcode = '42501', message = 'Server API authorization is required';
  end if;

  select listing.* into v_listing
  from public.listings listing
  where listing.id = p_listing_id
    and listing.user_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Listing not found';
  end if;

  -- eBay has authority only over a listing a confirmed publish gave it.
  if v_listing.ebay_status is distinct from 'published'
    or nullif(v_listing.ebay_listing_id, '') is null then
    raise exception using
      errcode = 'PT409',
      message = 'eBay is not authoritative for this listing';
  end if;
  if v_listing.ebay_listing_id is distinct from p_ebay_listing_id then
    raise exception using
      errcode = 'PT409',
      message = 'The observation describes a different eBay listing';
  end if;

  select item.review_revision into v_review_revision
  from public.items item
  where item.id = v_listing.item_id
    and item.user_id = v_user_id;
  if v_review_revision is distinct from p_expected_review_revision then
    raise exception using
      errcode = 'PT409',
      message = 'The listing was corrected during eBay sync';
  end if;

  select connection.account_generation, connection.connection_generation
  into v_account_generation, v_connection_generation
  from public.ebay_connections connection
  where connection.user_id = v_user_id;
  if coalesce(v_account_generation, p_account_generation)
    is distinct from p_account_generation then
    raise exception using
      errcode = 'PT409',
      message = 'The eBay account changed during sync';
  end if;
  if v_connection_generation is distinct from p_connection_generation then
    raise exception using
      errcode = 'PT409',
      message = 'The eBay connection changed during sync';
  end if;

  select sync.* into v_existing
  from public.ebay_listing_sync_state sync
  where sync.listing_id = p_listing_id
    and sync.user_id = v_user_id
  for update;

  if found then
    -- Someone else applied an event since the caller read. Their answer may be
    -- newer than this one; only a fresh read can tell.
    if v_existing.last_event_id is distinct from p_expected_last_event_id then
      return 'superseded';
    end if;
    -- Two answers at the same instant carry no evidence of which is newer, so
    -- equality is refused alongside going backwards.
    if v_existing.provider_observed_at >= p_provider_observed_at then
      return 'superseded';
    end if;

    update public.ebay_listing_sync_state sync
    set
      ebay_listing_id = p_ebay_listing_id,
      marketplace_id = p_marketplace_id,
      account_generation = p_account_generation,
      connection_generation = p_connection_generation,
      -- A null status means "this answer said nothing about the lifecycle", so
      -- the last observed status is kept rather than erased.
      provider_status = coalesce(p_provider_status, sync.provider_status),
      provider_price_value = coalesce(p_provider_price_value, sync.provider_price_value),
      provider_price_currency = coalesce(
        p_provider_price_currency, sync.provider_price_currency
      ),
      provider_quantity = coalesce(p_provider_quantity, sync.provider_quantity),
      provider_observed_at = p_provider_observed_at,
      last_event_id = p_event_id,
      last_event_source = p_event_source,
      review_revision = v_review_revision,
      updated_at = statement_timestamp()
    where sync.listing_id = p_listing_id
      and sync.user_id = v_user_id;
    return 'applied';
  end if;

  if p_expected_last_event_id is not null then
    return 'superseded';
  end if;

  insert into public.ebay_listing_sync_state (
    listing_id,
    user_id,
    ebay_listing_id,
    marketplace_id,
    account_generation,
    connection_generation,
    provider_status,
    provider_price_value,
    provider_price_currency,
    provider_quantity,
    provider_observed_at,
    last_event_id,
    last_event_source,
    review_revision
  ) values (
    p_listing_id,
    v_user_id,
    p_ebay_listing_id,
    p_marketplace_id,
    p_account_generation,
    p_connection_generation,
    p_provider_status,
    p_provider_price_value,
    p_provider_price_currency,
    p_provider_quantity,
    p_provider_observed_at,
    p_event_id,
    p_event_source,
    v_review_revision
  );
  return 'applied';
end;
$$;

revoke all on function public.apply_ebay_listing_provider_truth(
  uuid, text, text, text, text, uuid, uuid, text, numeric, text, integer,
  timestamp with time zone, uuid, text
) from public, anon, service_role;
grant execute on function public.apply_ebay_listing_provider_truth(
  uuid, text, text, text, text, uuid, uuid, text, numeric, text, integer,
  timestamp with time zone, uuid, text
) to authenticated;

-- Record ONE divergence. Re-opening the same dimension refreshes the open row:
-- a listing that keeps diverging is one unresolved problem, not a growing pile.
create or replace function public.open_ebay_listing_sync_conflict(
  p_listing_id uuid,
  p_kind text,
  p_field text,
  p_ebay_listing_id text,
  p_local_value text,
  p_provider_value text,
  p_observed_at timestamp with time zone,
  p_expected_review_revision uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_listing public.listings%rowtype;
  v_review_revision uuid;
  v_conflict_id uuid;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'authenticated'
    or nullif(v_user_id, '') is null then
    raise exception using errcode = '42501', message = 'Seller authorization is required';
  end if;
  if not private.is_server_api_request() then
    raise exception using errcode = '42501', message = 'Server API authorization is required';
  end if;

  select listing.* into v_listing
  from public.listings listing
  where listing.id = p_listing_id
    and listing.user_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Listing not found';
  end if;
  if v_listing.ebay_status is distinct from 'published'
    or v_listing.ebay_listing_id is distinct from p_ebay_listing_id then
    raise exception using
      errcode = 'PT409',
      message = 'eBay is not authoritative for this listing';
  end if;

  select item.review_revision into v_review_revision
  from public.items item
  where item.id = v_listing.item_id
    and item.user_id = v_user_id;
  if v_review_revision is distinct from p_expected_review_revision then
    raise exception using
      errcode = 'PT409',
      message = 'The listing was corrected during eBay sync';
  end if;

  insert into public.ebay_listing_sync_conflicts (
    user_id,
    listing_id,
    kind,
    field,
    ebay_listing_id,
    local_value,
    provider_value,
    observed_at,
    review_revision
  ) values (
    v_user_id,
    p_listing_id,
    p_kind,
    p_field,
    p_ebay_listing_id,
    p_local_value,
    p_provider_value,
    p_observed_at,
    v_review_revision
  )
  on conflict (user_id, listing_id, field) where resolved_at is null
  do update set
    kind = excluded.kind,
    ebay_listing_id = excluded.ebay_listing_id,
    local_value = excluded.local_value,
    provider_value = excluded.provider_value,
    observed_at = excluded.observed_at,
    review_revision = excluded.review_revision
  returning id into v_conflict_id;

  return v_conflict_id;
end;
$$;

revoke all on function public.open_ebay_listing_sync_conflict(
  uuid, text, text, text, text, text, timestamp with time zone, uuid
) from public, anon, service_role;
grant execute on function public.open_ebay_listing_sync_conflict(
  uuid, text, text, text, text, text, timestamp with time zone, uuid
) to authenticated;

-- Erasure deletes provider-truth copies and conflict history with the tenant.
-- The listing FK already cascades, but erasure removes the account generation
-- before listings, so the explicit delete keeps completion proof honest.
create function private.delete_ebay_listing_sync_for_erasure()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('app.account_erasure_internal', 'true', true);
  delete from public.ebay_listing_sync_conflicts where user_id = new.user_id;
  delete from public.ebay_listing_sync_state where user_id = new.user_id;
  perform set_config('app.account_erasure_internal', 'false', true);
  return new;
end;
$$;

revoke all on function private.delete_ebay_listing_sync_for_erasure()
  from public, anon, authenticated, service_role;

create trigger delete_ebay_listing_sync_for_erasure
  after insert on private.account_erasure_generations
  for each row execute function private.delete_ebay_listing_sync_for_erasure();

-- Keep account-erasure completion proof exhaustive after adding these tenant
-- tables. This is the latest prior definition plus the two sync tables.
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
