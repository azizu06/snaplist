begin;

create extension if not exists pgtap with schema extensions;

-- Issue #169. The sync SERVICE is proved offline and its tenancy end-to-end in
-- `listing-sync.rls.test.ts`. What only the catalog can prove is that the
-- guarantees are structural: a seller reads only their own rows, cannot write
-- either table by any client path, and every write function is fenced.
--
-- CI builds a clean stack from migrations. A shared local stack that has not
-- applied this branch migration skips rather than reporting a false failure for
-- work it does not contain.
select to_regclass('public.ebay_listing_sync_state') is not null
  and to_regclass('public.ebay_listing_sync_conflicts') is not null
  as sync_installed \gset

select plan(16);

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

-- Both write functions are server-API guarded. A seller JWT alone must not be
-- able to write provider truth from a browser.
select ok(
  pg_get_functiondef(
    'public.apply_ebay_listing_provider_truth(uuid,text,text,text,text,uuid,uuid,text,numeric,text,integer,timestamp with time zone,uuid,text)'::regprocedure
  ) like '%private.is_server_api_request()%',
  'applying provider truth requires server API authorization'
);
select ok(
  pg_get_functiondef(
    'public.open_ebay_listing_sync_conflict(uuid,text,text,text,text,text,timestamp with time zone,uuid)'::regprocedure
  ) like '%private.is_server_api_request()%',
  'opening a sync conflict requires server API authorization'
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

\else

select skip(
  'eBay listing sync migration is not installed on this stack', 16
);

\endif

select * from finish();

rollback;
