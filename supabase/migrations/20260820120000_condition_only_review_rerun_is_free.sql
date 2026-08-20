-- Issue #919. A declared-condition change reruns pricing and regenerates the
-- listing, exactly as it already did. What changes here is who pays for it.
--
-- The allowance grants one guided *identity* correction: the seller fixing a
-- mistake SnapList made about what the item is. Condition is not that. The
-- model guesses condition from photos; the seller is holding the item and
-- knows. Supplying it is ground truth, not a correction, so a save whose only
-- correction input is condition must not spend the included guided correction.
--
-- The exemption is deliberately narrow. If the same save also changes brand,
-- model, category, isbn, upc, or any visible specific, it is an identity
-- correction again and it spends exactly as it does today.
--
-- The scope is never supplied by the caller. authorize_ai_item_guided_correction
-- is granted to `authenticated`, so a caller-supplied flag would be unlimited
-- free identity corrections. It is derived by the Listing Review gate from
-- server state, recorded on the private pending-save row, and carried onto the
-- private capability row. Both tables are written only by security-definer
-- functions.

alter table private.mobile_listing_review_saves
  add column if not exists regeneration_scope text;

alter table private.mobile_listing_review_saves
  drop constraint if exists mobile_listing_review_save_scope_check;

alter table private.mobile_listing_review_saves
  add constraint mobile_listing_review_save_scope_check
  check (regeneration_scope is null or regeneration_scope in ('condition', 'identity'));

alter table private.guided_correction_completion_capabilities
  add column if not exists condition_only boolean not null default false;

