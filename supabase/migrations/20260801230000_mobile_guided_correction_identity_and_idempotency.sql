-- Issue #597: the native guided identity correction writes a COHERENT review,
-- and pays for provider work at most once per seller intent.
--
-- Two defects, one migration, because they are the same seam.
--
-- 1. `sharpen_review_estimate` was built for the web "Sharpen the estimate",
--    which only ever added discriminating SPECS — the identity never moved, so
--    `items.identification` stayed true and the RPC never had to write it. The
--    native seam also accepts a seller-confirmed identity, and
--    `get_mobile_listing_review` projects `items.identification` verbatim into
--    the client's `identity.label` / `identity.confident`. Writing only
--    `attributes` therefore left the seller looking at the identity they had
--    just replaced. `regenerate_review_listing` — the web path that DID move
--    identity — has always written the column; this brings the sharpen path in
--    line with it rather than inventing a second rule.
--
--    `p_identification` is optional and applied with `coalesce`, so a
--    specs-only correction still leaves the vision step's identification alone.
--
-- 2. The native route spends real pricing-provider budget on a POST that
--    carried neither an Idempotency-Key nor a rate limit. Two requests holding
--    the same `expectedReviewRevision` both cleared the pre-check, both ran the
--    PriceRouter, and one lost the RPC's revision guard — its provider spend
--    paid for and discarded. `private.mobile_guided_corrections` is the same
--    durable claim `private.mobile_listing_review_saves` gives PUT /review:
--    one pending lease per intent, a stored receipt for replay, and an
--    in-progress answer for a competing correction on the same revision.
--
--    Unlike its sibling this row holds NO recovery state — only a throttle and
--    a receipt cache. The durable authority stays `items.review_revision`.
--    That is why there is no guest-claim transfer trigger here: a claim row
--    stranded under a pre-claim guest id cannot make a later write wrong, it
--    can only fail to dedupe one correction across the account claim itself.

-- ---------------------------------------------------------------------------
-- 1. The identity write
-- ---------------------------------------------------------------------------

-- Recreating rather than replacing: `create or replace function` cannot change
-- a signature, and adding an overload would make every existing named-argument
-- call ambiguous. `p_identification` is appended with a default so the callers
-- that legitimately pass fourteen arguments keep resolving.
drop function public.sharpen_review_estimate(
  uuid, uuid, uuid, jsonb, numeric, jsonb, numeric, text, text, text, text, jsonb,
  boolean, boolean
);

