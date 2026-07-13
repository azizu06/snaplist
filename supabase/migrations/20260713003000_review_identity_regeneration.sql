-- Issue #126: atomically persist a seller-corrected identity plus the matching
-- price/confidence/listing regeneration. The function is SECURITY INVOKER (the
-- default) and derives the tenant from the Clerk JWT; it never accepts user_id.
-- Any error rolls back item + listing + prediction-log changes together.

alter table public.items
  add column if not exists review_revision uuid not null default gen_random_uuid();

alter table public.items
  add column if not exists review_content_revision uuid;

update public.items
set review_content_revision = review_revision
where review_content_revision is null;

create or replace function public.initialize_review_content_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.review_content_revision is null then
    new.review_content_revision := new.review_revision;
  end if;
  return new;
end;
$$;

drop trigger if exists initialize_review_content_revision on public.items;
create trigger initialize_review_content_revision
before insert on public.items
for each row execute function public.initialize_review_content_revision();

alter table public.items
  alter column review_content_revision set not null;

alter table public.listings
  add column if not exists ebay_publish_claim_id uuid,
  add column if not exists ebay_publish_claimed_at timestamptz,
  add column if not exists source_review_revision uuid;

create unique index if not exists listings_source_review_revision_idx
  on public.listings (item_id, platform, source_review_revision);

create or replace function public.reconcile_legacy_ebay_listing_duplicates()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_unsafe_item_ids text;
begin
  lock table public.listings in share row exclusive mode;

  select string_agg(unsafe.item_id::text, ', ' order by unsafe.item_id::text)
  into v_unsafe_item_ids
  from (
    select item_id
    from public.listings
    where platform = 'ebay'
      and (
        status is not distinct from 'published'
        or ebay_listing_id is not null
        or ebay_status is not distinct from 'publishing'
        or ebay_status is not distinct from 'published'
      )
    group by item_id
    having count(*) > 1
  ) unsafe;

  if v_unsafe_item_ids is not null then
    raise exception using
      errcode = '23505',
      message = format(
        'Cannot reconcile legacy duplicate eBay listings: multiple protected eBay listings exist for item(s): %s',
        v_unsafe_item_ids
      );
  end if;

  with ranked as (
    select
      id,
      (
        status is not distinct from 'published'
        or ebay_listing_id is not null
        or ebay_status is not distinct from 'publishing'
        or ebay_status is not distinct from 'published'
      ) as is_protected,
      row_number() over (
        partition by item_id
        order by
          case
            when status is not distinct from 'published'
              or ebay_listing_id is not null
              or ebay_status is not distinct from 'publishing'
              or ebay_status is not distinct from 'published'
              then 0
            else 1
          end,
          created_at desc,
          id desc
      ) as survivor_rank
    from public.listings
    where platform = 'ebay'
  ), discardable as (
    select id
    from ranked
    where survivor_rank > 1
      and not is_protected
  )
  delete from public.listings listing
  using discardable
  where listing.id = discardable.id;
end;
$$;

revoke all on function public.reconcile_legacy_ebay_listing_duplicates() from public;

select public.reconcile_legacy_ebay_listing_duplicates();

create unique index if not exists listings_one_ebay_per_item_idx
  on public.listings (item_id)
  where platform = 'ebay';

create or replace function public.get_review_snapshot(p_item_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'item', jsonb_build_object(
      'id', item.id,
      'photos', item.photos,
      'attributes', item.attributes,
      'condition', item.condition,
      'identification', item.identification,
      'price_override', item.price_override,
      'cost_basis', item.cost_basis,
      'review_revision', item.review_revision,
      'created_at', item.created_at
    ),
    'listing', case when listing.id is null then null else jsonb_build_object(
      'id', listing.id,
      'platform', listing.platform,
      'title', listing.title,
      'description', listing.description,
      'copy', listing.copy,
      'status', listing.status,
      'run_id', listing.run_id,
      'ebay_listing_id', listing.ebay_listing_id,
      'ebay_status', listing.ebay_status
    ) end,
    'prediction', case when prediction.id is null then null else jsonb_build_object(
      'price', prediction.price,
      'price_range', prediction.price_range,
      'confidence', prediction.confidence,
      'tier_fired', prediction.tier_fired,
      'model', prediction.model,
      'sources', prediction.sources,
      'autopilot_enabled', prediction.autopilot_enabled,
      'autopilot_eligible', prediction.autopilot_eligible
    ) end,
    'reviewBlocked', exists (
      select 1
      from public.listings blocked_listing
      where blocked_listing.item_id = item.id
        and blocked_listing.user_id = public.clerk_user_id()
        and blocked_listing.platform = 'ebay'
        and (
          blocked_listing.status is not distinct from 'published'
          or blocked_listing.ebay_listing_id is not null
          or blocked_listing.ebay_status is not distinct from 'publishing'
          or blocked_listing.ebay_status is not distinct from 'published'
        )
    )
  )
  from public.items item
  left join lateral (
    select candidate.*
    from public.listings candidate
    where candidate.item_id = item.id
      and candidate.user_id = public.clerk_user_id()
      and candidate.platform = 'ebay'
    order by candidate.created_at desc, candidate.id desc
    limit 1
  ) listing on true
  left join lateral (
    select candidate.*
    from public.prediction_logs candidate
    where candidate.item_id = item.id
      and candidate.user_id = public.clerk_user_id()
    order by candidate.created_at desc, candidate.id desc
    limit 1
  ) prediction on true
  where item.id = p_item_id
    and item.user_id = public.clerk_user_id()
  limit 1;