create or replace function public.claim_mobile_listing_review_save(
  p_action text,
  p_run_id uuid,
  p_idempotency_key uuid,
  p_expected_review_revision uuid,
  p_title text,
  p_description text,
  p_condition text,
  p_specifics jsonb,
  p_price_override numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_run public.pipeline_runs%rowtype;
  v_item public.items%rowtype;
  v_listing public.listings%rowtype;
  v_save private.mobile_listing_review_saves%rowtype;
  v_save_found boolean;
  v_intent jsonb;
  v_current_specifics jsonb;
  v_requested_specifics jsonb;
  v_normalized_current_specifics jsonb;
  v_count integer;
  v_valid_count integer;
  v_unique_count integer;
  v_mode text;
  v_condition_changed boolean;
  v_specifics_changed boolean;
  v_scope text;
  v_receipt jsonb;
begin
  if coalesce(v_user_id, '') = ''
    or p_action not in ('prepare', 'complete', 'fail')
    or p_run_id is null
    or p_idempotency_key is null
    or p_expected_review_revision is null
    or p_idempotency_key is not distinct from p_expected_review_revision then
    raise exception using
      errcode = '42501',
      message = 'Listing Review save authorization is required.';
  end if;
  if nullif(btrim(p_title), '') is null
    or char_length(btrim(p_title)) > 80
    or nullif(btrim(p_description), '') is null
    or char_length(btrim(p_description)) > 20000
    or p_condition not in (
      'new', 'like-new', 'very-good', 'good',
      'acceptable', 'fair', 'poor', 'for-parts'
    )
    or jsonb_typeof(p_specifics) is distinct from 'array'
    or jsonb_array_length(p_specifics) = 0
    or jsonb_array_length(p_specifics) > 50
    or octet_length(p_specifics::text) > 32768
    or (
      p_price_override is not null
      and (
        p_price_override <= 0
        or p_price_override is distinct from round(p_price_override, 2)
      )
    ) then
    raise exception using
      errcode = '22023',
      message = 'Listing Review save intent is invalid.';
  end if;

  select
    count(*)::integer,
    count(*) filter (
      where jsonb_typeof(entry.value) = 'object'
        and entry.value ? 'name'
        and entry.value ? 'value'
        and entry.value - 'name' - 'value' = '{}'::jsonb
        and nullif(btrim(entry.value->>'name'), '') is not null
        and char_length(btrim(entry.value->>'name')) <= 65
        and nullif(btrim(entry.value->>'value'), '') is not null
        and char_length(btrim(entry.value->>'value')) <= 500
    )::integer,
    count(distinct lower(btrim(entry.value->>'name')))::integer
  into v_count, v_valid_count, v_unique_count
  from jsonb_array_elements(p_specifics) with ordinality entry;
  if v_count <> v_valid_count or v_count <> v_unique_count then
    raise exception using
      errcode = '22023',
      message = 'Item specifics are invalid.';
  end if;

  v_intent := jsonb_build_object(
    'expectedReviewRevision', p_expected_review_revision,
    'title', btrim(p_title),
    'description', btrim(p_description),
    'condition', p_condition,
    'specifics', p_specifics,
    'sellerPriceOverride', p_price_override
  );
  select run.* into v_run
  from public.pipeline_runs run
  where run.id = p_run_id
    and run.user_id = v_user_id
    and run.status = 'succeeded'
    and run.stage = 'completed'
    and run.listing_id is not null
  for update;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'This review is unavailable.';
  end if;
  select item.* into v_item
  from public.items item
  where item.id = v_run.item_id
    and item.user_id = v_user_id
  for update;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'This review is unavailable.';
  end if;
  select listing.* into v_listing
  from public.listings listing
  where listing.id = v_run.listing_id
    and listing.item_id = v_run.item_id
    and listing.user_id = v_user_id
    and listing.platform = 'ebay'
  for update;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'This review is unavailable.';
  end if;
  select save.* into v_save
  from private.mobile_listing_review_saves save
  where save.user_id = v_user_id
    and save.idempotency_key = p_idempotency_key
  for update;
  v_save_found := found;
  if v_save_found and (
    v_save.run_id is distinct from p_run_id
    or v_save.intent is distinct from v_intent
  ) then
    raise exception using
      errcode = 'P0003',
      message = 'This Idempotency-Key is already bound to different review edits.';
  end if;
  if p_action = 'prepare' and v_save_found and v_save.state = 'completed' then
    return jsonb_build_object('state', 'completed', 'receipt', v_save.receipt);
  end if;
  if v_listing.status is not distinct from 'published'
    or v_listing.ebay_listing_id is not null
    or v_listing.ebay_status is not distinct from 'publishing'
    or v_listing.ebay_status is not distinct from 'published' then
    raise exception using
      errcode = 'P0002',
      message = 'A published listing cannot be changed from review.';
  end if;

  if p_action = 'fail' then
    if not v_save_found or v_save.state = 'completed' then
      return jsonb_build_object('state', 'unchanged');
    end if;
    if v_item.review_revision is not distinct from p_idempotency_key then
      return jsonb_build_object('state', 'finalize');
    end if;
    update private.mobile_listing_review_saves
    set state = 'failed',
        lease_expires_at = null,
        receipt = null
    where user_id = v_user_id
      and idempotency_key = p_idempotency_key
      and state = 'pending';
    return jsonb_build_object('state', 'failed');
  end if;

  if p_action = 'complete' then
    if not v_save_found
      or v_save.state <> 'pending'
      or v_item.review_revision is distinct from p_idempotency_key then
      raise exception using
        errcode = 'P0002',
        message = 'This review changed. Reload and try again.';
    end if;
    v_receipt := jsonb_build_object(
      'schemaVersion', 1,
      'runId', v_run.id,
      'itemId', v_item.id,
      'listingId', v_listing.id,
      'reviewRevision', p_idempotency_key
    );
    update private.mobile_listing_review_saves
    set state = 'completed',
        lease_expires_at = null,
        receipt = v_receipt
    where user_id = v_user_id
      and idempotency_key = p_idempotency_key;
    return jsonb_build_object('state', 'completed', 'receipt', v_receipt);
  end if;

  if v_item.review_revision is not distinct from p_idempotency_key then
    return jsonb_build_object(
      'state', 'finalize',
      'snapshot', jsonb_build_object(
        'title', v_save.pre_regeneration_title,
        'description', v_save.pre_regeneration_description
      )
    );
  end if;
  if v_item.review_revision is distinct from p_expected_review_revision then
    raise exception using
      errcode = 'P0002',
      message = 'This review changed. Reload and try again.';
  end if;

  v_current_specifics := coalesce(
    v_listing.copy #> '{itemSpecifics}',
    '{}'::jsonb
  );
  select coalesce(
    jsonb_object_agg(
      lower(btrim(entry.value->>'name')),
      to_jsonb(btrim(entry.value->>'value'))
    ),
    '{}'::jsonb
  )
  into v_requested_specifics
  from jsonb_array_elements(p_specifics) entry;
  select coalesce(
    jsonb_object_agg(lower(btrim(entry.key)), to_jsonb(btrim(entry.value))),
    '{}'::jsonb
  )
  into v_normalized_current_specifics
  from jsonb_each_text(v_current_specifics) entry;
  v_condition_changed := v_item.condition is distinct from p_condition;
  v_specifics_changed :=
    v_normalized_current_specifics is distinct from v_requested_specifics;
  v_mode := case
    when v_condition_changed or v_specifics_changed
    then 'regeneration'
    else 'ordinary'
  end;
  -- #919. This gate is the only place that knows why a rerun is happening, so
  -- it is the only honest place to record it. A declared-condition change on
  -- its own is the seller supplying ground truth the model guessed from photos,
  -- not a correction of our identity claim, and it is exempt from spending the
  -- one included guided correction. Any identity-bearing specific changing in
  -- the same save makes it an identity correction again, and it pays.
  v_scope := case
    when v_mode <> 'regeneration' then null
    when v_specifics_changed then 'identity'
    else 'condition'
  end;

  if v_save_found
    and v_save.state = 'pending'
    and v_save.lease_expires_at > statement_timestamp() then
    return jsonb_build_object('state', 'in_progress');
  end if;
  if v_mode = 'regeneration' and exists (
    select 1
    from private.mobile_listing_review_saves competing
    where competing.user_id = v_user_id
      and competing.run_id = p_run_id
      and competing.expected_review_revision = p_expected_review_revision
      and competing.idempotency_key is distinct from p_idempotency_key
      and competing.state = 'pending'
      and competing.lease_expires_at > statement_timestamp()
  ) then
    return jsonb_build_object('state', 'in_progress');
  end if;
  if v_save_found then
    update private.mobile_listing_review_saves
    set state = 'pending',
        lease_expires_at = statement_timestamp() + interval '5 minutes',
        regeneration_scope = v_scope,
        pre_regeneration_title = case
          when v_mode = 'regeneration' then v_listing.title
          else null
        end,
        pre_regeneration_description = case
          when v_mode = 'regeneration' then v_listing.description
          else null
        end,
        receipt = null
    where user_id = v_user_id
      and idempotency_key = p_idempotency_key;
  else
    insert into private.mobile_listing_review_saves (
      user_id,
      idempotency_key,
      run_id,
      expected_review_revision,
      intent,
      pre_regeneration_title,
      pre_regeneration_description,
      regeneration_scope
    ) values (
      v_user_id,
      p_idempotency_key,
      p_run_id,
      p_expected_review_revision,
      v_intent,
      case when v_mode = 'regeneration' then v_listing.title else null end,
      case when v_mode = 'regeneration' then v_listing.description else null end,
      v_scope
    );
  end if;

  return jsonb_build_object(
    'state', v_mode,
    'snapshot', jsonb_build_object(
      'itemId', v_item.id,
      'attributes', v_item.attributes,
      'title', v_listing.title,
      'description', v_listing.description,
      'specifics', v_current_specifics
    )
  );
end;
$$;
create or replace function public.authorize_ai_item_guided_correction(
  p_item_id uuid,
  p_listing_id uuid,
  p_completion_run_id uuid,
  p_expected_run_id uuid,
  p_expected_review_revision uuid,
  p_completion_token text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_item public.items%rowtype;
  v_reservation public.ai_item_credit_reservations%rowtype;
  v_now timestamptz := statement_timestamp();
  v_expires_at timestamptz;
  v_condition_only boolean;
begin
  if coalesce(v_user_id, '') = '' then
    raise exception using
      errcode = '42501',
      message = 'Authentication required.';
  end if;
  if p_item_id is null or p_listing_id is null or p_completion_run_id is null
    or p_expected_review_revision is null
    or p_completion_run_id is not distinct from p_expected_run_id
    or p_completion_token !~ '^[A-Za-z0-9_-]{43}$'
    or p_expires_at <= v_now then
    raise exception using
      errcode = '22023',
      message = 'Guided correction capability request is invalid.';
  end if;
  v_expires_at := case
    when p_expires_at is null then null
    else least(p_expires_at, v_now + interval '5 minutes')
  end;

  select * into v_item
  from public.items item
  where item.id = p_item_id
    and item.user_id = v_user_id
    and item.review_revision is not distinct from p_expected_review_revision
  for update;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Review changed. Reload and try again.';
  end if;
  if v_item.photo_identity_kind <> 'content_sha256_set_v1' then
    raise exception using
      errcode = 'P0001',
      message = 'Legacy photo identity cannot prove same-photo correction.';
  end if;

  perform 1
  from public.listings listing
  where listing.id = p_listing_id
    and listing.item_id = p_item_id
    and listing.user_id = v_user_id
    and listing.platform = 'ebay'
    and listing.run_id is not distinct from p_expected_run_id
    and listing.status is distinct from 'published'
    and listing.ebay_listing_id is null
    and listing.ebay_status is distinct from 'publishing'
    and listing.ebay_status is distinct from 'published'
  for update;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Editable eBay listing not found.';
  end if;

  -- #919. The exemption is never a caller flag. It is read back from the
  -- Listing Review gate's own server-derived classification of the pending
  -- save, so a client that calls this directly gets today's paid behaviour.
  --
  -- The lookup is bound to one row, not to "some pending save at this
  -- revision". The regenerator mints its completion run id from the save's
  -- idempotency key (src/lib/listing-review/save.ts, randomUUID override), so
  -- p_completion_run_id names the exact pending save that asked for this
  -- rerun, and (user_id, idempotency_key) is that table's primary key. Any
  -- other caller, or any save that is no longer pending, finds nothing and
  -- pays.
  select save.regeneration_scope = 'condition'
  into v_condition_only
  from private.mobile_listing_review_saves save
  join public.pipeline_runs run
    on run.id = save.run_id
   and run.user_id = save.user_id
  where save.user_id = v_user_id
    and save.idempotency_key = p_completion_run_id
    and run.item_id = p_item_id
    and save.expected_review_revision = p_expected_review_revision
    and save.state = 'pending'
    and save.lease_expires_at > v_now;
  v_condition_only := coalesce(v_condition_only, false);

  select reservation.* into v_reservation
  from public.ai_item_credit_reservations reservation
  join public.items item
    on item.id = reservation.item_id
   and item.user_id = reservation.user_id
  where reservation.user_id = v_user_id
    and reservation.item_id = p_item_id
    and reservation.state = 'settled'
    and reservation.photo_identity_kind = item.photo_identity_kind
    and reservation.photo_identity_fingerprint = item.photo_identity_fingerprint
    and reservation.photo_identity_kind = 'content_sha256_set_v1'
  order by reservation.settled_at desc
  limit 1
  for update of reservation;
  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'The included guided correction is unavailable.';
  end if;
  if not v_condition_only
    and v_reservation.guided_correction_completed_at is not null then
    raise exception using
      errcode = 'P0001',
      message = 'The included guided correction is unavailable.';
  end if;

  if not v_condition_only then
    update public.ai_item_credit_reservations
    set guided_correction_revision = p_expected_review_revision,
        guided_correction_started_at = v_now,
        updated_at = v_now
    where id = v_reservation.id
      and guided_correction_completed_at is null;
  end if;

  insert into private.guided_correction_completion_capabilities (
    reservation_id,
    token_hash,
    user_id,
    item_id,
    listing_id,
    completion_run_id,
    expected_run_id,
    expected_review_revision,
    created_at,
    expires_at,
    consumed_at,
    condition_only
  ) values (
    v_reservation.id,
    encode(sha256(convert_to(p_completion_token, 'UTF8')), 'hex'),
    v_user_id,
    p_item_id,
    p_listing_id,
    p_completion_run_id,
    p_expected_run_id,
    p_expected_review_revision,
    v_now,
    v_expires_at,
    null,
    v_condition_only
  )
  on conflict (reservation_id) do update
  set token_hash = excluded.token_hash,
      listing_id = excluded.listing_id,
      completion_run_id = excluded.completion_run_id,
      expected_run_id = excluded.expected_run_id,
      expected_review_revision = excluded.expected_review_revision,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at,
      consumed_at = null,
      condition_only = excluded.condition_only;

  return jsonb_build_object('expiresAt', v_expires_at);
end;
$$;
create or replace function private.complete_guided_review_correction_legacy_evidence_v1(
  p_completion_token text,
  p_commit jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cap private.guided_correction_completion_capabilities%rowtype;
  v_reservation public.ai_item_credit_reservations%rowtype;
  v_item public.items%rowtype;
  v_listing public.listings%rowtype;
  v_item_payload jsonb;
  v_listing_payload jsonb;
  v_prediction jsonb;
  v_snapshot jsonb;
  v_prediction_id uuid;
  v_evidence jsonb;
  v_now timestamptz := statement_timestamp();
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Guided correction completion authorization is required';
  end if;
  if p_completion_token !~ '^[A-Za-z0-9_-]{43}$'
    or jsonb_typeof(p_commit) is distinct from 'object'
    or octet_length(p_commit::text) > 524288 then
    raise exception using errcode = '22023', message = 'Invalid guided correction completion';
  end if;

  select * into v_cap
  from private.guided_correction_completion_capabilities capability
  where capability.token_hash = encode(
    sha256(convert_to(p_completion_token, 'UTF8')), 'hex'
  )
  for update;
  if not found or v_cap.consumed_at is not null or v_cap.expires_at <= v_now then
    raise exception using errcode = 'P0001', message = 'Guided correction capability is unavailable';
  end if;
  if p_commit->>'item_id' is distinct from v_cap.item_id::text
    or p_commit->>'listing_id' is distinct from v_cap.listing_id::text
    or p_commit->>'run_id' is distinct from v_cap.completion_run_id::text
    or p_commit->>'expected_run_id' is distinct from v_cap.expected_run_id::text
    or p_commit->>'expected_review_revision'
      is distinct from v_cap.expected_review_revision::text then
    raise exception using errcode = '42501', message = 'Guided correction capability binding mismatch';
  end if;

  v_item_payload := p_commit->'item';
  v_listing_payload := p_commit->'listing';
  v_prediction := p_commit->'prediction';
  v_snapshot := p_commit->'pricing_snapshot';
  if jsonb_typeof(v_item_payload) is distinct from 'object'
    or jsonb_typeof(v_item_payload->'attributes') is distinct from 'object'
    or jsonb_typeof(v_item_payload->'identification') is distinct from 'object'
    or octet_length(v_item_payload::text) > 131072
    or jsonb_typeof(v_listing_payload) is distinct from 'object'
    or octet_length(v_listing_payload::text) > 131072
    or v_listing_payload->>'platform' is distinct from 'ebay'
    or nullif(btrim(v_listing_payload->>'title'), '') is null
    or char_length(v_listing_payload->>'title') > 80
    or nullif(btrim(v_listing_payload->>'description'), '') is null
    or jsonb_typeof(v_listing_payload->'copy') is distinct from 'object'
    or jsonb_typeof(v_prediction) is distinct from 'object'
    or octet_length(v_prediction::text) > 131072
    or jsonb_typeof(v_prediction->'extracted_attrs') is distinct from 'object'
    or jsonb_typeof(v_prediction->'price_range') is distinct from 'object'
    or jsonb_typeof(v_prediction->'sources') is distinct from 'array'
    or (v_prediction->>'price')::numeric <= 0
    or jsonb_typeof(v_prediction->'confidence') is distinct from 'number'
    or (v_prediction->>'confidence')::numeric not between 0 and 1
    or (v_prediction->>'autopilot_enabled')::boolean is distinct from false
    or (v_prediction->>'autopilot_eligible')::boolean is distinct from false
    or jsonb_typeof(v_snapshot) is distinct from 'object'
    or (v_snapshot->>'schema_version')::integer is distinct from 1
    or jsonb_typeof(v_snapshot->'item') is distinct from 'object'
    or jsonb_typeof(v_snapshot->'price_result') is distinct from 'object'
    or jsonb_typeof(v_snapshot #> '{price_result,confidence}') is distinct from 'number'
    or (v_snapshot #>> '{price_result,confidence}')::numeric not between 0 and 1
    or v_snapshot->'price_result' ? 'evidence'
    or not private.pricing_evidence_rows_coarse(v_snapshot->'evidence')
    or octet_length(v_snapshot::text) > 262144 then
    raise exception using errcode = '22023', message = 'Invalid guided correction completion';
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
    and (
      v_cap.condition_only
      or (
        reservation.guided_correction_revision
          is not distinct from v_cap.expected_review_revision
        and reservation.guided_correction_completed_at is null
      )
    )
    and reservation.photo_set_fingerprint = encode(
      sha256(convert_to(array_to_json(item.photos)::text, 'UTF8')), 'hex'
    )
    and item.review_revision is not distinct from v_cap.expected_review_revision
    and listing.platform = 'ebay'
    and listing.run_id is not distinct from v_cap.expected_run_id
    and listing.status is distinct from 'published'
    and listing.ebay_listing_id is null
    and listing.ebay_status is distinct from 'publishing'
    and listing.ebay_status is distinct from 'published'
  for update of reservation, item, listing;
  if not found then
    raise exception using errcode = 'P0002', message = 'Guided correction authority changed';
  end if;

  if v_prediction->'extracted_attrs' is distinct from v_item_payload->'attributes'
    or v_snapshot #> '{price_result,suggested}' is distinct from v_prediction->'price'
    or v_snapshot #> '{price_result,range,min}' is distinct from v_prediction #> '{price_range,low}'
    or v_snapshot #> '{price_result,range,max}' is distinct from v_prediction #> '{price_range,high}'
    or v_snapshot #> '{price_result,confidence}' is distinct from v_prediction->'confidence'
    or v_snapshot #>> '{price_result,tier}' is distinct from v_prediction->>'tier_fired'
    or v_snapshot #> '{price_result,sources}' is distinct from v_prediction->'sources' then
    raise exception using errcode = '22023', message = 'Guided correction persistence is incoherent';
  end if;

  update public.items
  set attributes = v_item_payload->'attributes',
      condition = v_item_payload->>'condition',
      identification = v_item_payload->'identification',
      review_revision = v_cap.completion_run_id,
      review_content_revision = v_cap.completion_run_id
  where id = v_cap.item_id and user_id = v_cap.user_id;

  update public.listings
  set title = v_listing_payload->>'title',
      description = v_listing_payload->>'description',
      copy = v_listing_payload->'copy',
      status = 'draft',
      run_id = v_cap.completion_run_id,
      source_review_revision = v_cap.completion_run_id,
      ebay_publish_claim_id = null,
      ebay_publish_claimed_at = null
  where id = v_cap.listing_id
    and item_id = v_cap.item_id and user_id = v_cap.user_id
    and run_id is not distinct from v_cap.expected_run_id
    and status is distinct from 'published'
    and ebay_listing_id is null
    and ebay_status is distinct from 'publishing'
    and ebay_status is distinct from 'published';
  if not found then
    raise exception using errcode = 'P0002', message = 'Editable eBay listing not found.';
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
    v_prediction->'sources', false, false
  ) returning id into v_prediction_id;

  delete from public.listings
  where item_id = v_cap.item_id and user_id = v_cap.user_id
    and platform in ('facebook', 'mercari');

  select coalesce(
    jsonb_agg(
      evidence_row.value || jsonb_build_object('evidenceAsOf', v_now)
      order by evidence_row.ordinality
    ), '[]'::jsonb
  ) into v_evidence
  from jsonb_array_elements(v_snapshot->'evidence') with ordinality evidence_row;

  insert into public.pricing_evidence_snapshots (
    run_id, pipeline_run_id, run_kind, user_id, item_id,
    prediction_id, listing_id, schema_version,
    item, price_result, evidence, evidence_as_of
  ) values (
    v_cap.completion_run_id, null, 'review-correction', v_cap.user_id,
    v_cap.item_id, v_prediction_id, v_cap.listing_id, 1,
    v_snapshot->'item', v_snapshot->'price_result', v_evidence, v_now
  );

  if not v_cap.condition_only then
    update public.ai_item_credit_reservations
    set guided_correction_completed_at = v_now, updated_at = v_now
    where id = v_cap.reservation_id and guided_correction_completed_at is null;
    if not found then
      raise exception using errcode = '55000', message = 'Guided correction completion was already recorded.';
    end if;
  end if;

  update private.guided_correction_completion_capabilities
  set consumed_at = v_now
  where reservation_id = v_cap.reservation_id and consumed_at is null;
  if not found then
    raise exception using errcode = '55000', message = 'Guided correction capability was already consumed.';
  end if;
  return true;
end;
$$;