create or replace function private.assert_ebay_dispatch_completion(
  p_user_id text,
  p_resource_id uuid,
  p_operation text,
  p_account_generation uuid,
  p_attempt_token uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account private.ebay_messaging_account_generations%rowtype;
begin
  v_account := private.lock_ebay_messaging_account(p_user_id);
  if v_account.seller_erased
    or v_account.generation is distinct from p_account_generation then
    raise exception using errcode = '40001', message = 'eBay account generation changed before local completion';
  end if;

  perform 1
  from private.ebay_provider_dispatch_leases lease
  where lease.user_id = p_user_id
    and lease.message_id = p_resource_id
    and lease.dispatch_kind = p_operation
    and lease.account_generation = p_account_generation
    and lease.attempt_token = p_attempt_token
    and lease.expires_at > statement_timestamp()
  for update;
  if not found then
    raise exception using errcode = '40001', message = 'eBay provider dispatch lease expired before local completion';
  end if;
end;
$$;

revoke all on function private.assert_ebay_dispatch_completion(
  text, uuid, text, uuid, uuid
) from public, anon, authenticated, service_role;

create or replace function private.consume_ebay_dispatch_completion(
  p_user_id text,
  p_resource_id uuid,
  p_operation text,
  p_account_generation uuid,
  p_attempt_token uuid
)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from private.ebay_provider_dispatch_leases lease
  where lease.user_id = p_user_id
    and lease.message_id = p_resource_id
    and lease.dispatch_kind = p_operation
    and lease.account_generation = p_account_generation
    and lease.attempt_token = p_attempt_token;
$$;

revoke all on function private.consume_ebay_dispatch_completion(
  text, uuid, text, uuid, uuid
) from public, anon, authenticated, service_role;

create or replace function public.complete_ebay_publish_dispatch(
  p_listing_id uuid,
  p_claim_id uuid,
  p_account_generation uuid,
  p_attempt_token uuid,
  p_ebay_listing_id text,
  p_ebay_offer_id text,
  p_listed_price numeric,
  p_priced_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_api_key text := coalesce(
    (nullif(current_setting('request.headers', true), '')::jsonb)->>'apikey',
    ''
  );
begin
  if coalesce(auth.jwt()->>'role', '') <> 'authenticated' or v_user_id = '' then
    raise exception using errcode = '42501', message = 'Seller authorization is required';
  end if;
  if v_api_key not like 'sb_secret_%' then
    raise exception using errcode = '42501', message = 'Server API authorization is required';
  end if;

  perform private.assert_ebay_dispatch_completion(
    v_user_id,
    p_listing_id,
    'publish',
    p_account_generation,
    p_attempt_token
  );

  update public.listings listing
  set ebay_listing_id = p_ebay_listing_id,
      ebay_offer_id = p_ebay_offer_id,
      ebay_status = 'published',
      status = 'published',
      listed_price = p_listed_price,
      last_priced_at = p_priced_at,
      ebay_publish_claim_id = null,
      ebay_publish_claimed_at = null
  where listing.id = p_listing_id
    and listing.user_id = v_user_id
    and listing.platform = 'ebay'
    and listing.ebay_status = 'publishing'
    and listing.ebay_publish_claim_id = p_claim_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'eBay publish claim was lost before local completion';
  end if;

  perform private.consume_ebay_dispatch_completion(
    v_user_id,
    p_listing_id,
    'publish',
    p_account_generation,
    p_attempt_token
  );
end;
$$;

revoke all on function public.complete_ebay_publish_dispatch(
  uuid, uuid, uuid, uuid, text, text, numeric, timestamptz
) from public, anon, service_role;
grant execute on function public.complete_ebay_publish_dispatch(
  uuid, uuid, uuid, uuid, text, text, numeric, timestamptz
) to authenticated;

create or replace function public.complete_ebay_reprice_dispatch(
  p_listing_id uuid,
  p_item_id uuid,
  p_suggestion_id uuid,
  p_account_generation uuid,
  p_attempt_token uuid,
  p_applied_price numeric,
  p_resolved_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_api_key text := coalesce(
    (nullif(current_setting('request.headers', true), '')::jsonb)->>'apikey',
    ''
  );
begin
  if coalesce(auth.jwt()->>'role', '') <> 'authenticated' or v_user_id = '' then
    raise exception using errcode = '42501', message = 'Seller authorization is required';
  end if;
  if v_api_key not like 'sb_secret_%' then
    raise exception using errcode = '42501', message = 'Server API authorization is required';
  end if;

  perform private.assert_ebay_dispatch_completion(
    v_user_id,
    p_listing_id,
    'reprice',
    p_account_generation,
    p_attempt_token
  );

  update public.reprice_suggestions suggestion
  set status = 'applied',
      applied_price = p_applied_price,
      resolved_at = p_resolved_at
  where suggestion.id = p_suggestion_id
    and suggestion.user_id = v_user_id
    and suggestion.listing_id = p_listing_id
    and suggestion.item_id = p_item_id
    and suggestion.status = 'pending';
  if not found then
    raise exception using errcode = 'P0002', message = 'eBay reprice suggestion was resolved before local completion';
  end if;

  update public.items item
  set price_override = p_applied_price,
      review_revision = gen_random_uuid()
  where item.id = p_item_id
    and item.user_id = v_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'eBay reprice item was unavailable before local completion';
  end if;

  update public.listings listing
  set listed_price = p_applied_price,
      last_priced_at = p_resolved_at
  where listing.id = p_listing_id
    and listing.user_id = v_user_id
    and listing.item_id = p_item_id
    and listing.platform = 'ebay'
    and listing.ebay_status = 'published';
  if not found then
    raise exception using errcode = 'P0002', message = 'eBay reprice listing was unavailable before local completion';
  end if;

  perform private.consume_ebay_dispatch_completion(
    v_user_id,
    p_listing_id,
    'reprice',
    p_account_generation,
    p_attempt_token
  );
end;
$$;

revoke all on function public.complete_ebay_reprice_dispatch(
  uuid, uuid, uuid, uuid, uuid, numeric, timestamptz
) from public, anon, service_role;
grant execute on function public.complete_ebay_reprice_dispatch(
  uuid, uuid, uuid, uuid, uuid, numeric, timestamptz
) to authenticated;

create or replace function public.complete_scheduled_ebay_reprice_dispatch(
  p_listing_id uuid,
  p_item_id uuid,
  p_account_generation uuid,
  p_attempt_token uuid,
  p_applied_price numeric,
  p_resolved_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Scheduler authorization is required';
  end if;

  select lease.user_id
  into v_user_id
  from private.ebay_provider_dispatch_leases lease
  where lease.message_id = p_listing_id
    and lease.dispatch_kind = 'reprice'
    and lease.account_generation = p_account_generation
    and lease.attempt_token = p_attempt_token;
  if not found then
    raise exception using errcode = '40001', message = 'Scheduled eBay provider dispatch lease is unavailable';
  end if;

  perform private.assert_ebay_dispatch_completion(
    v_user_id,
    p_listing_id,
    'reprice',
    p_account_generation,
    p_attempt_token
  );

  update public.items item
  set price_override = p_applied_price,
      review_revision = gen_random_uuid()
  where item.id = p_item_id
    and item.user_id = v_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Scheduled eBay reprice item was unavailable before local completion';
  end if;

  update public.listings listing
  set listed_price = p_applied_price,
      last_priced_at = p_resolved_at
  where listing.id = p_listing_id
    and listing.user_id = v_user_id
    and listing.item_id = p_item_id
    and listing.platform = 'ebay'
    and listing.ebay_status = 'published';
  if not found then
    raise exception using errcode = 'P0002', message = 'Scheduled eBay reprice listing was unavailable before local completion';
  end if;

  perform private.consume_ebay_dispatch_completion(
    v_user_id,
    p_listing_id,
    'reprice',
    p_account_generation,
    p_attempt_token
  );
  return v_user_id;
end;
$$;

revoke all on function public.complete_scheduled_ebay_reprice_dispatch(
  uuid, uuid, uuid, uuid, numeric, timestamptz
) from public, anon, authenticated;
grant execute on function public.complete_scheduled_ebay_reprice_dispatch(
  uuid, uuid, uuid, uuid, numeric, timestamptz
) to service_role;
