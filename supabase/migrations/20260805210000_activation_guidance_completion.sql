-- Issue #566. One monotonic completion marker for the signed-in seller's
-- first-listing activation guidance. The client may opt out, but it can never
-- write, read, reset, or replay another seller's marker.
create table public.activation_guidance_completions (
  user_id text primary key,
  completed_at timestamp with time zone not null default statement_timestamp()
);

comment on table public.activation_guidance_completions is
  'Tenant-scoped, monotonic completion marker for first-listing activation guidance.';

alter table public.activation_guidance_completions enable row level security;

revoke all on table public.activation_guidance_completions
  from public, anon, authenticated, service_role;
grant select, insert on table public.activation_guidance_completions to authenticated;
grant delete on table public.activation_guidance_completions to service_role;

create policy activation_guidance_completions_select_own
  on public.activation_guidance_completions
  for select
  to authenticated
  using ((select public.clerk_user_id()) = user_id);

create policy activation_guidance_completions_insert_own
  on public.activation_guidance_completions
  for insert
  to authenticated
  with check ((select public.clerk_user_id()) = user_id);

-- A completion insert can start before begin_account_erasure commits. Take the
-- same per-tenant lock first so begin waits for that insert, then its insert
-- trigger deletes the now-visible marker. `zzy_` sorts immediately before the
-- standard `zzz_` fence, preserving the fence as the last BEFORE trigger.
create function private.lock_activation_guidance_completion_erasure()
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
        message = 'Activation completion must retry after account erasure serialization';
    end if;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.lock_activation_guidance_completion_erasure()
  from public, anon, authenticated, service_role;

create trigger zzy_lock_activation_guidance_completion_erasure
  before insert or update or delete on public.activation_guidance_completions
  for each row execute function private.lock_activation_guidance_completion_erasure();

-- Completion is tenant data. Once erasure begins, ordinary writers must not be
-- able to recreate it while the erasure capability is proving absence.
create trigger zzz_fence_account_erasure_tenant_mutation
  before insert or update or delete on public.activation_guidance_completions
  for each row execute function private.fence_account_erasure_tenant_mutation();

-- The marker has no independent deferral. Delete it while begin_account_erasure
-- holds the tenant lock, before any later advance call asks the counted proof to
-- reach zero. The internal bypass is closed in the same trigger invocation.
create function private.delete_activation_guidance_completion_for_erasure()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('app.account_erasure_internal', 'true', true);
  delete from public.activation_guidance_completions
  where user_id = new.user_id;
  perform set_config('app.account_erasure_internal', 'false', true);
  return new;
end;
$$;

revoke all on function private.delete_activation_guidance_completion_for_erasure()
  from public, anon, authenticated, service_role;

create trigger delete_activation_guidance_completion_for_erasure
  after insert on private.account_erasure_generations
  for each row execute function private.delete_activation_guidance_completion_for_erasure();

-- Keep the completion proof exhaustive after adding this tenant table. This is
-- the latest definition from #610 plus activation_guidance_completions.
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
