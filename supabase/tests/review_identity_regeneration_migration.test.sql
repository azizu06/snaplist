begin;

create extension if not exists pgtap with schema extensions;

select extensions.plan(8);

drop index public.listings_one_ebay_per_item_idx;

insert into public.items (id, user_id, attributes)
values
  ('10000000-0000-0000-0000-000000000001', 'migration-test', '{}'),
  ('10000000-0000-0000-0000-000000000002', 'migration-test', '{}'),
  ('10000000-0000-0000-0000-000000000003', 'migration-test', '{}'),
  ('10000000-0000-0000-0000-000000000004', 'migration-test', '{}');

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

select * from extensions.finish();

rollback;
