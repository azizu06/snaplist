begin;

create extension if not exists pgtap with schema extensions;

select extensions.plan(21);

drop index public.listings_one_ebay_per_item_idx;

insert into public.items (id, user_id, attributes)
values
  ('10000000-0000-0000-0000-000000000001', 'migration-test', '{}'),
  ('10000000-0000-0000-0000-000000000002', 'migration-test', '{}'),
  ('10000000-0000-0000-0000-000000000003', 'migration-test', '{}'),
  ('10000000-0000-0000-0000-000000000004', 'migration-test', '{}'),
  ('10000000-0000-0000-0000-000000000005', 'migration-test', '{}'),
  ('10000000-0000-0000-0000-000000000006', 'migration-test', '{}'),
  ('10000000-0000-0000-0000-000000000007', 'migration-other', '{}');

select extensions.throws_ok(
  $$
    insert into public.listings (
      id, user_id, item_id, platform, status
    ) values (
      '20000000-0000-0000-0000-000000000013',
      'migration-other',
      '10000000-0000-0000-0000-000000000001',
      'facebook',
      'draft'
    )
  $$,
  '23503',
  null,
  'a tenant cannot attach its listing to another tenant item'
);

alter table public.listings
  drop constraint listings_item_user_fkey;

insert into public.listings (
  id, user_id, item_id, platform, status
) values (
  '20000000-0000-0000-0000-000000000013',
  'migration-other',
  '10000000-0000-0000-0000-000000000001',
  'facebook',
  'draft'
);

select extensions.throws_ok(
  'select public.assert_legacy_listing_item_ownership()',
  '23503',
  'Cannot enforce listing ownership: malformed cross-tenant listing ownership exists for listing(s): 20000000-0000-0000-0000-000000000013',
  'malformed legacy ownership aborts with a clear diagnostic'
);

select extensions.is(
  (
    select user_id
    from public.listings
    where id = '20000000-0000-0000-0000-000000000013'
  ),
  'migration-other',
  'malformed legacy ownership remains untouched after the abort'
);

delete from public.listings
where id = '20000000-0000-0000-0000-000000000013';

alter table public.listings
  add constraint listings_item_user_fkey
  foreign key (item_id, user_id)
  references public.items (id, user_id)
  on delete cascade;

insert into public.listings (
  id,
  user_id,
  item_id,
  platform,
  status,
  created_at
)
values (
  '20000000-0000-0000-0000-000000000001',
  'migration-test',
  '10000000-0000-0000-0000-000000000001',
  'ebay',
  'draft',
  '2026-07-13T12:00:00Z'
);

select extensions.lives_ok(
  'select public.reconcile_legacy_ebay_listing_duplicates()',
  'no duplicate eBay rows require no reconciliation'
);

select extensions.is(
  (
    select id
    from public.listings
    where item_id = '10000000-0000-0000-0000-000000000001'
  ),
  '20000000-0000-0000-0000-000000000001'::uuid,
  'a sole eBay row is preserved'
);

insert into public.listings (
  id,
  user_id,
  item_id,
  platform,
  status,
  run_id,
  created_at
)
values
  (
    '20000000-0000-0000-0000-000000000002',
    'migration-test',
    '10000000-0000-0000-0000-000000000002',
    'ebay',
    'draft',
    '30000000-0000-0000-0000-000000000001',
    '2026-07-13T12:00:00Z'
  ),
  (
    '20000000-0000-0000-0000-000000000003',
    'migration-test',
    '10000000-0000-0000-0000-000000000002',
    'ebay',
    'draft',
    '30000000-0000-0000-0000-000000000002',
    '2026-07-13T13:00:00Z'
  );

insert into public.prediction_logs (
  user_id,
  item_id,
  run_id,
  model,
  listing_model,
  created_at
)
values (
  'migration-test',
  '10000000-0000-0000-0000-000000000002',
  '30000000-0000-0000-0000-000000000001',
  'migration-test-model',
  'migration-test-model',
  '2026-07-13T14:00:00Z'
);

select extensions.lives_ok(
  'select public.reconcile_legacy_ebay_listing_duplicates()',
  'draft-only duplicates reconcile safely'
);

select extensions.is(
  (
    select id
    from public.listings
    where item_id = '10000000-0000-0000-0000-000000000002'
  ),
  '20000000-0000-0000-0000-000000000002'::uuid,
  'the draft paired to the latest applicable prediction survives'
);

