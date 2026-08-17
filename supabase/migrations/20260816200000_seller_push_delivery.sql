-- Issue #891. Sending the push, without widening what can read a seller's phone.
--
-- #890 stored the address and made one asymmetry the whole point of the grant:
-- `service_role` may DELETE from `public.device_tokens` and may not SELECT from
-- it. Delete is what lets a sender clear an address Apple reports as dead.
-- Select would let anything holding the server key enumerate every seller's
-- push address, which is exactly the property that grant was written to deny.
--
-- So the sender does not read the table. It calls a function that runs as the
-- table's owner and answers for one named seller only. The tenant that function
-- answers for is resolved in one place below, and a caller that carries a
-- seller session can never name a different one.
--
-- The second thing this migration owns is replay. A push is an outbound side
-- effect, and the failure a seller actually notices is being told twice about
-- one listing. The claim is a row, written before anything is sent, so a
-- redelivered queue message, a retried worker attempt, a recovered run, and a
-- replayed publish all find the moment already taken.

-- Which APNs environment a device belongs to is not the server's choice. It is
-- decided by the `aps-environment` entitlement of the build that registered the
-- token, so a handset running a development build and the same handset running
-- the App Store build are two different addresses on two different hosts. One
-- auth key serves both, which means the host is picked per device at send time;
-- a token posted to the wrong host is accepted and then quietly dropped, which
-- is the failure that looks green everywhere and dead on the phone.
--
-- There is no safe default, so the column does not keep one. `production` would
-- mis-route every token registered by the dev-signed builds this is about to be
-- tested on; `sandbox` would do the same to the first shipped build. A guess
-- that is wrong half the time is worse than a required field, because the wrong
-- half fails silently. Registration supplies it or registration fails.
--
-- The default below exists for the length of two statements and is a backfill,
-- not a guess: every token registered before this migration came from a
-- dev-signed build, which is a fact about which builds exist rather than an
-- assumption about which might. Adding a defaulted column is metadata-only in
-- Postgres 11 and later, so this neither rewrites the table nor fires the
-- erasure triggers that an `update` over the same rows would.
alter table public.device_tokens
  add column apns_environment text not null default 'sandbox'
    check (apns_environment in ('sandbox', 'production'));

alter table public.device_tokens
  alter column apns_environment drop default;

comment on column public.device_tokens.apns_environment is
  'Issue #891: the APNs host this token is addressable on, as reported by the registering build''s aps-environment entitlement. Never inferred server-side, and never defaulted.';

create table private.seller_push_deliveries (
  user_id text not null
    check (user_id <> '' and char_length(user_id) <= 255),
  -- The two launch moments, named the way the existing activity feed names
  -- them. A third moment is an explicit non-goal of #891, so the check is a
  -- closed list rather than free text.
  moment text not null check (moment in ('listing_ready', 'listing_published')),
  -- What makes this moment one moment. The pipeline path passes the run id,
  -- which a retry and a recovery both preserve; the publish path passes the
  -- confirmed eBay listing id, so two publishes that resolve to one external
  -- result are one announcement.
  event_key text not null
    check (event_key <> '' and char_length(event_key) <= 255),
  announced_at timestamptz not null default statement_timestamp(),
  primary key (user_id, moment, event_key)
);

comment on table private.seller_push_deliveries is
  'Issue #891: one row per seller-facing push moment already claimed. Written before the send, so a lost push is possible and a duplicate is not.';

alter table private.seller_push_deliveries enable row level security;

-- No direct grant to anybody. Every path into this table is a function below.
revoke all on table private.seller_push_deliveries
  from public, anon, authenticated, service_role;

