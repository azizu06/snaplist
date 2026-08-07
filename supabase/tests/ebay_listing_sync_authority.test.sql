begin;

create extension if not exists pgtap with schema extensions;

-- Issue #169. The sync SERVICE is proved offline and its tenancy end-to-end in
-- `listing-sync.rls.test.ts`. What only the catalog can prove is that the
-- guarantees are structural: a seller reads only their own rows, cannot write
-- either table by any client path, and every write function is fenced.
--
-- CI builds a clean stack from this branch's migrations and sets the flag
-- below, so the sync surface must exist there. A shared local stack that has
-- not applied this branch migration skips instead of reporting a false failure
-- for work it does not contain.
select to_regclass('pgtap_ci.require_installed_migrations') is not null
  as require_installed_migration \gset
select to_regclass('public.ebay_listing_sync_state') is not null
  and to_regclass('public.ebay_listing_sync_conflicts') is not null
  as sync_installed \gset

select plan(29);

\if :sync_installed

select ok(
  (select relrowsecurity from pg_class where oid = 'public.ebay_listing_sync_state'::regclass),
  'ebay_listing_sync_state enforces row level security'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.ebay_listing_sync_conflicts'::regclass),
  'ebay_listing_sync_conflicts enforces row level security'
);

-- Exactly one policy per table, and it is a SELECT policy. An UPDATE or DELETE
-- policy would let a seller edit the provider's answer into agreement.
select is(
  (select array_agg(polcmd::text order by polname)
   from pg_policy where polrelid = 'public.ebay_listing_sync_state'::regclass),
  array['r'],
  'the only policy on ebay_listing_sync_state is SELECT'
);
select is(
  (select array_agg(polcmd::text order by polname)
   from pg_policy where polrelid = 'public.ebay_listing_sync_conflicts'::regclass),
  array['r'],
  'the only policy on ebay_listing_sync_conflicts is SELECT'
);

-- Grants are the second half of the same guarantee: a missing policy denies
-- rows, but a lingering grant would still let a write reach the fence trigger.
select is(
  (select array_agg(distinct privilege_type::text order by privilege_type::text)
   from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name = 'ebay_listing_sync_state'
     and grantee = 'authenticated'),
  array['SELECT'],
  'authenticated holds only SELECT on ebay_listing_sync_state'
);
select is(
  (select array_agg(distinct privilege_type::text order by privilege_type::text)
   from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name = 'ebay_listing_sync_conflicts'
     and grantee = 'authenticated'),
  array['SELECT'],
  'authenticated holds only SELECT on ebay_listing_sync_conflicts'
);
select is(
  (select count(*)::integer
   from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('ebay_listing_sync_state', 'ebay_listing_sync_conflicts')
     and grantee in ('anon', 'public', 'service_role')),
  0,
  'no anon, public, or service_role grant reaches the sync tables'
);

-- Erasure coverage: the generic fence plus the erasure-serialization lock.
select has_trigger(
  'public', 'ebay_listing_sync_state', 'zzz_fence_account_erasure_tenant_mutation',
  'ebay_listing_sync_state carries the account erasure fence'
);
select has_trigger(
  'public', 'ebay_listing_sync_conflicts', 'zzz_fence_account_erasure_tenant_mutation',
  'ebay_listing_sync_conflicts carries the account erasure fence'
);
select has_trigger(
  'public', 'ebay_listing_sync_state', 'zzy_lock_ebay_listing_sync_erasure',
  'ebay_listing_sync_state serializes against account erasure'
);
select has_trigger(
  'public', 'ebay_listing_sync_conflicts', 'zzy_lock_ebay_listing_sync_erasure',
  'ebay_listing_sync_conflicts serializes against account erasure'
);

-- Completion proof cannot be reported while a sync row survives.
select ok(
  pg_get_functiondef('private.account_erasure_owned_row_count(text)'::regprocedure)
    like '%public.ebay_listing_sync_state%'
  and pg_get_functiondef('private.account_erasure_owned_row_count(text)'::regprocedure)
    like '%public.ebay_listing_sync_conflicts%',
  'account erasure completion proof counts both sync tables'
);

