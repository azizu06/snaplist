-- Issue #126: atomically persist a seller-corrected identity plus the matching
-- price/confidence/listing regeneration. The function is SECURITY INVOKER (the
-- default) and derives the tenant from the Clerk JWT; it never accepts user_id.
-- Any error rolls back item + listing + prediction-log changes together.

create or replace function public.regenerate_review_listing(
  p_item_id uuid,
  p_listing_id uuid,
  p_run_id uuid,
  p_attributes jsonb,
  p_condition text,
  p_identification jsonb,
  p_listing_title text,
  p_listing_description text,
  p_listing_copy jsonb,
  p_price numeric,
  p_price_range jsonb,
  p_confidence numeric,
  p_tier_fired text,
  p_model text,
  p_listing_model text,
  p_pricing_model text,
  p_sources jsonb,
  p_autopilot_enabled boolean,
  p_autopilot_eligible boolean
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
  if p_run_id is null then
    raise exception using errcode = '22023', message = 'Run id is required.';
  end if;
  if jsonb_typeof(p_attributes) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Attributes must be an object.';
  end if;
  if jsonb_typeof(p_identification) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Identification must be an object.';
  end if;
  if p_listing_title is null or btrim(p_listing_title) = '' or char_length(p_listing_title) > 80 then
    raise exception using errcode = '22023', message = 'Listing title is invalid.';
  end if;
  if p_listing_description is null or btrim(p_listing_description) = '' then
    raise exception using errcode = '22023', message = 'Listing description is invalid.';
  end if;
  if jsonb_typeof(p_listing_copy) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Listing copy must be an object.';
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
  if p_model is null or btrim(p_model) = '' or p_listing_model is null or btrim(p_listing_model) = '' then
    raise exception using errcode = '22023', message = 'Model provenance is required.';
  end if;
  if jsonb_typeof(p_sources) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Sources must be an array.';
  end if;

  -- Lock/authorize the item through its tenant key. RLS independently enforces the
  -- same ownership; the explicit predicate makes the function's contract auditable.
  perform 1
  from public.items
  where id = p_item_id and user_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Item not found.';
  end if;

  update public.items
  set attributes = p_attributes,
      condition = p_condition,
      identification = p_identification
  where id = p_item_id and user_id = v_user_id;

  -- Updating in place avoids leaving an older queued/stale draft publishable. A
  -- published listing is outside this pre-publish workflow and is rejected. The
  -- draft reset ensures manual regeneration never auto-publishes.
  update public.listings
  set title = p_listing_title,
      description = p_listing_description,
      copy = p_listing_copy,
      status = 'draft',
      run_id = p_run_id
  where id = p_listing_id
    and item_id = p_item_id
    and user_id = v_user_id
    and platform = 'ebay'
    and status is distinct from 'published';
  if not found then
    raise exception using errcode = 'P0002', message = 'Editable eBay listing not found.';
  end if;

  insert into public.prediction_logs (
    user_id,
    item_id,
    run_id,
    extracted_attrs,
    price,
    price_range,
    confidence,
    tier_fired,
    model,
    listing_model,
    pricing_model,
    sources,
    autopilot_enabled,
    autopilot_eligible
  ) values (
    v_user_id,
    p_item_id,
    p_run_id,
    p_attributes,
    p_price,
    p_price_range,
    p_confidence,
    p_tier_fired,
    p_model,
    p_listing_model,
    p_pricing_model,
    p_sources,
    p_autopilot_enabled,
    p_autopilot_eligible
  );

  -- Cached export packs contain identity-bearing copy. Remove them atomically so
  -- the next export visit regenerates from the corrected attributes.
  delete from public.listings
  where item_id = p_item_id
    and user_id = v_user_id
    and platform in ('facebook', 'mercari');
end;
$$;

revoke all on function public.regenerate_review_listing(
  uuid, uuid, uuid, jsonb, text, jsonb, text, text, jsonb, numeric, jsonb,
  numeric, text, text, text, text, jsonb, boolean, boolean
) from public;

grant execute on function public.regenerate_review_listing(
  uuid, uuid, uuid, jsonb, text, jsonb, text, text, jsonb, numeric, jsonb,
  numeric, text, text, text, text, jsonb, boolean, boolean
) to authenticated;
