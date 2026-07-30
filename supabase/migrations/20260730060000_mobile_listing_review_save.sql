-- Issue #549: one run-bound Listing Review save with durable replay guards.
--
-- The public save stays security-invoker and delegates ordinary edits to the
-- existing save_review_edits domain RPC. A narrow definer owns only the private
-- idempotency claim. Identity changes return a server-derived snapshot so the
-- application can reuse the existing guided-correction service, then replay
-- this same save RPC to apply staged seller copy without a second revision.

create table private.mobile_listing_review_saves (
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
  constraint mobile_listing_review_save_intent_check
    check (jsonb_typeof(intent) = 'object'),
  constraint mobile_listing_review_save_state_check
    check (state in ('pending', 'completed', 'failed')),
  constraint mobile_listing_review_save_lease_check
    check (
      (state = 'pending' and lease_expires_at is not null)
      or (state <> 'pending' and lease_expires_at is null)
    ),
  constraint mobile_listing_review_save_receipt_check
    check (
      (state = 'completed' and jsonb_typeof(receipt) = 'object')
      or (state <> 'completed' and receipt is null)
    )
);

revoke all on table private.mobile_listing_review_saves
  from public, anon, authenticated;

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
    return jsonb_build_object('state', 'finalize');
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
  v_mode := case
    when v_item.condition is distinct from p_condition
      or v_normalized_current_specifics is distinct from v_requested_specifics
    then 'regeneration'
    else 'ordinary'
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
        receipt = null
    where user_id = v_user_id
      and idempotency_key = p_idempotency_key;
  else
    insert into private.mobile_listing_review_saves (
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
      v_intent
    );
  end if;

  return jsonb_build_object(
    'state', v_mode,
    'snapshot', jsonb_build_object(
      'itemId', v_item.id,
      'attributes', v_item.attributes,
      'specifics', v_current_specifics
    )
  );
end;
$$;

revoke all on function public.claim_mobile_listing_review_save(
  text, uuid, uuid, uuid, text, text, text, jsonb, numeric
) from public, anon, service_role;
grant execute on function public.claim_mobile_listing_review_save(
  text, uuid, uuid, uuid, text, text, text, jsonb, numeric
) to authenticated;

create or replace function public.save_mobile_listing_review(
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
security invoker
set search_path = ''
as $$
declare
  v_claim jsonb;
  v_state text;
  v_run public.pipeline_runs%rowtype;
  v_item public.items%rowtype;
  v_listing public.listings%rowtype;
  v_specifics jsonb;
  v_copy jsonb;
  v_expected_revision uuid;
begin
  v_claim := public.claim_mobile_listing_review_save(
    'prepare',
    p_run_id,
    p_idempotency_key,
    p_expected_review_revision,
    p_title,
    p_description,
    p_condition,
    p_specifics,
    p_price_override
  );
  v_state := v_claim->>'state';
  if v_state in ('completed', 'in_progress', 'regeneration') then
    return v_claim;
  end if;
  if v_state not in ('ordinary', 'finalize') then
    raise exception using
      errcode = 'P0001',
      message = 'Listing Review save state is invalid.';
  end if;

  select run.* into strict v_run
  from public.pipeline_runs run
  where run.id = p_run_id
    and run.user_id = public.clerk_user_id()
    and run.status = 'succeeded'
    and run.stage = 'completed'
    and run.listing_id is not null;
  select item.* into strict v_item
  from public.items item
  where item.id = v_run.item_id
    and item.user_id = public.clerk_user_id();
  select listing.* into strict v_listing
  from public.listings listing
  where listing.id = v_run.listing_id
    and listing.item_id = v_run.item_id
    and listing.user_id = public.clerk_user_id()
    and listing.platform = 'ebay';

  v_expected_revision := case
    when v_state = 'finalize' then p_idempotency_key
    else p_expected_review_revision
  end;
  perform public.save_review_edits(
    v_item.id,
    v_listing.id,
    v_expected_revision,
    p_idempotency_key,
    v_item.attributes,
    v_item.condition,
    p_price_override,
    v_item.cost_basis,
    btrim(p_title),
    btrim(p_description)
  );

  select coalesce(
    jsonb_object_agg(
      btrim(entry.value->>'name'),
      to_jsonb(btrim(entry.value->>'value'))
      order by entry.ordinality
    ),
    '{}'::jsonb
  )
  into v_specifics
  from jsonb_array_elements(p_specifics) with ordinality entry;
  v_copy := jsonb_set(
    coalesce(v_listing.copy, '{}'::jsonb),
    '{itemSpecifics}',
    v_specifics,
    true
  );
  update public.listings
  set copy = v_copy,
      source_review_revision = p_idempotency_key
  where id = v_listing.id
    and item_id = v_item.id
    and user_id = public.clerk_user_id()
    and platform = 'ebay'
    and status is distinct from 'published'
    and ebay_listing_id is null
    and ebay_status is distinct from 'publishing'
    and ebay_status is distinct from 'published';
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Editable eBay listing not found.';
  end if;

  return public.claim_mobile_listing_review_save(
    'complete',
    p_run_id,
    p_idempotency_key,
    p_expected_review_revision,
    p_title,
    p_description,
    p_condition,
    p_specifics,
    p_price_override
  );
end;
$$;

revoke all on function public.save_mobile_listing_review(
  uuid, uuid, uuid, text, text, text, jsonb, numeric
) from public, anon, service_role;
grant execute on function public.save_mobile_listing_review(
  uuid, uuid, uuid, text, text, text, jsonb, numeric
) to authenticated;