-- The one write function is server-API guarded. A seller JWT alone must not be
-- able to write provider truth from a browser.
select ok(
  pg_get_functiondef(
    'public.apply_ebay_listing_provider_truth(uuid,text,text,text,text,uuid,uuid,text,numeric,text,integer,timestamp with time zone,uuid,text,jsonb,text[])'::regprocedure
  ) like '%private.is_server_api_request()%',
  'applying provider truth requires server API authorization'
);

-- There is exactly ONE public entry point that writes sync state. A second one
-- that recorded conflicts on their own is what made truth and divergence
-- separable in the first place; it must stay gone, not merely go unused.
select is(
  (select count(*)::integer
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname like '%ebay_listing_sync_conflict%'),
  0,
  'no public function records a sync conflict on its own'
);

-- One OPEN conflict per listing dimension, so a repeatedly diverging listing is
-- one unresolved problem rather than an unbounded pile.
select ok(
  (select indexdef from pg_indexes
   where schemaname = 'public'
     and indexname = 'ebay_listing_sync_conflicts_open_idx')
    like '%UNIQUE%(user_id, listing_id, field)%resolved_at IS NULL%',
  'unresolved conflicts are unique per seller, listing, and dimension'
);

-- A price is a value AND a currency, or nothing: a bare amount could not be
-- compared against the seller's price with any way to know it is comparable.
select throws_ok(
  $$insert into public.ebay_listing_sync_state (
      listing_id, user_id, ebay_listing_id, marketplace_id, account_generation,
      provider_price_value, provider_observed_at, last_event_id,
      last_event_source, review_revision
    ) values (
      gen_random_uuid(), 'pgtap_sync_user', 'EBAY-1', 'EBAY_US', gen_random_uuid(),
      42.50, now(), 'evt-1', 'poll', gen_random_uuid()
    )$$,
  '23514',
  null,
  'a provider price without a currency is rejected'
);

-- ---------------------------------------------------------------------------
-- Executing coverage. Everything above is structure; nothing above proves the
-- function DECIDES correctly. These call it for real, because the branches that
-- matter most — the two `superseded` answers, the fail-closed account fence,
-- and the atomicity of truth plus conflicts — exist only inside the body.
-- ---------------------------------------------------------------------------

insert into public.items (id, user_id, attributes, review_revision)
values (
  '99000000-0000-4000-8000-000000000001',
  'pgtap_sync_owner',
  '{}',
  '99000000-0000-4000-8000-000000000003'
);

insert into public.listings (
  id, user_id, item_id, platform, title, status, ebay_status,
  ebay_listing_id, ebay_offer_id
) values (
  '99000000-0000-4000-8000-000000000002',
  'pgtap_sync_owner',
  '99000000-0000-4000-8000-000000000001',
  'ebay',
  'Sync authority fixture',
  'published',
  'published',
  'EBAY-PGTAP-SYNC-1',
  'OFFER-PGTAP-SYNC-1'
);

insert into public.ebay_connections (
  user_id, ebay_user_id, ebay_username, refresh_token_enc,
  account_generation, connection_generation
) values (
  'pgtap_sync_owner',
  'EBAYUID-PGTAP-SYNC',
  'pgtap-sync-seller',
  'v1.pgtap-refresh',
  '99000000-0000-4000-8000-000000000004',
  '99000000-0000-4000-8000-000000000005'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"pgtap_sync_owner","role":"authenticated"}',
  true
);
select set_config(
  'request.headers',
  '{"x-snaplist-server-auth":"snaplist-local-server-rpc-secret-do-not-use-in-hosted"}',
  true
);