create or replace function public.sharpen_review_estimate(
  p_item_id uuid,
  p_expected_review_revision uuid,
  p_run_id uuid,
  p_attributes jsonb,
  p_price numeric,
  p_price_range jsonb,
  p_confidence numeric,
  p_tier_fired text,
  p_model text,
  p_listing_model text,
  p_pricing_model text,
  p_sources jsonb,
  p_autopilot_enabled boolean,
  p_autopilot_eligible boolean,
  p_identification jsonb default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
begin
  if v_user_id is null or v_user_id = '' then
    raise exception using errcode = '42501', message = 'Authentication required.';
  end if;
  if p_expected_review_revision is null or p_run_id is null then
    raise exception using errcode = '22023', message = 'Review revision is required.';
  end if;
  if jsonb_typeof(p_attributes) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Attributes must be an object.';
  end if;
  -- Optional, but never junk: a non-object identification would be projected
  -- straight into the native client's identity panel.
  if p_identification is not null
    and jsonb_typeof(p_identification) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Identification must be an object.';
  end if;
  if p_price is null or p_price <= 0 then
    raise exception using errcode = '22023', message = 'Price is invalid.';
  end if;
  if jsonb_typeof(p_price_range) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Price range must be an object.';
  end if;
  if p_confidence is null or p_confidence < 0 or p_confidence > 1 then
    raise exception using errcode = '22023', message = 'Confidence is invalid.';
  end if;
  if p_tier_fired is null or btrim(p_tier_fired) = '' then
    raise exception using errcode = '22023', message = 'Pricing tier is required.';
  end if;
  if p_model is null or btrim(p_model) = '' then
    raise exception using errcode = '22023', message = 'Model provenance is required.';
  end if;
  if jsonb_typeof(p_sources) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Sources must be an array.';
  end if;

  update public.items
  set attributes = p_attributes,
      identification = coalesce(p_identification, identification),
      review_revision = p_run_id,
      review_content_revision = p_run_id
  where id = p_item_id
    and user_id = v_user_id
    and review_revision is not distinct from p_expected_review_revision;
  if not found then
    raise exception using errcode = 'P0002', message = 'Review changed. Reload and try again.';
  end if;

  perform 1
  from public.listings
  where item_id = p_item_id
    and user_id = v_user_id
    and platform = 'ebay'
  for update;

  if exists (
    select 1
    from public.listings
    where item_id = p_item_id
      and user_id = v_user_id
      and platform = 'ebay'
      and (
        status is not distinct from 'published'
        or ebay_listing_id is not null
        or ebay_status is not distinct from 'publishing'
        or ebay_status is not distinct from 'published'
      )
  ) then
    raise exception using errcode = 'P0002', message = 'Editable eBay listing not found.';
  end if;

  insert into public.prediction_logs (
    user_id, item_id, run_id, extracted_attrs, price, price_range, confidence,
    tier_fired, model, listing_model, pricing_model, sources,
    autopilot_enabled, autopilot_eligible
  ) values (
    v_user_id, p_item_id, p_run_id, p_attributes, p_price, p_price_range, p_confidence,
    p_tier_fired, p_model, p_listing_model, p_pricing_model, p_sources,
    p_autopilot_enabled, p_autopilot_eligible
  );

  delete from public.listings
  where item_id = p_item_id
    and user_id = v_user_id
    and platform in ('facebook', 'mercari');
end;
$$;

revoke all on function public.sharpen_review_estimate(
  uuid, uuid, uuid, jsonb, numeric, jsonb, numeric, text, text, text, text, jsonb,
  boolean, boolean, jsonb
) from public, anon, service_role;
grant execute on function public.sharpen_review_estimate(
  uuid, uuid, uuid, jsonb, numeric, jsonb, numeric, text, text, text, text, jsonb,
  boolean, boolean, jsonb
) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The idempotency claim
-- ---------------------------------------------------------------------------

create table private.mobile_guided_corrections (
  user_id text not null,
  idempotency_key uuid not null,
  run_id uuid not null references public.pipeline_runs(id) on delete cascade,
  expected_review_revision uuid not null,
  intent jsonb not null,
  state text not null default 'pending',
  lease_expires_at timestamptz
    default (statement_timestamp() + interval '5 minutes'),
  receipt jsonb,
  primary key (user_id, idempotency_key),
  constraint mobile_guided_correction_intent_check
    check (jsonb_typeof(intent) = 'object'),
  constraint mobile_guided_correction_state_check
    check (state in ('pending', 'completed', 'failed')),
  constraint mobile_guided_correction_lease_check
    check (
      (state = 'pending' and lease_expires_at is not null)
      or (state <> 'pending' and lease_expires_at is null)
    ),
  constraint mobile_guided_correction_receipt_check
    check (
      (state = 'completed' and jsonb_typeof(receipt) = 'object')
      or (state <> 'completed' and receipt is null)
    )
);

revoke all on table private.mobile_guided_corrections
  from public, anon, authenticated;

-- Answers the competing-correction probe without a sequential scan per POST.
create index mobile_guided_corrections_inflight_idx
  on private.mobile_guided_corrections (run_id, expected_review_revision)
  where state = 'pending';

create or replace function public.claim_mobile_guided_correction(
  p_action text,
  p_run_id uuid,
  p_idempotency_key uuid,
  p_expected_review_revision uuid,
  p_intent jsonb,
  p_receipt jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_run public.pipeline_runs%rowtype;
  v_claim private.mobile_guided_corrections%rowtype;
  v_claim_found boolean;
begin
  if coalesce(v_user_id, '') = ''
    or p_action not in ('prepare', 'complete', 'fail')
    or p_run_id is null
    or p_idempotency_key is null
    or p_expected_review_revision is null
    or p_idempotency_key is not distinct from p_expected_review_revision then
    raise exception using
      errcode = '42501',
      message = 'Guided correction authorization is required.';
  end if;
  if jsonb_typeof(p_intent) is distinct from 'object' then
    raise exception using
      errcode = '22023',
      message = 'Guided correction intent is invalid.';
  end if;

  -- Definer rights end at the caller's own tenancy: a run this seller does not
  -- own is never claimable, so the claim can never become a cross-tenant probe.
  select run.* into v_run
  from public.pipeline_runs run
  where run.id = p_run_id
    and run.user_id = v_user_id
  for update;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'This run is unavailable.';
  end if;

  select claim.* into v_claim
  from private.mobile_guided_corrections claim
  where claim.user_id = v_user_id
    and claim.idempotency_key = p_idempotency_key
  for update;
  v_claim_found := found;

  -- Replaying a key against a different correction is a client bug, not a
  -- retry. Answering it with the first correction's receipt would silently
  -- discard the second intent.
  if v_claim_found and (
    v_claim.run_id is distinct from p_run_id
    or v_claim.intent is distinct from p_intent
  ) then
    raise exception using
      errcode = 'P0003',
      message = 'This Idempotency-Key is already bound to a different correction.';
  end if;

  if p_action = 'fail' then
    if not v_claim_found or v_claim.state = 'completed' then
      return jsonb_build_object('state', 'unchanged');
    end if;
    update private.mobile_guided_corrections
    set state = 'failed',
        lease_expires_at = null,
        receipt = null
    where user_id = v_user_id
      and idempotency_key = p_idempotency_key
      and state = 'pending';
    return jsonb_build_object('state', 'failed');
  end if;

  if p_action = 'complete' then
    if not v_claim_found or v_claim.state <> 'pending' then
      raise exception using
        errcode = 'P0002',
        message = 'This review changed. Reload and try again.';
    end if;
    if jsonb_typeof(p_receipt) is distinct from 'object' then
      raise exception using
        errcode = '22023',
        message = 'Guided correction receipt is invalid.';
    end if;
    update private.mobile_guided_corrections
    set state = 'completed',
        lease_expires_at = null,
        receipt = p_receipt
    where user_id = v_user_id
      and idempotency_key = p_idempotency_key;
    return jsonb_build_object('state', 'completed', 'receipt', p_receipt);
  end if;

  -- prepare: the throttle. Every branch below returns BEFORE the application
  -- is allowed to call the pricing provider.
  if v_claim_found and v_claim.state = 'completed' then
    return jsonb_build_object('state', 'completed', 'receipt', v_claim.receipt);
  end if;
  if v_claim_found
    and v_claim.state = 'pending'
    and v_claim.lease_expires_at > statement_timestamp() then
    return jsonb_build_object('state', 'in_progress');
  end if;
  -- A DIFFERENT key already correcting the same revision is the concurrent
  -- case that paid twice: exactly one of them can win the revision guard, so
  -- the other must never reach the router at all.
  if exists (
    select 1
    from private.mobile_guided_corrections competing
    where competing.user_id = v_user_id
      and competing.run_id = p_run_id
      and competing.expected_review_revision = p_expected_review_revision
      and competing.idempotency_key is distinct from p_idempotency_key
      and competing.state = 'pending'
      and competing.lease_expires_at > statement_timestamp()
  ) then
    return jsonb_build_object('state', 'in_progress');
  end if;

  if v_claim_found then
    update private.mobile_guided_corrections
    set state = 'pending',
        expected_review_revision = p_expected_review_revision,
        lease_expires_at = statement_timestamp() + interval '5 minutes',
        receipt = null
    where user_id = v_user_id
      and idempotency_key = p_idempotency_key;
  else
    insert into private.mobile_guided_corrections (
      user_id,
      idempotency_key,
      run_id,
      expected_review_revision,
      intent
    ) values (
      v_user_id,
      p_idempotency_key,
      p_run_id,
      p_expected_review_revision,
      p_intent
    );
  end if;

  return jsonb_build_object('state', 'proceed');
end;
$$;

revoke all on function public.claim_mobile_guided_correction(
  text, uuid, uuid, uuid, jsonb, jsonb
) from public, anon, service_role;
grant execute on function public.claim_mobile_guided_correction(
  text, uuid, uuid, uuid, jsonb, jsonb
) to authenticated;

-- ---------------------------------------------------------------------------
-- Account-erasure coverage for the new tenant table.
--
-- `private.mobile_guided_corrections` carries a `user_id`, so it is tenant data
-- and `supabase/tests/account_erasure.test.sql` derives it into the erasure
-- scope automatically. Two things have to be true for it, exactly as they are
-- for `private.mobile_listing_review_saves`, the claim table this one mirrors:
-- erasure must REFUSE a write to it once deletion has been promised, and the
-- completion proof must COUNT it.
--
-- The delete below is not redundant with `run_id … on delete cascade`, and
-- 20260801120000 already argued why for `public.export_handoffs`: the count is
-- `where user_id = p_user_id` while the cascade travels through `run_id`. A row
-- whose denormalized `user_id` is this tenant is counted by a predicate no
-- foreign key participates in, so leaving removal to a key declared elsewhere
-- would let a later change to that key strand every erasure at "Mandatory
-- account erasure work is incomplete" with nothing here failing.
-- ---------------------------------------------------------------------------

-- `zzz_` is load-bearing: row triggers fire in name order, so the fence runs
-- after every other BEFORE trigger and account-erasure:<seller> stays the last
-- seller-scoped lock any mutation path takes.
create trigger zzz_fence_account_erasure_tenant_mutation
  before insert or update or delete on private.mobile_guided_corrections
  for each row execute function private.fence_account_erasure_tenant_mutation();

-- The completion proof. Unchanged from 20260801200000 except for the one new
-- count; the guard in account_erasure.test.sql reads this function's source
-- text, so the table name has to appear here literally.
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
    union all select count(*)::integer from private.mobile_guided_corrections where user_id = p_user_id
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

-- The deletion pass. Unchanged from 20260801200000 except for the one new
-- delete, ordered before `public.pipeline_runs` so the row is gone before the
-- parent it references.
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
  delete from private.mobile_guided_corrections where user_id = v_generation.user_id;
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
