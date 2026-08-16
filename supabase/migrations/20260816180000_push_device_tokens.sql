-- Issue #890. Where a seller's phone is reachable, and nothing else.
--
-- This table stores an address, not a message. Nothing here sends a push; the
-- sender issue owns APNs and what a notification says.
--
-- The identity shape is the whole security decision. A device token is globally
-- unique to a phone, so the obvious schema — `token` as the primary key — would
-- make the ordinary "this device registered again" write an UPDATE of whatever
-- row already holds that token, including another seller's. RLS can refuse that
-- write, but only by turning a legitimate re-registration into a key collision
-- the client cannot resolve. Keying on `(user_id, platform, token)` instead
-- means one tenant's registration can never name another tenant's row at all:
-- two accounts on one handset hold two rows, each invisible to the other, and
-- the leak has no expressible form rather than a policy standing against it.
--
-- The one identity move that is legitimate — a guest who claims an account —
-- is not a client write. It happens below, inside the claim, where the guest
-- and target subjects both come from the recovery record.
create table public.device_tokens (
  user_id text not null default public.clerk_user_id()
    check (user_id <> '' and char_length(user_id) <= 255),
  platform text not null check (platform in ('ios')),
  -- APNs hands back 32 bytes today, rendered as 64 lowercase hex characters,
  -- and Apple has never promised that length. The floor is what Apple issues
  -- now; the ceiling is a bound on what a client may store, not a claim about
  -- Apple's format. Length is checked separately because a POSIX bound above
  -- 255 is not a repetition count Postgres will compile.
  token text not null
    check (token ~ '^[0-9a-f]+$' and char_length(token) between 64 and 512),
  last_seen_at timestamptz not null default statement_timestamp(),
  created_at timestamptz not null default statement_timestamp(),
  primary key (user_id, platform, token)
);

comment on table public.device_tokens is
  'Issue #890: tenant-scoped push registration. One row per (seller, platform, device). Stores where a push could be delivered; never sends one.';
comment on column public.device_tokens.last_seen_at is
  'Advanced every time the same device registers again, so a later sender can prefer a device the seller still uses.';

alter table public.device_tokens enable row level security;

revoke all on table public.device_tokens
  from public, anon, authenticated, service_role;
grant select, insert, update on table public.device_tokens to authenticated;
-- Delete belongs to the account-erasure capability the retention matrix names
-- as executor, not to the client. A seller who refuses notifications is
-- recorded on the device; removing the row is erasure's job.
grant delete on table public.device_tokens to service_role;

create policy device_tokens_select_own
  on public.device_tokens
  for select
  to authenticated
  using ((select public.clerk_user_id()) = user_id);

create policy device_tokens_insert_own
  on public.device_tokens
  for insert
  to authenticated
  with check ((select public.clerk_user_id()) = user_id);

-- Both halves, deliberately. `using` keeps a caller from naming a row it does
-- not own; `with check` keeps a caller from pushing a row it does own into
-- somebody else's tenant. Omitting the second is the version of this policy
-- that reads correct and hands one seller's device to another.
create policy device_tokens_update_own
  on public.device_tokens
  for update
  to authenticated
  using ((select public.clerk_user_id()) = user_id)
  with check ((select public.clerk_user_id()) = user_id);

-- A registration write can start before begin_account_erasure commits. Take the
-- same per-tenant lock first so begin waits for that write, then its insert
-- trigger deletes the now-visible rows. `zzy_` sorts immediately before the
-- standard `zzz_` fence, preserving the fence as the last BEFORE trigger.
create function private.lock_device_token_erasure()
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
      -- The statement snapshot may predate the erasure generation that held
      -- this lock. Wait for the owner, then force a fresh statement/transaction
      -- instead of letting the standard fence decide from that stale snapshot.
      perform private.lock_account_erasure(v_user_id);
      raise exception using
        errcode = '40001',
        message = 'Device token registration must retry after account erasure serialization';
    end if;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.lock_device_token_erasure()
  from public, anon, authenticated, service_role;

create trigger zzy_lock_device_token_erasure
  before insert or update or delete on public.device_tokens
  for each row execute function private.lock_device_token_erasure();

