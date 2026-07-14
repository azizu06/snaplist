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
  v_price_override numeric;
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
  returning condition, photos, price_override
  into v_condition, v_photos, v_price_override;
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
    'price', v_price,
    'priceOverride', v_price_override
  );
end;
$$;

revoke all on function public.begin_ebay_publish(uuid, uuid, uuid) from public;
grant execute on function public.begin_ebay_publish(uuid, uuid, uuid) to authenticated;

create or replace function public.reject_price_override_while_ebay_publishing()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.price_override is distinct from old.price_override
    and exists (
      select 1
      from public.listings listing
      where listing.item_id = old.id
        and listing.user_id = old.user_id
        and listing.platform = 'ebay'
        and listing.ebay_status is not distinct from 'publishing'
    ) then
    raise exception using
      errcode = 'P0002',
      message = 'Seller price cannot change while the eBay listing is publishing.';
  end if;
  return new;
end;
$$;

revoke all on function public.reject_price_override_while_ebay_publishing() from public;

drop trigger if exists reject_price_override_while_ebay_publishing on public.items;
create trigger reject_price_override_while_ebay_publishing
before update of price_override on public.items
for each row execute function public.reject_price_override_while_ebay_publishing();

drop function if exists public.persist_export_packs(uuid, uuid, jsonb);

create or replace function public.persist_export_packs(
  p_item_id uuid,
  p_source_review_revision uuid,
  p_expected_review_revision uuid,
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
  if p_source_review_revision is null or p_expected_review_revision is null then
    raise exception using errcode = '22023', message = 'Export revisions are required.';
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
    and review_revision is not distinct from p_expected_review_revision
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Review or seller price changed. Reload and try again.';
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

revoke all on function public.persist_export_packs(uuid, uuid, uuid, jsonb) from public;
grant execute on function public.persist_export_packs(uuid, uuid, uuid, jsonb) to authenticated;
