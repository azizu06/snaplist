begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(8);

select private.lock_ebay_messaging_account('dispatch-completion-a');
select private.lock_ebay_messaging_account('dispatch-completion-b');

insert into public.items (id, user_id, attributes)
values
  ('a1000000-0000-4000-8000-000000000001', 'dispatch-completion-a', '{}'),
  ('a1000000-0000-4000-8000-000000000002', 'dispatch-completion-a', '{}'),
  ('b1000000-0000-4000-8000-000000000001', 'dispatch-completion-b', '{}');

insert into public.listings (
  id, user_id, item_id, platform, title, status, ebay_status,
  ebay_publish_claim_id, ebay_publish_claimed_at, ebay_offer_id,
  ebay_listing_id, listed_price
)
values
  (
    'a2000000-0000-4000-8000-000000000001',
    'dispatch-completion-a',
    'a1000000-0000-4000-8000-000000000002',
    'ebay',
    'Publish completion fixture',
    'draft',
    'publishing',
    'a3000000-0000-4000-8000-000000000001',
    statement_timestamp(),
    null,
    null,
    null
  ),
  (
    'a2000000-0000-4000-8000-000000000002',
    'dispatch-completion-a',
    'a1000000-0000-4000-8000-000000000001',
    'ebay',
    'Reprice completion fixture',
    'published',
    'published',
    null,
    null,
    'offer-reprice-a',
    'listing-reprice-a',
    100
  ),
  (
    'b2000000-0000-4000-8000-000000000001',
    'dispatch-completion-b',
    'b1000000-0000-4000-8000-000000000001',
    'ebay',
    'Tenant B fixture',
    'draft',
    'publishing',
    'b3000000-0000-4000-8000-000000000001',
    statement_timestamp(),
    null,
    null,
    null
  );

insert into public.ebay_connections (
  user_id, ebay_user_id, ebay_username, refresh_token_enc, account_generation
)
select account.user_id,
       account.user_id || '-seller-id',
       account.user_id || '-seller',
       'v1.test-refresh',
       account.generation
from private.ebay_messaging_account_generations account
where account.user_id in ('dispatch-completion-a', 'dispatch-completion-b');

update public.ebay_connections connection
set policy_location_bindings = jsonb_build_object(
  'EBAY_US',
  jsonb_build_object(
    'state', 'ready',
    'marketplaceId', 'EBAY_US',
    'connectionGeneration', connection.connection_generation,
    'fulfillmentPolicy', jsonb_build_object(
      'state', 'bound',
      'selectedId', 'dispatch-fulfillment'
    ),
    'paymentPolicy', jsonb_build_object(
      'state', 'bound',
      'selectedId', 'dispatch-payment'
    ),
    'returnPolicy', jsonb_build_object(
      'state', 'bound',
      'selectedId', 'dispatch-return'
    ),
    'inventoryLocation', jsonb_build_object(
      'state', 'bound',
      'selectedId', 'dispatch-location'
    )
  )
)
where connection.user_id in ('dispatch-completion-a', 'dispatch-completion-b');

update public.listings listing
set ebay_publish_connection_generation = connection.connection_generation,
    ebay_publish_binding = jsonb_build_object(
      'marketplaceId', 'EBAY_US',
      'fulfillmentPolicyId', 'dispatch-fulfillment',
      'paymentPolicyId', 'dispatch-payment',
      'returnPolicyId', 'dispatch-return',
      'merchantLocationKey', 'dispatch-location'
    )
from public.ebay_connections connection
where connection.user_id = listing.user_id
  and listing.ebay_status = 'publishing';

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"dispatch-completion-a","role":"authenticated"}',
  true
);
select set_config('request.headers', '{"x-snaplist-server-auth":"snaplist-local-server-rpc-secret-do-not-use-in-hosted"}', true);

create temporary table publish_dispatch_fixture on commit drop as
select (lease->>'account_generation')::uuid as account_generation,
       (lease->>'connection_generation')::uuid as connection_generation,
       (lease->>'publish_claim_id')::uuid as publish_claim_id,
       (lease->>'attempt_token')::uuid as attempt_token
from (
  select public.begin_ebay_transactional_dispatch(
    'a2000000-0000-4000-8000-000000000001',
    'publish',
    (
      select connection_generation
      from public.ebay_connections
      where user_id = 'dispatch-completion-a'
    ),
    'a3000000-0000-4000-8000-000000000001',
    jsonb_build_object(
      'marketplaceId', 'EBAY_US',
      'fulfillmentPolicyId', 'dispatch-fulfillment',
      'paymentPolicyId', 'dispatch-payment',
      'returnPolicyId', 'dispatch-return',
      'merchantLocationKey', 'dispatch-location'
    )
  ) as lease
) started;

select extensions.throws_ok(
  $$select public.disconnect_ebay_connection()$$,
  '40001',
  'eBay provider dispatch is active',
  'account rotation cannot pass an acknowledged provider write awaiting completion'
);

