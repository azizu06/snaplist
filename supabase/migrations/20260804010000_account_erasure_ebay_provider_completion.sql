-- Restore the provider-completion handoff intended by issue #384.
--
-- Once eBay has accepted a publish, account erasure must wait for that exact
-- dispatch to finish locally. Refusing the completion loses the only durable
-- record that the live eBay listing exists; allowing arbitrary writes would
-- defeat the erasure fence. The authorization below therefore proves the
-- already-started dispatch without inserting or updating anything, then sets
-- transaction-local context consumed by the existing row fence.

create function private.authorize_account_erasure_ebay_publish_completion(
  p_user_id text,
  p_listing_id uuid,
  p_claim_id uuid,
  p_account_generation uuid,
  p_connection_generation uuid,
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
  -- Do not call private.lock_ebay_messaging_account here. Its defensive
  -- INSERT fires the erasure fence before completion context exists. A
  -- provider dispatch cannot exist without this account row, so absence is a
  -- stale completion rather than a reason to create one.
  select account.*
  into v_account
  from private.ebay_messaging_account_generations account
  where account.user_id = p_user_id
  for update;

  if not found
    or v_account.seller_erased
    or v_account.generation is distinct from p_account_generation then
    raise exception using
      errcode = 'PT409',
      message = 'eBay account generation changed before local completion';
  end if;

  -- One proof binds every authority dimension: tenant, listing, operation,
  -- account generation, connection generation, publish claim, attempt token,
  -- unexpired lease, and immutable offer binding. It takes row locks but makes
  -- no mutation, so the account-erasure fence remains closed until the proof
  -- succeeds.
  perform 1
  from private.ebay_provider_dispatch_leases lease
  join public.listings listing
    on listing.id = lease.message_id
   and listing.user_id = lease.user_id
  where lease.user_id = p_user_id
    and lease.message_id = p_listing_id
    and lease.dispatch_kind = 'publish'
    and lease.account_generation = p_account_generation
    and lease.connection_generation is not distinct from p_connection_generation
    and lease.publish_claim_id = p_claim_id
    and lease.attempt_token = p_attempt_token
    and lease.expires_at > statement_timestamp()
    and listing.platform = 'ebay'
    and listing.ebay_status = 'publishing'
    and listing.ebay_publish_claim_id = p_claim_id
    and listing.ebay_publish_connection_generation
      is not distinct from p_connection_generation
    and listing.ebay_publish_binding is not distinct from lease.publish_binding
  for update of lease, listing;

  if not found then
    raise exception using
      errcode = 'PT409',
      message = 'eBay provider dispatch lease or publish claim changed before local completion';
  end if;

  perform set_config(
    'app.account_erasure_provider_completion_user_id', p_user_id, true
  );
  perform set_config(
    'app.account_erasure_provider_completion_resource_id', p_listing_id::text, true
  );
  perform set_config(
    'app.account_erasure_provider_completion_operation', 'publish', true
  );
end;
$$;

comment on function private.authorize_account_erasure_ebay_publish_completion(
  text, uuid, uuid, uuid, uuid, uuid
) is
  'Issue #384 narrow account-erasure exception for one already-dispatched eBay '
  'publish completion. Proves the exact tenant/resource/generations/claim/lease '
  'and attempt before setting transaction-local fence context; mutates no row.';

revoke all on function private.authorize_account_erasure_ebay_publish_completion(
  text, uuid, uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role;

create or replace function public.complete_ebay_publish_dispatch(
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
  v_connection_bindings jsonb;
  v_publish_binding jsonb;
  v_binding jsonb;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'authenticated' or v_user_id = '' then
    raise exception using errcode = '42501', message = 'Seller authorization is required';
  end if;
  if v_api_key not like 'sb_secret_%' then
    raise exception using errcode = '42501', message = 'Server API authorization is required';
  end if;

  -- This is the only added production step. It cannot create or change tenant
  -- data and is unreachable directly from API roles. Once it succeeds, the
  -- original completion body below re-proves the same authority before its
  -- fixed-field listing update.
  perform private.authorize_account_erasure_ebay_publish_completion(
    v_user_id,
    p_listing_id,
    p_claim_id,
    p_account_generation,
    p_connection_generation,
    p_attempt_token
  );

  v_account := private.lock_ebay_messaging_account(v_user_id);
  if v_account.seller_erased
    or v_account.generation is distinct from p_account_generation then
    raise exception using
      errcode = 'PT409',
      message = 'eBay account generation changed before local completion';
  end if;

  if p_connection_generation is not null then
    select connection.policy_location_bindings
    into v_connection_bindings
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

  select lease.publish_binding
  into v_publish_binding
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

  if p_connection_generation is not null then
    v_binding := v_connection_bindings -> (v_publish_binding->>'marketplaceId');
    if v_publish_binding is null
      or v_binding is null
      or v_binding->>'state' <> 'ready'
      or v_binding->>'marketplaceId' <> v_publish_binding->>'marketplaceId'
      or v_binding->>'connectionGeneration' <> p_connection_generation::text
      or v_binding#>>'{fulfillmentPolicy,state}' <> 'bound'
      or v_binding#>>'{fulfillmentPolicy,selectedId}'
        <> v_publish_binding->>'fulfillmentPolicyId'
      or v_binding#>>'{paymentPolicy,state}' <> 'bound'
      or v_binding#>>'{paymentPolicy,selectedId}'
        <> v_publish_binding->>'paymentPolicyId'
      or v_binding#>>'{returnPolicy,state}' <> 'bound'
      or v_binding#>>'{returnPolicy,selectedId}'
        <> v_publish_binding->>'returnPolicyId'
      or v_binding#>>'{inventoryLocation,state}' <> 'bound'
      or v_binding#>>'{inventoryLocation,selectedId}'
        <> v_publish_binding->>'merchantLocationKey' then
      raise exception using
        errcode = 'PT409',
        message = 'eBay offer binding changed before local completion';
    end if;
  elsif v_publish_binding is not null then
    raise exception using
      errcode = 'PT409',
      message = 'eBay Sandbox fallback binding changed before local completion';
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
      is not distinct from p_connection_generation
    and listing.ebay_publish_binding is not distinct from v_publish_binding;
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
    and lease.publish_binding is not distinct from v_publish_binding
    and lease.attempt_token = p_attempt_token;
end;
$$;

comment on function public.complete_ebay_publish_dispatch(
  uuid, uuid, uuid, uuid, uuid, text, text, numeric, timestamptz
) is
  'Completes one exact generation-bound eBay publish. An already-dispatched '
  'completion may cross an account-erasure fence only after the private '
  'read-only authority proof binds every dispatch and claim dimension.';

revoke all on function public.complete_ebay_publish_dispatch(
  uuid, uuid, uuid, uuid, uuid, text, text, numeric, timestamptz
) from public, anon, service_role;
grant execute on function public.complete_ebay_publish_dispatch(
  uuid, uuid, uuid, uuid, uuid, text, text, numeric, timestamptz
) to authenticated;