$$;

revoke all on function public.get_review_snapshot(uuid) from public;
grant execute on function public.get_review_snapshot(uuid) to authenticated;

drop function if exists public.begin_ebay_publish(uuid, uuid);
drop function if exists public.begin_ebay_publish(uuid, uuid, uuid);

create or replace function public.begin_ebay_publish(
  p_listing_id uuid,
  p_expected_run_id uuid,
  p_expected_review_revision uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_claim_id uuid := gen_random_uuid();
  v_item_id uuid;
  v_condition text;
  v_photos text[];
  v_title text;
  v_description text;
  v_copy jsonb;
  v_price numeric;
begin
  if v_user_id is null or v_user_id = '' then
    raise exception using errcode = '42501', message = 'Authentication required.';
  end if;

  select item_id
  into v_item_id
  from public.listings
  where id = p_listing_id
    and user_id = v_user_id
    and platform = 'ebay';
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Editable eBay listing changed or is already publishing or published.';
  end if;

  update public.items
  set review_revision = v_claim_id
  where id = v_item_id
    and user_id = v_user_id
    and review_revision is not distinct from p_expected_review_revision
  returning condition, photos into v_condition, v_photos;
  if not found then
    raise exception using errcode = 'P0002', message = 'Review changed. Reload and try again.';
  end if;

  update public.listings
  set ebay_status = 'publishing',
      ebay_publish_claim_id = v_claim_id,
      ebay_publish_claimed_at = now()
  where id = p_listing_id
    and user_id = v_user_id
    and platform = 'ebay'
    and run_id is not distinct from p_expected_run_id
    and status is distinct from 'published'
    and ebay_listing_id is null
    and ebay_status is distinct from 'published'
    and (
      ebay_status is distinct from 'publishing'
      or ebay_publish_claimed_at is null
      or ebay_publish_claimed_at < now() - interval '15 minutes'
    )
  returning title, description, copy
  into v_title, v_description, v_copy;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Editable eBay listing changed or is already publishing or published.';
  end if;
  if jsonb_typeof(v_copy) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Listing copy must be an object.';
  end if;
  select price
  into v_price
  from public.prediction_logs
  where item_id = v_item_id
    and user_id = v_user_id
  order by created_at desc
  limit 1;

  return jsonb_build_object(
    'claimId', v_claim_id,
    'listingId', p_listing_id,
    'itemId', v_item_id,
    'title', v_title,
    'description', v_description,
    'copy', coalesce(v_copy, '{}'::jsonb),
    'condition', v_condition,
    'photos', coalesce(to_jsonb(v_photos), '[]'::jsonb),
    'price', v_price
  );
end;
$$;

revoke all on function public.begin_ebay_publish(uuid, uuid, uuid) from public;
grant execute on function public.begin_ebay_publish(uuid, uuid, uuid) to authenticated;

create or replace function public.regenerate_review_listing(
  p_item_id uuid,
  p_listing_id uuid,
  p_run_id uuid,
  p_expected_run_id uuid,
  p_expected_review_revision uuid,
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
  if p_expected_review_revision is null then
    raise exception using errcode = '22023', message = 'Review revision is required.';
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
  where id = p_item_id
    and user_id = v_user_id
    and review_revision is not distinct from p_expected_review_revision
  for update;
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

  update public.items
  set attributes = p_attributes,
      condition = p_condition,
      identification = p_identification,
      review_revision = p_run_id,
      review_content_revision = p_run_id
  where id = p_item_id and user_id = v_user_id;

  -- Updating in place avoids leaving an older queued/stale draft publishable. A
  -- published listing is outside this pre-publish workflow and is rejected. The
  -- draft reset ensures manual regeneration never auto-publishes.
  update public.listings
  set title = p_listing_title,
      description = p_listing_description,
      copy = p_listing_copy,
      status = 'draft',
      run_id = p_run_id,
      ebay_publish_claim_id = null,
      ebay_publish_claimed_at = null
  where id = p_listing_id
    and item_id = p_item_id
    and user_id = v_user_id
    and platform = 'ebay'
    and run_id is not distinct from p_expected_run_id
    and status is distinct from 'published'
    and ebay_listing_id is null
    and ebay_status is distinct from 'publishing'
    and ebay_status is distinct from 'published';
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
  uuid, uuid, uuid, uuid, uuid, jsonb, text, jsonb, text, text, jsonb, numeric, jsonb,
  numeric, text, text, text, text, jsonb, boolean, boolean
) from public;

grant execute on function public.regenerate_review_listing(
  uuid, uuid, uuid, uuid, uuid, jsonb, text, jsonb, text, text, jsonb, numeric, jsonb,
  numeric, text, text, text, text, jsonb, boolean, boolean
) to authenticated;

create or replace function public.save_review_edits(
  p_item_id uuid,
  p_listing_id uuid,
  p_expected_review_revision uuid,
  p_new_review_revision uuid,
  p_attributes jsonb,
  p_condition text,
  p_price_override numeric,
  p_cost_basis numeric,
  p_listing_title text,
  p_listing_description text
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
  if p_expected_review_revision is null or p_new_review_revision is null then
    raise exception using errcode = '22023', message = 'Review revision is required.';
  end if;
  if jsonb_typeof(p_attributes) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Attributes must be an object.';
  end if;
  if p_price_override is not null and p_price_override <= 0 then
    raise exception using errcode = '22023', message = 'Price override is invalid.';
  end if;
  if p_cost_basis is not null and p_cost_basis < 0 then
    raise exception using errcode = '22023', message = 'Cost basis is invalid.';
  end if;

  update public.items
  set attributes = case
        when p_attributes ? 'measurements'
          then jsonb_set(attributes, '{measurements}', p_attributes -> 'measurements', true)
        else attributes - 'measurements'
      end,
      price_override = p_price_override,
      cost_basis = p_cost_basis,
      review_revision = p_new_review_revision,
      review_content_revision = p_new_review_revision
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

  if p_listing_id is not null then
    if p_listing_title is null or btrim(p_listing_title) = '' or char_length(p_listing_title) > 80 then
      raise exception using errcode = '22023', message = 'Listing title is invalid.';
    end if;
    if p_listing_description is null or btrim(p_listing_description) = '' then
      raise exception using errcode = '22023', message = 'Listing description is invalid.';
    end if;

    update public.listings
    set title = p_listing_title,
        description = p_listing_description
    where id = p_listing_id
      and item_id = p_item_id
      and user_id = v_user_id
      and platform = 'ebay'
      and status is distinct from 'published'
      and ebay_listing_id is null
      and ebay_status is distinct from 'publishing'
      and ebay_status is distinct from 'published';
    if not found then
      raise exception using errcode = 'P0002', message = 'Listing not found.';
    end if;
  end if;

  delete from public.listings
  where item_id = p_item_id
    and user_id = v_user_id
    and platform in ('facebook', 'mercari');
end;
$$;

revoke all on function public.save_review_edits(
  uuid, uuid, uuid, uuid, jsonb, text, numeric, numeric, text, text
) from public;
grant execute on function public.save_review_edits(
  uuid, uuid, uuid, uuid, jsonb, text, numeric, numeric, text, text
) to authenticated;

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
  if p_expected_review_revision is null or p_run_id is null then
    raise exception using errcode = '22023', message = 'Review revision is required.';
  end if;
  if jsonb_typeof(p_attributes) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Attributes must be an object.';
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
  boolean, boolean
) from public;
grant execute on function public.sharpen_review_estimate(
  uuid, uuid, uuid, jsonb, numeric, jsonb, numeric, text, text, text, text, jsonb,
  boolean, boolean
) to authenticated;

create or replace function public.persist_export_packs(
  p_item_id uuid,
  p_source_review_revision uuid,
  p_packs jsonb
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
  if p_source_review_revision is null then
    raise exception using errcode = '22023', message = 'Source review revision is required.';
  end if;
  if jsonb_typeof(p_packs) is distinct from 'array'
    or jsonb_array_length(p_packs) < 1
    or jsonb_array_length(p_packs) > 2 then
    raise exception using errcode = '22023', message = 'Export packs are invalid.';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_packs) as pack(
      platform text,
      title text,
      description text,
      copy jsonb
    )
    where pack.platform not in ('facebook', 'mercari')
      or pack.title is null
      or btrim(pack.title) = ''
      or pack.description is null
      or btrim(pack.description) = ''
      or jsonb_typeof(pack.copy) is distinct from 'object'
  ) then
    raise exception using errcode = '22023', message = 'Export packs are invalid.';
  end if;

  perform 1
  from public.items
  where id = p_item_id
    and user_id = v_user_id
    and review_content_revision is not distinct from p_source_review_revision
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Review changed. Reload and try again.';
  end if;

  insert into public.listings (
    user_id, item_id, platform, title, description, copy, status, source_review_revision
  )
  select
    v_user_id,
    p_item_id,
    pack.platform,
    pack.title,
    pack.description,
    pack.copy,
    'draft',
    p_source_review_revision
  from jsonb_to_recordset(p_packs) as pack(
    platform text,
    title text,
    description text,
    copy jsonb
  )
  on conflict (item_id, platform, source_review_revision) do update
  set title = excluded.title,
      description = excluded.description,
      copy = excluded.copy,
      status = 'draft'
  where listings.user_id = v_user_id;
end;
$$;

revoke all on function public.persist_export_packs(uuid, uuid, jsonb) from public;
grant execute on function public.persist_export_packs(uuid, uuid, jsonb) to authenticated;
