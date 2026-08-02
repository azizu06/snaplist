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