-- A device token is tenant data. Once erasure begins, ordinary writers must not
-- be able to recreate it while the erasure capability is proving absence.
create trigger zzz_fence_account_erasure_tenant_mutation
  before insert or update or delete on public.device_tokens
  for each row execute function private.fence_account_erasure_tenant_mutation();

-- Registrations have no independent deferral. Delete them while
-- begin_account_erasure holds the tenant lock, before any later advance call
-- asks the counted proof to reach zero. The internal bypass is closed in the
-- same trigger invocation.
create function private.delete_device_tokens_for_erasure()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('app.account_erasure_internal', 'true', true);
  delete from public.device_tokens
  where user_id = new.user_id;
  perform set_config('app.account_erasure_internal', 'false', true);
  return new;
end;
$$;

revoke all on function private.delete_device_tokens_for_erasure()
  from public, anon, authenticated, service_role;

create trigger delete_device_tokens_for_erasure
  after insert on private.account_erasure_generations
  for each row execute function private.delete_device_tokens_for_erasure();

-- A guest registers on the same handset the account will later use. Without
-- this the guest's row would sit under an identity nothing reads again — a
-- token SnapList holds, cannot deliver to, and never deletes.
--
-- The move runs here rather than in the client's own upsert because only this
-- side knows both subjects: the claim record names the guest it came from and
-- the account it went to. A client asserting the same pair would be asserting
-- authority over a tenant it does not hold.
create function private.rekey_device_tokens_for_guest_claim()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state is distinct from 'claimed'
    or old.state is not distinct from 'claimed'
    or new.claim_target_user_id is null
    or new.guest_user_id is null
    or new.claim_target_user_id = new.guest_user_id then
    return null;
  end if;

  -- The account may already carry this handset from an earlier signed-in
  -- session. That row is the same physical device under the identity that
  -- survives, so the guest's duplicate is dropped rather than re-keyed into a
  -- primary key collision that would fail the whole claim.
  delete from public.device_tokens guest
  where guest.user_id = new.guest_user_id
    and exists (
      select 1
      from public.device_tokens owned
      where owned.user_id = new.claim_target_user_id
        and owned.platform = guest.platform
        and owned.token = guest.token
    );

  update public.device_tokens
  set user_id = new.claim_target_user_id
  where user_id = new.guest_user_id;

  return null;
end;
$$;

revoke all on function private.rekey_device_tokens_for_guest_claim()
  from public, anon, authenticated, service_role;

drop trigger if exists rekey_device_tokens_for_guest_claim
  on private.guest_draft_recoveries;

create trigger rekey_device_tokens_for_guest_claim
  after update on private.guest_draft_recoveries
  for each row
  when (new.state = 'claimed' and old.state is distinct from 'claimed')
  execute function private.rekey_device_tokens_for_guest_claim();

-- A device that changes hands.
--
-- An APNs token addresses one physical device, so two live accounts cannot both
-- be reachable at it. The composite key makes a cross-tenant *write*
-- unrepresentable, but that is a different property from cross-tenant
-- *delivery*: without this, a seller who signs out leaves a working address for
-- a phone that is no longer theirs, and no client can clear it because
-- `authenticated` holds no delete grant. A sender would then post one seller's
-- listing to another seller's lock screen.
--
-- Security definer because the row being removed belongs to the previous
-- holder, which the new holder cannot see under RLS and must not be able to
-- enumerate. It learns the token from the row being written, so it can only
-- ever clear an address the caller's own device already answers to.
create or replace function private.claim_device_token_for_current_holder()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  delete from public.device_tokens
  where platform = new.platform
    and token = new.token
    and user_id <> new.user_id;

  return new;
end;
$$;

revoke all on function private.claim_device_token_for_current_holder()
  from public, anon, authenticated, service_role;

-- Named to sort before `zzy_`/`zzz_`, so the erasure lock and the tenant fence
-- still get the last word: if either raises, this delete rolls back with the
-- rest of the statement.
drop trigger if exists claim_device_token_for_current_holder
  on public.device_tokens;

create trigger claim_device_token_for_current_holder
  before insert on public.device_tokens
  for each row execute function private.claim_device_token_for_current_holder();

-- Keep the completion proof exhaustive after adding this tenant table. This is
-- the latest definition from #799 plus device_tokens.
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
    union all select count(*)::integer from public.device_tokens where user_id = p_user_id
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