-- eBay ended a listing SnapList still shows live at a different price: provider
-- truth and BOTH divergences land in one call.
select is(
  public.apply_ebay_listing_provider_truth(
    p_listing_id => '99000000-0000-4000-8000-000000000002',
    p_event_id => 'evt-1',
    p_event_source => 'notification',
    p_ebay_listing_id => 'EBAY-PGTAP-SYNC-1',
    p_marketplace_id => 'EBAY_US',
    p_account_generation => '99000000-0000-4000-8000-000000000004',
    p_connection_generation => '99000000-0000-4000-8000-000000000005',
    p_provider_status => 'ended',
    p_provider_price_value => 31.00,
    p_provider_price_currency => 'USD',
    p_provider_quantity => 0,
    p_provider_observed_at => '2026-08-06T12:00:00Z',
    p_expected_review_revision => '99000000-0000-4000-8000-000000000003',
    p_expected_last_event_id => null,
    p_conflicts => '[
      {"kind":"providerDiverged","field":"status","local_value":"published",
       "provider_value":"ended","observed_at":"2026-08-06T12:00:00Z"},
      {"kind":"providerDiverged","field":"price","local_value":"USD 42.50",
       "provider_value":"USD 31.00","observed_at":"2026-08-06T12:00:00Z"}
    ]'::jsonb,
    p_resolved_fields => array[]::text[]
  ),
  'applied',
  'a first confirmed observation is applied'
);

select results_eq(
  $$select provider_status, last_event_id, last_event_source
    from public.ebay_listing_sync_state
    where listing_id = '99000000-0000-4000-8000-000000000002'$$,
  $$values ('ended'::text, 'evt-1'::text, 'notification'::text)$$,
  'the confirmed answer becomes the stored provider truth'
);

select results_eq(
  $$select field, kind, local_value, provider_value
    from public.ebay_listing_sync_conflicts
    where listing_id = '99000000-0000-4000-8000-000000000002'
      and resolved_at is null
    order by field$$,
  $$values
    ('price'::text, 'providerDiverged'::text, 'USD 42.50'::text, 'USD 31.00'::text),
    ('status'::text, 'providerDiverged'::text, 'published'::text, 'ended'::text)$$,
  'both divergences are recorded by the same call that recorded the truth'
);

-- `superseded` branch one: another writer applied an event since the caller
-- read, so the decision in hand was made against a row that has moved.
select is(
  public.apply_ebay_listing_provider_truth(
    p_listing_id => '99000000-0000-4000-8000-000000000002',
    p_event_id => 'evt-2',
    p_event_source => 'poll',
    p_ebay_listing_id => 'EBAY-PGTAP-SYNC-1',
    p_marketplace_id => 'EBAY_US',
    p_account_generation => '99000000-0000-4000-8000-000000000004',
    p_connection_generation => '99000000-0000-4000-8000-000000000005',
    p_provider_status => 'active',
    p_provider_price_value => 44.00,
    p_provider_price_currency => 'USD',
    p_provider_quantity => 1,
    p_provider_observed_at => '2026-08-06T13:00:00Z',
    p_expected_review_revision => '99000000-0000-4000-8000-000000000003',
    p_expected_last_event_id => 'evt-someone-else',
    p_conflicts => '[]'::jsonb,
    p_resolved_fields => array[]::text[]
  ),
  'superseded',
  'an observation decided against a stale last event id is superseded'
);

-- `superseded` branch two: the observation clock did not advance. Equality is
-- refused too — two answers at the same instant prove nothing about order.
select is(
  public.apply_ebay_listing_provider_truth(
    p_listing_id => '99000000-0000-4000-8000-000000000002',
    p_event_id => 'evt-3',
    p_event_source => 'poll',
    p_ebay_listing_id => 'EBAY-PGTAP-SYNC-1',
    p_marketplace_id => 'EBAY_US',
    p_account_generation => '99000000-0000-4000-8000-000000000004',
    p_connection_generation => '99000000-0000-4000-8000-000000000005',
    p_provider_status => 'active',
    p_provider_price_value => 44.00,
    p_provider_price_currency => 'USD',
    p_provider_quantity => 1,
    p_provider_observed_at => '2026-08-06T12:00:00Z',
    p_expected_review_revision => '99000000-0000-4000-8000-000000000003',
    p_expected_last_event_id => 'evt-1',
    p_conflicts => '[]'::jsonb,
    p_resolved_fields => array[]::text[]
  ),
  'superseded',
  'an observation that did not advance the provider clock is superseded'
);

