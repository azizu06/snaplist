-- Issue #586: cover the included-offer tenant tables in account erasure.
--
-- #524 (migration 20260731190000) and #384 (migration 20260801120000) were both
-- green on their own branches and neither could see the other. Once both were on
-- `main`, `public.included_offer_device_claims` and
-- `public.included_offer_support_overrides` were tenant tables that erasure did
-- not fence, did not count, and did not delete: a write could land while an
-- account was mid-erasure, and `advance_account_erasure` could report a finished
-- deletion with those rows still present. The catalog-derived guard in
-- supabase/tests/account_erasure.test.sql caught it exactly as its comment said
-- it would, and `main` has been red on the `database` job since.
--
-- Both source migrations are deployed, so neither is edited. This one re-states
-- the two functions in full — that is what `create or replace` costs for a
-- monolithic pl/pgsql body — and adds the trigger through the same array-driven
-- loop the original installation used, so both tables carry the same trigger
-- name and the same fence function as every other tenant table rather than a
-- hand-written one-off.
--
-- Disposition: both rows are DELETED, not retained. See the reasoning recorded
-- with the behavioural assertions in supabase/tests/account_erasure.test.sql.
-- In short: #524 requires both to carry the verified Clerk `user_id` under
-- tenant RLS and already grants `delete` on both to service_role naming account
-- erasure as the executor; the completion proof counts every fenced table, so a
-- retained row would strand every erasure at "Mandatory account erasure work is
-- incomplete"; and deleting them weakens nothing, because the lifetime device
-- fence is Apple's DeviceCheck bit0, which SnapList never clears.
--
-- Out of scope, deliberately: an `included_offer_redemption` queue message for a
-- deleted claim is left alone. Its payload carries only the claim identity, no
-- tenant identifier, so the coverage guard does not reach it; there is no worker
-- consuming that queue yet, so nothing can spin on it; and draining it would
-- change #524's redemption flow, which #586 excludes.

-- The `zzz_` prefix is load-bearing exactly as it is in 20260801120000: row
-- triggers fire in name order, so the fence runs after every other BEFORE
-- trigger and account-erasure:<seller> stays the last seller-scoped lock any
-- mutation path takes. `included_offer_device_claims_enforce_transition` sorts
-- before it, so that ordering still holds on these two tables.
do $account_erasure_included_offer_triggers$
declare
  v_table text;
begin
  foreach v_table in array array[
    'public.included_offer_device_claims',
    'public.included_offer_support_overrides'
  ] loop
    execute format(
      'create trigger zzz_fence_account_erasure_tenant_mutation '
        || 'before insert or update or delete on %s for each row '
        || 'execute function private.fence_account_erasure_tenant_mutation()',
      v_table::regclass
    );
  end loop;
end
$account_erasure_included_offer_triggers$;

-- The completion proof. Unchanged from 20260801120000 except for the two
-- included-offer counts; the guard in account_erasure.test.sql reads this
-- function's source text, so the table names have to appear here literally.
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

-- The deletion pass. Unchanged from 20260801120000 except for the two
-- included-offer deletes.
create or replace function public.advance_account_erasure(p_generation_id uuid)
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
  -- Included-offer rows (migration 20260731190000, issue #524). The override
  -- goes first: its `claim_id` references the claim with `on delete set null`,
  -- and both land before `public.pipeline_runs`, which the claim references the
  -- same way. Neither order is observable today — `app.account_erasure_internal`
  -- is already true here, so a cascading `set null` passes the fence and the
  -- claim-transition trigger alike — so no assertion can hold this line. It is
  -- written parent-last anyway, because the day one of those references becomes
  -- `on delete restrict`, or the bypass narrows, the wrong order fails an
  -- erasure in production rather than in a test.
  delete from public.included_offer_support_overrides where user_id = v_generation.user_id;
  delete from public.included_offer_device_claims where user_id = v_generation.user_id;

  delete from public.pipeline_run_history_order_versions where user_id = v_generation.user_id;
  delete from public.pipeline_runs where user_id = v_generation.user_id;
  -- Assisted-export receipts (migration 20260731040000) cascade from both
  -- `listings` and `items`. This statement runs before either parent is gone,
  -- so it removes the rows itself rather than watching a cascade remove them —
  -- it changes no outcome, only where the guarantee lives. Do not delete it as
  -- redundant. The completion proof now COUNTS these receipts, and it counts
  -- them `where user_id = …`, which is the predicate below. Leaving the removal
  -- to foreign keys declared in another migration would mean two things: a
  -- later change to those keys fails no test here, and a receipt whose
  -- denormalized `user_id` is this tenant while its item belongs to another is
  -- counted but never reached by any cascade. Either one strands every erasure
  -- at "Mandatory account erasure work is incomplete" with no way to finish.
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