select extensions.ok(
  exists (
    select 1
    from pg_catalog.pg_locks relation_lock
    join pg_catalog.pg_class locked_relation
      on locked_relation.oid = relation_lock.relation
    join pg_catalog.pg_namespace locked_namespace
      on locked_namespace.oid = locked_relation.relnamespace
    where relation_lock.pid = pg_backend_pid()
      and relation_lock.granted
      and relation_lock.mode = 'ShareRowExclusiveLock'
      and locked_namespace.nspname = 'public'
      and locked_relation.relname = 'messages'
  ),
  'reconciliation holds a write-conflicting lock on dependent relations'
);

select extensions.ok(
  exists (
    select 1
    from pg_catalog.pg_constraint ownership_constraint
    where ownership_constraint.conrelid = 'public.listings'::regclass
      and ownership_constraint.conname = 'listings_item_user_fkey'
      and ownership_constraint.convalidated
  ),
  'the composite listing ownership constraint is validated'
);

insert into public.listings (
  id,
  user_id,
  item_id,
  platform,
  status,
  ebay_listing_id,
  ebay_status,
  created_at
)
values
  (
    '20000000-0000-0000-0000-000000000004',
    'migration-test',
    '10000000-0000-0000-0000-000000000003',
    'ebay',
    'published',
    'v1|migration-live|0',
    'published',
    '2026-07-13T12:00:00Z'
  ),
  (
    '20000000-0000-0000-0000-000000000005',
    'migration-test',
    '10000000-0000-0000-0000-000000000003',
    'ebay',
    'draft',
    null,
    null,
    '2026-07-13T13:00:00Z'
  ),
  (
    '20000000-0000-0000-0000-000000000006',
    'migration-test',
    '10000000-0000-0000-0000-000000000003',
    'ebay',
    'failed',
    null,
    'failed',
    '2026-07-13T14:00:00Z'
  );

select extensions.lives_ok(
  'select public.reconcile_legacy_ebay_listing_duplicates()',
  'one protected row can retire non-live siblings'
);

select extensions.is(
  (
    select id
    from public.listings
    where item_id = '10000000-0000-0000-0000-000000000003'
  ),
  '20000000-0000-0000-0000-000000000004'::uuid,
  'the protected live row survives instead of a newer local sibling'
);

insert into public.listings (
  id,
  user_id,
  item_id,
  platform,
  status,
  ebay_listing_id,
  ebay_status,
  created_at
)
values
  (
    '20000000-0000-0000-0000-000000000007',
    'migration-test',
    '10000000-0000-0000-0000-000000000004',
    'ebay',
    'published',
    'v1|migration-live-a|0',
    'published',
    '2026-07-13T12:00:00Z'
  ),
  (
    '20000000-0000-0000-0000-000000000008',
    'migration-test',
    '10000000-0000-0000-0000-000000000004',
    'ebay',
    'draft',
    null,
    'publishing',
    '2026-07-13T13:00:00Z'
  );

select extensions.throws_ok(
  'select public.reconcile_legacy_ebay_listing_duplicates()',
  '23505',
  'Cannot reconcile legacy duplicate eBay listings: multiple protected eBay listings exist for item(s): 10000000-0000-0000-0000-000000000004',
  'multiple protected rows abort with a clear diagnostic'
);

select extensions.is(
  (
    select count(*)::integer
    from public.listings
    where item_id = '10000000-0000-0000-0000-000000000004'
  ),
  2,
  'unsafe protected rows remain untouched after the abort'
);

delete from public.listings
where item_id = '10000000-0000-0000-0000-000000000004';

insert into public.listings (
  id,
  user_id,
  item_id,
  platform,
  status,
  created_at
)
values
  (
    '20000000-0000-0000-0000-000000000009',
    'migration-test',
    '10000000-0000-0000-0000-000000000005',
    'ebay',
    'draft',
    '2026-07-13T12:00:00Z'
  ),
  (
    '20000000-0000-0000-0000-000000000010',
    'migration-test',
    '10000000-0000-0000-0000-000000000005',
    'ebay',
    'draft',
    '2026-07-13T13:00:00Z'
  );

insert into public.messages (
  id,
  user_id,
  item_id,
  listing_id,
  direction,
  body,
  status
)
values (
  '40000000-0000-0000-0000-000000000001',
  'migration-test',
  '10000000-0000-0000-0000-000000000005',
  '20000000-0000-0000-0000-000000000009',
  'inbound',
  'Does this include the original box?',
  'new'
);

