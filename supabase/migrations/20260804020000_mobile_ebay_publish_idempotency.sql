alter table public.listings
  add column ebay_publish_idempotency_key uuid,
  add column ebay_publish_expected_review_revision uuid;

comment on column public.listings.ebay_publish_idempotency_key is
  'Mobile confirmation key retained across an ambiguous eBay publish for exact replay.';
comment on column public.listings.ebay_publish_expected_review_revision is
  'Seller-observed review revision paired with the mobile publish confirmation.';

create function public.begin_mobile_ebay_publish(
  p_listing_id uuid,
  p_expected_run_id uuid,
  p_expected_review_revision uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_listing public.listings%rowtype;
  v_item_revision uuid;
  v_snapshot jsonb;
  v_claim jsonb;
  v_claim_id uuid;
begin
  if nullif(v_user_id, '') is null then
    raise exception using errcode = '42501', message = 'Authentication required.';
  end if;
  if p_idempotency_key is null or p_expected_review_revision is null then
    raise exception using errcode = '22023', message = 'Publish confirmation is required.';
  end if;

  select listing.*
  into v_listing
  from public.listings listing
  where listing.id = p_listing_id
    and listing.user_id = v_user_id
    and listing.platform = 'ebay'
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Editable eBay listing changed.';
  end if;

  if v_listing.ebay_status = 'publishing'
    and v_listing.ebay_publish_idempotency_key = p_idempotency_key then
    if v_listing.ebay_publish_expected_review_revision
      is distinct from p_expected_review_revision then
      raise exception using errcode = 'P0002', message = 'Publish confirmation changed.';
    end if;
    select item.review_revision
    into v_item_revision
    from public.items item
    where item.id = v_listing.item_id
      and item.user_id = v_user_id
    for update;
    if v_item_revision is distinct from v_listing.ebay_publish_claim_id then
      raise exception using errcode = 'P0002', message = 'Publish claim changed.';
    end if;
    v_snapshot := public.get_review_snapshot(v_listing.item_id);
    if v_snapshot is null
      or v_snapshot#>>'{listing,id}' is distinct from p_listing_id::text then
      raise exception using errcode = 'P0002', message = 'Publish snapshot changed.';
    end if;
    return jsonb_build_object(
      'claimId', v_listing.ebay_publish_claim_id,
      'listingId', p_listing_id,
      'itemId', v_listing.item_id,
      'title', v_snapshot#>>'{listing,title}',
      'description', v_snapshot#>>'{listing,description}',
      'copy', coalesce(v_snapshot#>'{listing,copy}', '{}'::jsonb),
      'condition', v_snapshot#>>'{item,condition}',
      'photos', coalesce(v_snapshot#>'{item,photos}', '[]'::jsonb),
      'price', v_snapshot#>'{prediction,price}',
      'priceOverride', v_snapshot#>'{item,price_override}'
    );
  end if;

  v_claim := public.begin_ebay_publish(
    p_listing_id,
    p_expected_run_id,
    p_expected_review_revision
  );
  v_claim_id := nullif(v_claim->>'claimId', '')::uuid;
  update public.listings listing
  set ebay_publish_idempotency_key = p_idempotency_key,
      ebay_publish_expected_review_revision = p_expected_review_revision
  where listing.id = p_listing_id
    and listing.user_id = v_user_id
    and listing.ebay_status = 'publishing'
    and listing.ebay_publish_claim_id = v_claim_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Publish claim was lost.';
  end if;
  return v_claim;
end;
$$;

revoke all on function public.begin_mobile_ebay_publish(uuid, uuid, uuid, uuid)
  from public, anon;
grant execute on function public.begin_mobile_ebay_publish(uuid, uuid, uuid, uuid)
  to authenticated;