select results_eq(
  $$select provider_status, last_event_id
    from public.ebay_listing_sync_state
    where listing_id = '99000000-0000-4000-8000-000000000002'$$,
  $$values ('ended'::text, 'evt-1'::text)$$,
  'a superseded answer changes nothing'
);

-- Atomicity, proved by failing the conflict half. The truth half is written
-- first inside the function, so if the two were separate transactions this
-- would leave the state row advanced to evt-4 with no conflict recorded — and
-- the retry would dedupe on evt-4 and never record it.
select throws_ok(
  $$select public.apply_ebay_listing_provider_truth(
      p_listing_id => '99000000-0000-4000-8000-000000000002',
      p_event_id => 'evt-4',
      p_event_source => 'poll',
      p_ebay_listing_id => 'EBAY-PGTAP-SYNC-1',
      p_marketplace_id => 'EBAY_US',
      p_account_generation => '99000000-0000-4000-8000-000000000004',
      p_connection_generation => '99000000-0000-4000-8000-000000000005',
      p_provider_status => 'active',
      p_provider_price_value => 44.00,
      p_provider_price_currency => 'USD',
      p_provider_quantity => 1,
      p_provider_observed_at => '2026-08-06T13:00:00Z',
      p_expected_review_revision => '99000000-0000-4000-8000-000000000003',
      p_expected_last_event_id => 'evt-1',
      p_conflicts => '[{"kind":"providerDiverged","field":"quantity",
        "local_value":"1","provider_value":"0",
        "observed_at":"2026-08-06T13:00:00Z"}]'::jsonb,
      p_resolved_fields => array[]::text[]
    )$$,
  '23514',
  null,
  'a conflict the schema refuses aborts the whole write'
);

select results_eq(
  $$select provider_status, last_event_id
    from public.ebay_listing_sync_state
    where listing_id = '99000000-0000-4000-8000-000000000002'$$,
  $$values ('ended'::text, 'evt-1'::text)$$,
  'provider truth does not survive a conflict its own call could not record'
);

select is(
  (select count(*)::integer
   from public.ebay_listing_sync_conflicts
   where listing_id = '99000000-0000-4000-8000-000000000002'),
  2,
  'the aborted write left no partial conflict behind'
);

-- Re-convergence closes the open rows. Without this a seller who relisted at
-- the old price would keep staring at a conflict that contradicts live truth.
select is(
  public.apply_ebay_listing_provider_truth(
    p_listing_id => '99000000-0000-4000-8000-000000000002',
    p_event_id => 'evt-5',
    p_event_source => 'poll',
    p_ebay_listing_id => 'EBAY-PGTAP-SYNC-1',
    p_marketplace_id => 'EBAY_US',
    p_account_generation => '99000000-0000-4000-8000-000000000004',
    p_connection_generation => '99000000-0000-4000-8000-000000000005',
    p_provider_status => 'active',
    p_provider_price_value => 42.50,
    p_provider_price_currency => 'USD',
    p_provider_quantity => 1,
    p_provider_observed_at => '2026-08-06T14:00:00Z',
    p_expected_review_revision => '99000000-0000-4000-8000-000000000003',
    p_expected_last_event_id => 'evt-1',
    p_conflicts => '[]'::jsonb,
    p_resolved_fields => array['status', 'price']
  ),
  'applied',
  'provider truth that agrees again is applied'
);

select is(
  (select count(*)::integer
   from public.ebay_listing_sync_conflicts
   where listing_id = '99000000-0000-4000-8000-000000000002'
     and resolved_at is null),
  0,
  'a dimension that re-converged has no open conflict left'
);