select extensions.lives_ok(
  $$
    select public.complete_ebay_publish_dispatch(
      'a2000000-0000-4000-8000-000000000001',
      'a3000000-0000-4000-8000-000000000001',
      account_generation,
      connection_generation,
      attempt_token,
      'provider-listing-a',
      'provider-offer-a',
      125,
      '2026-07-14T18:00:00Z'
    )
    from publish_dispatch_fixture
  $$,
  'publish completion persists while the exact generation lease is active'
);

select extensions.results_eq(
  $$
    select ebay_listing_id, ebay_offer_id, ebay_status, status, listed_price
    from public.listings
    where id = 'a2000000-0000-4000-8000-000000000001'
  $$,
  $$values (
    'provider-listing-a'::text,
    'provider-offer-a'::text,
    'published'::text,
    'published'::text,
    125::numeric
  )$$,
  'publish acknowledgement and local listing state commit together'
);

reset role;

select extensions.is(
  (
    select count(*)::integer
    from private.ebay_provider_dispatch_leases
    where message_id = 'a2000000-0000-4000-8000-000000000001'
  ),
  0,
  'publish completion consumes its exact dispatch lease'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"dispatch-completion-a","role":"authenticated"}',
  true
);
select set_config('request.headers', '{"x-snaplist-server-auth":"snaplist-local-server-rpc-secret-do-not-use-in-hosted"}', true);

update public.listings
set status = 'draft',
    ebay_status = 'publishing',
    ebay_publish_claim_id = 'a3000000-0000-4000-8000-000000000001',
    ebay_publish_claimed_at = statement_timestamp(),
    ebay_listing_id = null,
    ebay_offer_id = null
where id = 'a2000000-0000-4000-8000-000000000001';

create temporary table denied_publish_dispatch_fixture on commit drop as
select (lease->>'account_generation')::uuid as account_generation,
       (lease->>'connection_generation')::uuid as connection_generation,
       (lease->>'attempt_token')::uuid as attempt_token
from (
  select public.begin_ebay_transactional_dispatch(
    'a2000000-0000-4000-8000-000000000001',
    'publish',
    (
      select connection_generation
      from public.ebay_connections
      where user_id = 'dispatch-completion-a'
    ),
    'a3000000-0000-4000-8000-000000000001',
    jsonb_build_object(
      'marketplaceId', 'EBAY_US',
      'fulfillmentPolicyId', 'dispatch-fulfillment',
      'paymentPolicyId', 'dispatch-payment',
      'returnPolicyId', 'dispatch-return',
      'merchantLocationKey', 'dispatch-location'
    )
  ) as lease
) started;

select set_config(
  'request.jwt.claims',
  '{"sub":"dispatch-completion-b","role":"authenticated"}',
  true
);

select extensions.throws_ok(
  $$
    select public.complete_ebay_publish_dispatch(
      'a2000000-0000-4000-8000-000000000001',
      'a3000000-0000-4000-8000-000000000001',
      account_generation,
      connection_generation,
      attempt_token,
      'wrong-tenant-listing',
      'wrong-tenant-offer',
      1,
      statement_timestamp()
    )
    from denied_publish_dispatch_fixture
  $$,
  'PT409',
  'eBay account generation changed before local completion',
  'another tenant cannot complete a provider result using the captured generation'
);

reset role;
delete from private.ebay_provider_dispatch_leases
where message_id = 'a2000000-0000-4000-8000-000000000001';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table scheduled_reprice_fixture on commit drop as
select (lease->>'account_generation')::uuid as account_generation,
       (lease->>'attempt_token')::uuid as attempt_token
from (
  select public.begin_scheduled_ebay_transactional_dispatch(
    'a2000000-0000-4000-8000-000000000002',
    'reprice'
  ) as lease
) started;

select extensions.is(
  (
    select public.complete_scheduled_ebay_reprice_dispatch(
      'a2000000-0000-4000-8000-000000000002',
      'a1000000-0000-4000-8000-000000000001',
      account_generation,
      attempt_token,
      80,
      '2026-07-14T18:05:00Z'
    )
    from scheduled_reprice_fixture
  ),
  'dispatch-completion-a',
  'scheduled completion derives and returns the lease tenant'
);

reset role;

select extensions.results_eq(
  $$
    select listing.listed_price, item.price_override
    from public.listings listing
    join public.items item on item.id = listing.item_id
    where listing.id = 'a2000000-0000-4000-8000-000000000002'
  $$,
  $$values (80::numeric, 80::numeric)$$,
  'scheduled reprice acknowledgement persists only to the leased tenant resources'
);

select extensions.results_eq(
  $$
    select ebay_status, status
    from public.listings
    where id = 'b2000000-0000-4000-8000-000000000001'
  $$,
  $$values ('publishing'::text, 'draft'::text)$$,
  'generation-bound completion preserves unrelated tenant state'
);

select * from extensions.finish();
rollback;