insert into public.notifications (
  id,
  user_id,
  kind,
  title,
  item_id,
  listing_id
)
values (
  '50000000-0000-0000-0000-000000000001',
  'migration-test',
  'system',
  'Legacy listing event',
  '10000000-0000-0000-0000-000000000005',
  '20000000-0000-0000-0000-000000000009'
);

insert into public.reprice_suggestions (
  id,
  user_id,
  item_id,
  listing_id,
  current_price,
  suggested_price,
  target_price,
  price_range,
  drift_pct,
  confidence,
  tier_fired,
  status
)
values (
  '60000000-0000-0000-0000-000000000001',
  'migration-test',
  '10000000-0000-0000-0000-000000000005',
  '20000000-0000-0000-0000-000000000009',
  50,
  45,
  45,
  '{"low":40,"high":50}',
  -10,
  0.7,
  'ebay-sold',
  'dismissed'
);

select extensions.throws_ok(
  'select public.reconcile_legacy_ebay_listing_duplicates()',
  '23503',
  'Cannot reconcile legacy duplicate eBay listings: dependent rows reference non-surviving listing(s) in public.messages, public.notifications, public.reprice_suggestions',
  'referenced duplicate rows abort with a clear diagnostic'
);

select extensions.is(
  (
    select listing_id
    from public.messages
    where id = '40000000-0000-0000-0000-000000000001'
  ),
  '20000000-0000-0000-0000-000000000009'::uuid,
  'buyer messages remain attached after the reconciliation abort'
);

select extensions.is(
  (
    select listing_id
    from public.notifications
    where id = '50000000-0000-0000-0000-000000000001'
  ),
  '20000000-0000-0000-0000-000000000009'::uuid,
  'activity notifications remain attached after the reconciliation abort'
);

select extensions.is(
  (
    select listing_id
    from public.reprice_suggestions
    where id = '60000000-0000-0000-0000-000000000001'
  ),
  '20000000-0000-0000-0000-000000000009'::uuid,
  'reprice suggestions remain attached after the reconciliation abort'
);

select extensions.is(
  (
    select count(*)::integer
    from public.listings
    where item_id = '10000000-0000-0000-0000-000000000005'
  ),
  2,
  'both duplicate listings remain after the reconciliation abort'
);

delete from public.items
where id = '10000000-0000-0000-0000-000000000005';

alter table public.listings
  add constraint migration_listings_run_id_key unique (run_id);

create table public.migration_listing_dependents (
  id uuid primary key,
  listing_run_id uuid not null references public.listings (run_id) on delete cascade
);

insert into public.listings (
  id,
  user_id,
  item_id,
  platform,
  status,
  run_id,
  created_at
)
values
  (
    '20000000-0000-0000-0000-000000000011',
    'migration-test',
    '10000000-0000-0000-0000-000000000006',
    'ebay',
    'draft',
    '80000000-0000-0000-0000-000000000001',
    '2026-07-13T12:00:00Z'
  ),
  (
    '20000000-0000-0000-0000-000000000012',
    'migration-test',
    '10000000-0000-0000-0000-000000000006',
    'ebay',
    'draft',
    '80000000-0000-0000-0000-000000000002',
    '2026-07-13T13:00:00Z'
  );

insert into public.migration_listing_dependents (id, listing_run_id)
values (
  '70000000-0000-0000-0000-000000000001',
  '80000000-0000-0000-0000-000000000001'
);

select extensions.throws_ok(
  'select public.reconcile_legacy_ebay_listing_duplicates()',
  '23503',
  'Cannot reconcile legacy duplicate eBay listings: dependent rows reference non-surviving listing(s) in public.migration_listing_dependents',
  'an unrecognized foreign-key dependent aborts reconciliation'
);

select extensions.is(
  (
    select listing_run_id
    from public.migration_listing_dependents
    where id = '70000000-0000-0000-0000-000000000001'
  ),
  '80000000-0000-0000-0000-000000000001'::uuid,
  'an unrecognized dependent remains attached after the abort'
);

select extensions.is(
  (
    select count(*)::integer
    from public.listings
    where item_id = '10000000-0000-0000-0000-000000000006'
  ),
  2,
  'unknown dependencies preserve both duplicate listings'
);

select * from extensions.finish();

rollback;
