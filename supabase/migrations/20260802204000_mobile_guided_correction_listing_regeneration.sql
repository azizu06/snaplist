-- Complete mobile guided correction with regenerated eBay copy in the same
-- capability-bound transaction as item, prediction, allowance, and receipt.
create or replace function public.complete_mobile_guided_correction(
  p_completion_token text,
  p_idempotency_key uuid,
  p_commit jsonb,
  p_receipt jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cap private.guided_correction_completion_capabilities%rowtype;
  v_claim private.mobile_guided_corrections%rowtype;
  v_listing jsonb;
  v_prediction jsonb;
  v_now timestamptz := statement_timestamp();
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Guided correction completion authorization is required';
  end if;
  if p_completion_token !~ '^[A-Za-z0-9_-]{43}$'
    or p_idempotency_key is null
    or jsonb_typeof(p_commit) is distinct from 'object'
    or octet_length(p_commit::text) > 262144
    or jsonb_typeof(p_receipt) is distinct from 'object'
    or octet_length(p_receipt::text) > 65536 then
    raise exception using
      errcode = '22023',
      message = 'Invalid mobile guided correction completion';
  end if;

  select capability.* into v_cap
  from private.guided_correction_completion_capabilities capability
  where capability.token_hash = encode(
    sha256(convert_to(p_completion_token, 'UTF8')), 'hex'
  )
  for update;
  if not found or v_cap.consumed_at is not null or v_cap.expires_at <= v_now then
    raise exception using
      errcode = 'P0001',
      message = 'Guided correction capability is unavailable';
  end if;

  if p_commit->>'item_id' is distinct from v_cap.item_id::text
    or p_commit->>'run_id' is distinct from v_cap.completion_run_id::text
    or p_commit->>'expected_review_revision'
      is distinct from v_cap.expected_review_revision::text
    or jsonb_typeof(p_commit->'attributes') is distinct from 'object'
    or coalesce(jsonb_typeof(p_commit->'identification'), 'null')
      not in ('object', 'null') then
    raise exception using
      errcode = '42501',
      message = 'Guided correction capability binding mismatch';
  end if;

  v_listing := p_commit->'listing';
  if jsonb_typeof(v_listing) is distinct from 'object'
    or v_listing->>'platform' is distinct from 'ebay'
    or nullif(btrim(v_listing->>'title'), '') is null
    or char_length(v_listing->>'title') > 80
    or nullif(btrim(v_listing->>'description'), '') is null
    or jsonb_typeof(v_listing->'copy') is distinct from 'object' then
    raise exception using
      errcode = '22023',
      message = 'Invalid mobile guided correction completion';
  end if;

  v_prediction := p_commit->'prediction';
  if jsonb_typeof(v_prediction) is distinct from 'object'
    or jsonb_typeof(v_prediction->'extracted_attrs') is distinct from 'object'
    or jsonb_typeof(v_prediction->'price_range') is distinct from 'object'
    or jsonb_typeof(v_prediction->'sources') is distinct from 'array'
    or (v_prediction->>'price')::numeric <= 0
    or jsonb_typeof(v_prediction->'confidence') is distinct from 'number'
    or (v_prediction->>'confidence')::numeric not between 0 and 1
    or nullif(btrim(v_prediction->>'tier_fired'), '') is null
    or nullif(btrim(v_prediction->>'model'), '') is null then
    raise exception using
      errcode = '22023',
      message = 'Invalid mobile guided correction completion';
  end if;

  perform 1
  from public.ai_item_credit_reservations reservation
  join public.items item
    on item.id = reservation.item_id and item.user_id = reservation.user_id
  join public.listings listing
    on listing.id = v_cap.listing_id
   and listing.item_id = item.id and listing.user_id = item.user_id
  where reservation.id = v_cap.reservation_id
    and reservation.user_id = v_cap.user_id
    and reservation.item_id = v_cap.item_id
    and reservation.state = 'settled'
    and reservation.guided_correction_revision
      is not distinct from v_cap.expected_review_revision
    and reservation.guided_correction_completed_at is null
    and reservation.photo_identity_kind = item.photo_identity_kind
    and reservation.photo_identity_fingerprint = item.photo_identity_fingerprint
    and reservation.photo_identity_kind = 'content_sha256_set_v1'
    and item.review_revision is not distinct from v_cap.expected_review_revision
    and listing.platform = 'ebay'
    and listing.run_id is not distinct from v_cap.expected_run_id
    and listing.status is distinct from 'published'
    and listing.ebay_listing_id is null
    and listing.ebay_status is distinct from 'publishing'
    and listing.ebay_status is distinct from 'published'
  for update of reservation, item, listing;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Guided correction authority changed';
  end if;

  select claim.* into v_claim
  from private.mobile_guided_corrections claim
  join public.pipeline_runs run
    on run.id = claim.run_id
   and run.user_id = claim.user_id
   and run.item_id = v_cap.item_id
  where claim.user_id = v_cap.user_id
    and claim.idempotency_key = p_idempotency_key
    and claim.expected_review_revision
      is not distinct from v_cap.expected_review_revision
  for update of claim;
  if not found or v_claim.state <> 'pending'
    or p_receipt->>'itemId' is distinct from v_cap.item_id::text
    or p_receipt->>'runId' is distinct from v_cap.completion_run_id::text
    or p_receipt->>'reviewRevision'
      is distinct from v_cap.completion_run_id::text
    or (p_receipt->>'schemaVersion')::integer is distinct from 1 then
    raise exception using
      errcode = '22023',
      message = 'Invalid mobile guided correction completion';
  end if;

  update public.items
  set attributes = p_commit->'attributes',
      -- Null means specs-only: preserve the vision identity the seller did not
      -- replace. A confirmed identity is the already-derived object.
      identification = case
        when jsonb_typeof(p_commit->'identification') = 'object'
          then p_commit->'identification'
        else identification
      end,
      review_revision = v_cap.completion_run_id,
      review_content_revision = v_cap.completion_run_id
  where id = v_cap.item_id
    and user_id = v_cap.user_id
    and review_revision is not distinct from v_cap.expected_review_revision;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Review changed. Reload and try again.';
  end if;

  update public.listings
  set title = v_listing->>'title',
      description = v_listing->>'description',
      copy = v_listing->'copy',
      status = 'draft',
      run_id = v_cap.completion_run_id,
      ebay_publish_claim_id = null,
      ebay_publish_claimed_at = null
  where id = v_cap.listing_id
    and item_id = v_cap.item_id
    and user_id = v_cap.user_id
    and platform = 'ebay'
    and run_id is not distinct from v_cap.expected_run_id
    and status is distinct from 'published'
    and ebay_listing_id is null
    and ebay_status is distinct from 'publishing'
    and ebay_status is distinct from 'published';
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Guided correction authority changed';
  end if;

  insert into public.prediction_logs (
    user_id, item_id, run_id, extracted_attrs, price, price_range, confidence,
    tier_fired, model, listing_model, pricing_model, sources,
    autopilot_enabled, autopilot_eligible
  ) values (
    v_cap.user_id, v_cap.item_id, v_cap.completion_run_id,
    v_prediction->'extracted_attrs', (v_prediction->>'price')::numeric,
    v_prediction->'price_range', (v_prediction->>'confidence')::numeric,
    v_prediction->>'tier_fired', v_prediction->>'model',
    v_prediction->>'listing_model', v_prediction->>'pricing_model',
    v_prediction->'sources',
    (v_prediction->>'autopilot_enabled')::boolean,
    (v_prediction->>'autopilot_eligible')::boolean
  );

  delete from public.listings
  where item_id = v_cap.item_id
    and user_id = v_cap.user_id
    and platform in ('facebook', 'mercari');

  update public.ai_item_credit_reservations
  set guided_correction_completed_at = v_now,
      updated_at = v_now
  where id = v_cap.reservation_id
    and guided_correction_completed_at is null;
  if not found then
    raise exception using
      errcode = '55000',
      message = 'Guided correction completion was already recorded.';
  end if;

  update private.guided_correction_completion_capabilities
  set consumed_at = v_now
  where reservation_id = v_cap.reservation_id and consumed_at is null;
  if not found then
    raise exception using
      errcode = '55000',
      message = 'Guided correction capability was already consumed.';
  end if;

  update private.mobile_guided_corrections
  set state = 'completed',
      lease_expires_at = null,
      receipt = p_receipt
  where user_id = v_cap.user_id
    and idempotency_key = p_idempotency_key
    and state = 'pending';
  if not found then
    raise exception using
      errcode = '55000',
      message = 'Mobile guided correction receipt was not recorded.';
  end if;

  return true;
end;
$$;

revoke all on function public.complete_mobile_guided_correction(
  text, uuid, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.complete_mobile_guided_correction(
  text, uuid, jsonb, jsonb
) to service_role;