-- The one place the sender's tenant is decided.
--
-- Two callers reach these functions and they are trusted differently. The
-- worker holds no seller session at all: it derived this id from the stored
-- run, the way the rest of the pipeline derives ownership, and there is nothing
-- else to check it against. The publish path runs on the seller's own session
-- through the server-guarded client, and a session is a stronger statement than
-- an argument, so the argument has to agree with it. Without that comparison,
-- one seller's request could name another seller's tenant and clear or claim
-- against it.
create function private.resolve_seller_push_tenant(p_user_id text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_subject text;
begin
  if not private.is_server_api_request() then
    raise exception using
      errcode = '42501',
      message = 'Seller push requires a SnapList server request';
  end if;

  if p_user_id is null
    or coalesce(char_length(p_user_id), 0) not between 1 and 255
    or p_user_id !~ '^[A-Za-z0-9_-]+$' then
    raise exception using
      errcode = '22023',
      message = 'Invalid seller push tenant';
  end if;

  -- `public.clerk_user_id()` answers with the empty string, not null, when the
  -- request carries no session. Treating '' as a subject would compare every
  -- sessionless worker call against a tenant it can never equal.
  v_subject := nullif(public.clerk_user_id(), '');
  if v_subject is not null and v_subject <> p_user_id then
    raise exception using
      errcode = '42501',
      message = 'Seller push tenant does not match the caller';
  end if;

  return p_user_id;
end;
$$;

revoke all on function private.resolve_seller_push_tenant(text)
  from public, anon, authenticated, service_role;

-- Takes the moment, or reports that somebody already has it.
--
-- `on conflict do nothing` plus `returning` is the whole guard: the insert is
-- the claim, and only the statement that actually wrote a row gets one back.
-- Two concurrent senders therefore cannot both believe they won, because the
-- primary key serialises them in the database rather than in application code.
create function public.claim_seller_push_delivery(
  p_user_id text,
  p_moment text,
  p_event_key text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := private.resolve_seller_push_tenant(p_user_id);
  v_claimed boolean;
begin
  insert into private.seller_push_deliveries (user_id, moment, event_key)
  values (v_user_id, p_moment, p_event_key)
  on conflict (user_id, moment, event_key) do nothing
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

revoke all on function public.claim_seller_push_delivery(text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_seller_push_delivery(text, text, text)
  to authenticated, service_role;

-- Where one seller's phone is.
--
-- This is the entire tenancy boundary of #891. It is `security definer` so it
-- can read a table `service_role` deliberately cannot, and it takes a tenant
-- rather than a predicate so there is no shape of call that returns two
-- sellers' rows. Newest device first, because `last_seen_at` is the only signal
-- #890 recorded about which handset the seller still uses.
create function public.seller_push_device_tokens(p_user_id text)
returns table (platform text, token text, apns_environment text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id text := private.resolve_seller_push_tenant(p_user_id);
begin
  return query
    select device.platform, device.token, device.apns_environment
    from public.device_tokens device
    where device.user_id = v_user_id
    order by device.last_seen_at desc, device.token;
end;
$$;

revoke all on function public.seller_push_device_tokens(text)
  from public, anon, authenticated, service_role;
grant execute on function public.seller_push_device_tokens(text)
  to authenticated, service_role;

-- Removes an address Apple says is gone.
--
-- Scoped to the resolved tenant and to the exact device, so the worst a wrong
-- argument can do is delete a row the caller was already allowed to be told
-- about. A reinstalled app registers a new token; without this, the old row
-- would sit here forever being sent to and failing.
create function public.forget_seller_push_device_token(
  p_user_id text,
  p_platform text,
  p_token text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := private.resolve_seller_push_tenant(p_user_id);
  v_deleted boolean;
begin
  delete from public.device_tokens
  where user_id = v_user_id
    and platform = p_platform
    and token = p_token
  returning true into v_deleted;

  return coalesce(v_deleted, false);
end;
$$;

revoke all on function public.forget_seller_push_device_token(text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.forget_seller_push_device_token(text, text, text)
  to authenticated, service_role;

-- A claim write can start before begin_account_erasure commits. Take the same
-- per-tenant lock first so begin waits for that write, then its insert trigger
-- deletes the now-visible rows. `zzy_` sorts immediately before the standard
-- `zzz_` fence, preserving the fence as the last BEFORE trigger. Same shape as
-- the registration lock #890 installed on `device_tokens`, for the same race.
create function private.lock_seller_push_delivery_erasure()
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
      perform private.lock_account_erasure(v_user_id);
      raise exception using
        errcode = '40001',
        message = 'Seller push delivery must retry after account erasure serialization';
    end if;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.lock_seller_push_delivery_erasure()
  from public, anon, authenticated, service_role;

create trigger zzy_lock_seller_push_delivery_erasure
  before insert or update or delete on private.seller_push_deliveries
  for each row execute function private.lock_seller_push_delivery_erasure();

-- A claim names a tenant, so it is tenant data. Once erasure begins, nothing
-- may recreate it while the erasure capability is proving absence.
create trigger zzz_fence_account_erasure_tenant_mutation
  before insert or update or delete on private.seller_push_deliveries
  for each row execute function private.fence_account_erasure_tenant_mutation();

-- Claims have no independent deferral. Delete them while begin_account_erasure
-- holds the tenant lock, before any later advance call asks the counted proof
-- to reach zero.
create function private.delete_seller_push_deliveries_for_erasure()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('app.account_erasure_internal', 'true', true);
  delete from private.seller_push_deliveries
  where user_id = new.user_id;
  perform set_config('app.account_erasure_internal', 'false', true);
  return new;
end;
$$;

revoke all on function private.delete_seller_push_deliveries_for_erasure()
  from public, anon, authenticated, service_role;

create trigger delete_seller_push_deliveries_for_erasure
  after insert on private.account_erasure_generations
  for each row execute function private.delete_seller_push_deliveries_for_erasure();

-- A guest who claims an account keeps their moments with them, for the same
-- reason #890 re-keys the device row: the claims left behind would name an
-- identity nothing reads again, and the counted erasure proof for the guest
-- would never reach zero. A claim already held under the surviving identity
-- wins, because it means that moment was already announced.
create function private.rekey_seller_push_deliveries_for_guest_claim()
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

  delete from private.seller_push_deliveries guest
  where guest.user_id = new.guest_user_id
    and exists (
      select 1
      from private.seller_push_deliveries owned
      where owned.user_id = new.claim_target_user_id
        and owned.moment = guest.moment
        and owned.event_key = guest.event_key
    );

  update private.seller_push_deliveries
  set user_id = new.claim_target_user_id
  where user_id = new.guest_user_id;

  return null;
end;
$$;

revoke all on function private.rekey_seller_push_deliveries_for_guest_claim()
  from public, anon, authenticated, service_role;

drop trigger if exists rekey_seller_push_deliveries_for_guest_claim
  on private.guest_draft_recoveries;

create trigger rekey_seller_push_deliveries_for_guest_claim
  after update on private.guest_draft_recoveries
  for each row
  when (new.state = 'claimed' and old.state is distinct from 'claimed')
  execute function private.rekey_seller_push_deliveries_for_guest_claim();

-- Keep the completion proof exhaustive after adding this tenant table. This is
-- the latest definition from #890 plus seller_push_deliveries.
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
    union all select count(*)::integer from private.seller_push_deliveries where user_id = p_user_id
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
