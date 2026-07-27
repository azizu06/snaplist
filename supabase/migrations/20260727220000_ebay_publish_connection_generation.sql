alter table public.listings
  add column ebay_publish_connection_generation uuid;

comment on column public.listings.ebay_publish_connection_generation is
  'Connection generation pinned to the current eBay publish claim and retained on its acknowledged result.';

alter table private.ebay_provider_dispatch_leases
  add column connection_generation uuid,
  add column publish_claim_id uuid;

comment on column private.ebay_provider_dispatch_leases.connection_generation is
  'Exact connected-seller generation for publish; null only for account-bound operator Sandbox fallback and non-publish operations.';

comment on column private.ebay_provider_dispatch_leases.publish_claim_id is
  'Exact local publish claim that authorized a publish dispatch; null for non-publish operations.';

create function public.bind_ebay_publish_connection_generation(
  p_listing_id uuid,
  p_claim_id uuid,
  p_marketplace_id text,
  p_connection_generation uuid,
  p_fulfillment_policy_id text,
  p_payment_policy_id text,
  p_return_policy_id text,
  p_merchant_location_key text
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
  v_binding jsonb;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'authenticated'
    or nullif(v_user_id, '') is null then
    raise exception using errcode = '42501', message = 'Seller authorization is required';
  end if;
  if v_api_key not like 'sb_secret_%' then
    raise exception using errcode = '42501', message = 'Server API authorization is required';
  end if;
  if nullif(btrim(p_marketplace_id), '') is null
    or p_connection_generation is null
    or nullif(btrim(p_fulfillment_policy_id), '') is null
    or nullif(btrim(p_payment_policy_id), '') is null
    or nullif(btrim(p_return_policy_id), '') is null
    or nullif(btrim(p_merchant_location_key), '') is null then
    raise exception using errcode = '22023', message = 'A complete eBay offer binding is required';
  end if;

  select connection.policy_location_bindings -> p_marketplace_id
  into v_binding
  from public.ebay_connections connection
  where connection.user_id = v_user_id
    and connection.connection_generation = p_connection_generation
  for update;
  if not found
    or v_binding is null
    or v_binding->>'state' <> 'ready'
    or v_binding->>'marketplaceId' <> p_marketplace_id
    or v_binding->>'connectionGeneration' <> p_connection_generation::text
    or v_binding#>>'{fulfillmentPolicy,state}' <> 'bound'
    or v_binding#>>'{fulfillmentPolicy,selectedId}' <> p_fulfillment_policy_id
    or v_binding#>>'{paymentPolicy,state}' <> 'bound'
    or v_binding#>>'{paymentPolicy,selectedId}' <> p_payment_policy_id
    or v_binding#>>'{returnPolicy,state}' <> 'bound'
    or v_binding#>>'{returnPolicy,selectedId}' <> p_return_policy_id
    or v_binding#>>'{inventoryLocation,state}' <> 'bound'
    or v_binding#>>'{inventoryLocation,selectedId}' <> p_merchant_location_key then
    raise exception using
      errcode = 'PT409',
      message = 'eBay connection generation changed before publish dispatch';
  end if;

  update public.listings listing
  set ebay_publish_connection_generation = p_connection_generation
  where listing.id = p_listing_id
    and listing.user_id = v_user_id
    and listing.platform = 'ebay'
    and listing.ebay_status = 'publishing'
    and listing.ebay_publish_claim_id = p_claim_id;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'eBay publish claim was lost before connection binding';
  end if;
end;
$$;

revoke all on function public.bind_ebay_publish_connection_generation(
  uuid, uuid, text, uuid, text, text, text, text
) from public, anon;
grant execute on function public.bind_ebay_publish_connection_generation(
  uuid, uuid, text, uuid, text, text, text, text
) to authenticated;

create function private.begin_ebay_publish_dispatch_for_tenant(
  p_user_id text,
  p_resource_id uuid,
  p_account_generation uuid,
  p_connection_generation uuid,
  p_publish_claim_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account private.ebay_messaging_account_generations%rowtype;
  v_attempted_at timestamptz := statement_timestamp();
  v_attempt_token uuid := gen_random_uuid();
begin
  if p_publish_claim_id is null then
    raise exception using
      errcode = '22023',
      message = 'An exact eBay publish claim is required';
  end if;
  v_account := private.lock_ebay_messaging_account(p_user_id);
  perform private.expire_ebay_provider_dispatch_leases(p_user_id);
  if v_account.seller_erased
    or v_account.generation is distinct from p_account_generation then
    raise exception using
      errcode = 'PT409',
      message = 'eBay account generation changed before provider dispatch';
  end if;

  if p_connection_generation is not null then
    perform 1
    from public.ebay_connections connection
    where connection.user_id = p_user_id
      and connection.account_generation = p_account_generation
      and connection.connection_generation = p_connection_generation
    for update;
    if not found then
      raise exception using
        errcode = 'PT409',
        message = 'eBay connection generation changed before provider dispatch';
    end if;
  else
    if exists (
      select 1
      from public.ebay_connections connection
      where connection.user_id = p_user_id
    ) or not exists (
      select 1
      from private.ebay_sandbox_fallback_bindings binding
      where binding.user_id = p_user_id
        and binding.account_generation = p_account_generation
    ) then
      raise exception using
        errcode = '42501',
        message = 'A current eBay connection generation is required';
    end if;
  end if;

  perform 1
  from public.listings listing
  where listing.id = p_resource_id
    and listing.user_id = p_user_id
    and listing.platform = 'ebay'
    and listing.ebay_status = 'publishing'
    and listing.ebay_publish_claim_id = p_publish_claim_id
    and listing.ebay_publish_connection_generation
      is not distinct from p_connection_generation
  for update;
  if not found then
    raise exception using
      errcode = 'PT409',
      message = 'eBay publish claim connection generation changed before provider dispatch';
  end if;

  insert into private.ebay_provider_dispatch_leases (
    user_id,
    message_id,
    account_generation,
    connection_generation,
    publish_claim_id,
    dispatch_kind,
    attempt_token,
    attempted_at,
    expires_at
  ) values (
    p_user_id,
    p_resource_id,
    p_account_generation,
    p_connection_generation,
    p_publish_claim_id,
    'publish',
    v_attempt_token,
    v_attempted_at,
    v_attempted_at + interval '5 minutes'
  );

  return jsonb_build_object(
    'account_generation', p_account_generation,
    'connection_generation', p_connection_generation,
    'publish_claim_id', p_publish_claim_id,
    'attempt_token', v_attempt_token,
    'attempted_at', v_attempted_at
  );
exception when unique_violation then
  raise exception using
    errcode = 'PT409',
    message = 'eBay provider dispatch is already active';
end;
$$;

revoke all on function private.begin_ebay_publish_dispatch_for_tenant(
  text, uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role;

drop function public.begin_ebay_transactional_dispatch(uuid, text);

create function public.begin_ebay_transactional_dispatch(
  p_resource_id uuid,
  p_operation text,
  p_connection_generation uuid default null,
  p_publish_claim_id uuid default null
)
returns jsonb
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
  v_account private.ebay_messaging_account_generations%rowtype;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'authenticated' or v_user_id = '' then
    raise exception using errcode = '42501', message = 'Seller authorization is required';
  end if;
  if v_api_key not like 'sb_secret_%' then
    raise exception using errcode = '42501', message = 'Server API authorization is required';
  end if;
  if p_operation = 'publish' then
    v_account := private.lock_ebay_messaging_account(v_user_id);
    return private.begin_ebay_publish_dispatch_for_tenant(
      v_user_id,
      p_resource_id,
      v_account.generation,
      p_connection_generation,
      p_publish_claim_id
    );
  end if;
  return private.begin_ebay_transactional_dispatch_for_tenant(
    v_user_id,
    p_resource_id,
    p_operation
  );
end;
$$;

revoke all on function public.begin_ebay_transactional_dispatch(
  uuid, text, uuid, uuid
) from public, anon, service_role;
grant execute on function public.begin_ebay_transactional_dispatch(
  uuid, text, uuid, uuid
) to authenticated;

create function private.renew_ebay_publish_dispatch_for_tenant(
  p_user_id text,
  p_resource_id uuid,
  p_account_generation uuid,
  p_connection_generation uuid,
  p_publish_claim_id uuid,
  p_attempt_token uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_connection_generation is not null then
    perform 1
    from public.ebay_connections connection
    where connection.user_id = p_user_id
      and connection.account_generation = p_account_generation
      and connection.connection_generation = p_connection_generation
    for update;
    if not found then
      raise exception using
        errcode = 'PT409',
        message = 'eBay connection generation changed during provider dispatch';
    end if;
  else
    if exists (
      select 1
      from public.ebay_connections connection
      where connection.user_id = p_user_id
    ) or not exists (
      select 1
      from private.ebay_sandbox_fallback_bindings binding
      where binding.user_id = p_user_id
        and binding.account_generation = p_account_generation
    ) then
      raise exception using
        errcode = 'PT409',
        message = 'eBay Sandbox fallback generation changed during provider dispatch';
    end if;
  end if;

  perform 1
  from public.listings listing
  where listing.id = p_resource_id
    and listing.user_id = p_user_id
    and listing.platform = 'ebay'
    and listing.ebay_status = 'publishing'
    and listing.ebay_publish_claim_id = p_publish_claim_id
    and listing.ebay_publish_connection_generation
      is not distinct from p_connection_generation
  for update;
  if not found then
    raise exception using
      errcode = 'PT409',
      message = 'eBay publish claim changed during provider dispatch';
  end if;

  update private.ebay_provider_dispatch_leases lease
  set expires_at = statement_timestamp() + interval '5 minutes'
  where lease.user_id = p_user_id
    and lease.message_id = p_resource_id
    and lease.dispatch_kind = 'publish'
    and lease.account_generation = p_account_generation
    and lease.connection_generation is not distinct from p_connection_generation
    and lease.publish_claim_id = p_publish_claim_id
    and lease.attempt_token = p_attempt_token
    and lease.expires_at > statement_timestamp();
  if not found then
    raise exception using
      errcode = 'PT409',
      message = 'eBay provider dispatch lease expired';
  end if;
end;
$$;

revoke all on function private.renew_ebay_publish_dispatch_for_tenant(
  text, uuid, uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role;

drop function public.renew_ebay_transactional_dispatch(
  uuid, text, uuid, uuid
);

create function public.renew_ebay_transactional_dispatch(
  p_resource_id uuid,
  p_operation text,
  p_account_generation uuid,
  p_attempt_token uuid,
  p_connection_generation uuid default null,
  p_publish_claim_id uuid default null
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
  if p_operation = 'publish' then
    perform private.renew_ebay_publish_dispatch_for_tenant(
      v_user_id,
      p_resource_id,
      p_account_generation,
      p_connection_generation,
      p_publish_claim_id,
      p_attempt_token
    );
    return;
  end if;
  perform private.renew_ebay_transactional_dispatch_for_tenant(
    v_user_id,
    p_resource_id,
    p_operation,
    p_account_generation,
    p_attempt_token
  );
end;
$$;

revoke all on function public.renew_ebay_transactional_dispatch(
  uuid, text, uuid, uuid, uuid, uuid
) from public, anon, service_role;
grant execute on function public.renew_ebay_transactional_dispatch(
  uuid, text, uuid, uuid, uuid, uuid
) to authenticated;

drop function public.end_ebay_transactional_dispatch(
  uuid, text, uuid, uuid
);

create function public.end_ebay_transactional_dispatch(
  p_resource_id uuid,
  p_operation text,
  p_account_generation uuid,
  p_attempt_token uuid,
  p_connection_generation uuid default null,
  p_publish_claim_id uuid default null
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
  if p_operation = 'publish' and p_publish_claim_id is null then
    raise exception using
      errcode = '22023',
      message = 'An exact eBay publish claim is required';
  end if;
  delete from private.ebay_provider_dispatch_leases lease
  where lease.user_id = v_user_id
    and lease.message_id = p_resource_id
    and lease.dispatch_kind = p_operation
    and lease.account_generation = p_account_generation
    and lease.connection_generation is not distinct from p_connection_generation
    and lease.publish_claim_id is not distinct from p_publish_claim_id
    and lease.attempt_token = p_attempt_token
    and (
      p_operation <> 'publish'
      or exists (
        select 1
        from public.listings listing
        where listing.id = p_resource_id
          and listing.user_id = v_user_id
          and listing.platform = 'ebay'
          and listing.ebay_status = 'publishing'
          and listing.ebay_publish_claim_id = p_publish_claim_id
          and listing.ebay_publish_connection_generation
            is not distinct from p_connection_generation
      )
    );
end;
$$;

revoke all on function public.end_ebay_transactional_dispatch(
  uuid, text, uuid, uuid, uuid, uuid
) from public, anon, service_role;
grant execute on function public.end_ebay_transactional_dispatch(
  uuid, text, uuid, uuid, uuid, uuid
) to authenticated;

drop function public.complete_ebay_publish_dispatch(
  uuid, uuid, uuid, uuid, text, text, numeric, timestamptz
);

create function public.complete_ebay_publish_dispatch(
  p_listing_id uuid,
  p_claim_id uuid,
  p_account_generation uuid,
  p_connection_generation uuid,
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
  v_account private.ebay_messaging_account_generations%rowtype;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'authenticated' or v_user_id = '' then
    raise exception using errcode = '42501', message = 'Seller authorization is required';
  end if;
  if v_api_key not like 'sb_secret_%' then
    raise exception using errcode = '42501', message = 'Server API authorization is required';
  end if;

  v_account := private.lock_ebay_messaging_account(v_user_id);
  if v_account.seller_erased
    or v_account.generation is distinct from p_account_generation then
    raise exception using
      errcode = 'PT409',
      message = 'eBay account generation changed before local completion';
  end if;

  if p_connection_generation is not null then
    perform 1
    from public.ebay_connections connection
    where connection.user_id = v_user_id
      and connection.account_generation = p_account_generation
      and connection.connection_generation = p_connection_generation
    for update;
    if not found then
      raise exception using
        errcode = 'PT409',
        message = 'eBay connection generation changed before local completion';
    end if;
  else
    if exists (
      select 1
      from public.ebay_connections connection
      where connection.user_id = v_user_id
    ) or not exists (
      select 1
      from private.ebay_sandbox_fallback_bindings binding
      where binding.user_id = v_user_id
        and binding.account_generation = p_account_generation
    ) then
      raise exception using
        errcode = 'PT409',
        message = 'eBay Sandbox fallback generation changed before local completion';
    end if;
  end if;

  perform 1
  from private.ebay_provider_dispatch_leases lease
  where lease.user_id = v_user_id
    and lease.message_id = p_listing_id
    and lease.dispatch_kind = 'publish'
    and lease.account_generation = p_account_generation
    and lease.connection_generation is not distinct from p_connection_generation
    and lease.publish_claim_id = p_claim_id
    and lease.attempt_token = p_attempt_token
    and lease.expires_at > statement_timestamp()
  for update;
  if not found then
    raise exception using
      errcode = 'PT409',
      message = 'eBay provider dispatch lease expired before local completion';
  end if;

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
    and listing.ebay_publish_claim_id = p_claim_id
    and listing.ebay_publish_connection_generation
      is not distinct from p_connection_generation;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'eBay publish claim was lost before local completion';
  end if;

  delete from private.ebay_provider_dispatch_leases lease
  where lease.user_id = v_user_id
    and lease.message_id = p_listing_id
    and lease.dispatch_kind = 'publish'
    and lease.account_generation = p_account_generation
    and lease.connection_generation is not distinct from p_connection_generation
    and lease.publish_claim_id = p_claim_id
    and lease.attempt_token = p_attempt_token;
end;
$$;

revoke all on function public.complete_ebay_publish_dispatch(
  uuid, uuid, uuid, uuid, uuid, text, text, numeric, timestamptz
) from public, anon, service_role;
grant execute on function public.complete_ebay_publish_dispatch(
  uuid, uuid, uuid, uuid, uuid, text, text, numeric, timestamptz
) to authenticated;

-- Coordination with parked #384: its later rebase must include both new
-- connection-generation columns in account-erasure residue and exact
-- claim/lease cleanup predicates. This migration intentionally does not change
-- deletion or erasure behavior.