-- An open ambiguous acknowledgement is not answered by a later divergence:
-- SnapList still does not know whether eBay applied what it was sent.
reset role;
insert into public.ebay_listing_sync_conflicts (
  user_id, listing_id, kind, field, ebay_listing_id, local_value,
  provider_value, observed_at, review_revision
) values (
  'pgtap_sync_owner',
  '99000000-0000-4000-8000-000000000002',
  'ambiguousAcknowledgement',
  'price',
  'EBAY-PGTAP-SYNC-1',
  'USD 39.99',
  null,
  '2026-08-06T14:30:00Z',
  '99000000-0000-4000-8000-000000000003'
);

set local role authenticated;
select public.apply_ebay_listing_provider_truth(
  p_listing_id => '99000000-0000-4000-8000-000000000002',
  p_event_id => 'evt-6',
  p_event_source => 'poll',
  p_ebay_listing_id => 'EBAY-PGTAP-SYNC-1',
  p_marketplace_id => 'EBAY_US',
  p_account_generation => '99000000-0000-4000-8000-000000000004',
  p_connection_generation => '99000000-0000-4000-8000-000000000005',
  p_provider_status => 'active',
  p_provider_price_value => 35.00,
  p_provider_price_currency => 'USD',
  p_provider_quantity => 1,
  p_provider_observed_at => '2026-08-06T15:00:00Z',
  p_expected_review_revision => '99000000-0000-4000-8000-000000000003',
  p_expected_last_event_id => 'evt-5',
  p_conflicts => '[{"kind":"providerDiverged","field":"price",
    "local_value":"USD 42.50","provider_value":"USD 35.00",
    "observed_at":"2026-08-06T15:00:00Z"}]'::jsonb,
  p_resolved_fields => array[]::text[]
);

select results_eq(
  $$select kind, local_value, provider_value
    from public.ebay_listing_sync_conflicts
    where listing_id = '99000000-0000-4000-8000-000000000002'
      and field = 'price'
      and resolved_at is null$$,
  $$values (
    'ambiguousAcknowledgement'::text, 'USD 39.99'::text, 'USD 35.00'::text
  )$$,
  'a later divergence refreshes provider evidence without erasing an open ambiguity'
);

-- The account-generation fence must fail CLOSED. A disconnect or an eBay
-- account deletion removes the connection row while an observation is still in
-- flight; with no generation left to match, the answer belongs to nothing.
reset role;
delete from public.ebay_connections where user_id = 'pgtap_sync_owner';
set local role authenticated;

select throws_ok(
  $$select public.apply_ebay_listing_provider_truth(
      p_listing_id => '99000000-0000-4000-8000-000000000002',
      p_event_id => 'evt-7',
      p_event_source => 'poll',
      p_ebay_listing_id => 'EBAY-PGTAP-SYNC-1',
      p_marketplace_id => 'EBAY_US',
      p_account_generation => '99000000-0000-4000-8000-000000000004',
      p_connection_generation => '99000000-0000-4000-8000-000000000005',
      p_provider_status => 'active',
      p_provider_price_value => 42.50,
      p_provider_price_currency => 'USD',
      p_provider_quantity => 1,
      p_provider_observed_at => '2026-08-06T16:00:00Z',
      p_expected_review_revision => '99000000-0000-4000-8000-000000000003',
      p_expected_last_event_id => 'evt-6',
      p_conflicts => '[]'::jsonb,
      p_resolved_fields => array[]::text[]
    )$$,
  'PT409',
  'The eBay account changed during sync',
  'an observation is refused when no eBay connection row remains'
);

reset role;

\else

-- Where the migrations are guaranteed, an absent surface is a real defect, not
-- an unapplied migration. Skipping there would report twenty-nine green
-- assertions for a contract that never ran — exactly the false green the flag
-- exists to prevent.
\if :require_installed_migration
do $$
begin
  raise exception
    'ebay listing sync migration is missing on a stack that requires it';
end
$$;
\endif

select skip(
  'eBay listing sync migration is not installed on this shared local stack', 29
);

\endif

select * from finish();

rollback;
