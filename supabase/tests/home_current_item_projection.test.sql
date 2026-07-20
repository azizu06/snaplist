begin;

select plan(17);

select extensions.has_function(
  'public',
  'get_home_current_item_projection',
  array[]::text[],
  'Home current-item projection is a zero-argument RPC'
);
select extensions.ok(
  (
    select not procedure.prosecdef
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = 'get_home_current_item_projection'
      and procedure.pronargs = 0
  ),
  'Home projection runs as SECURITY INVOKER'
);
select extensions.is(
  (
    select procedure.pronargs::integer
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = 'get_home_current_item_projection'
  ),
  0,
  'Home projection cannot accept a caller-supplied tenant id'
);
select extensions.ok(
  to_regclass('public.prediction_logs_home_latest_priced_idx') is not null,
  'latest usable Home price has a bounded newest-first index'
);
select extensions.ok(
  has_function_privilege(
    'authenticated',
    'public.get_home_current_item_projection()',
    'execute'
  ),
  'authenticated sellers may read the Home projection'
);
select extensions.ok(
  not has_function_privilege(
    'anon',
    'public.get_home_current_item_projection()',
    'execute'
  ),
  'anonymous callers cannot read the Home projection'
);

insert into public.items (
  id, user_id, attributes, photos, created_at, updated_at
) values
  (
    '25200000-0000-4000-8000-000000000001',
    'home-projection-a',
    '{"brand":"Canon","model":"AE-1"}'::jsonb,
    '{}',
    '2026-07-17T13:00:00Z',
    '2026-07-17T13:00:00Z'
  ),
  (
    '25200000-0000-4000-8000-000000000002',
    'home-projection-a',
    '{"brand":"Unlisted","model":"Current"}'::jsonb,
    '{}',
    '2026-07-17T12:00:00Z',
    '2026-07-17T12:00:00Z'
  ),
  (
    '25200000-0000-4000-8000-000000000003',
    'home-projection-a',
    '{"brand":"Archived","model":"History"}'::jsonb,
    '{}',
    '2026-07-17T11:00:00Z',
    '2026-07-17T11:00:00Z'
  ),
  (
    '25200000-0000-4000-8000-000000000004',
    'home-projection-b',
    '{"brand":"Other","model":"Tenant"}'::jsonb,
    '{}',
    '2026-07-17T17:00:00Z',
    '2026-07-17T17:00:00Z'
  );

insert into public.listings (
  id, user_id, item_id, platform, title, status, created_at, updated_at
) values
  (
    '25210000-0000-4000-8000-000000000001',
    'home-projection-a',
    '25200000-0000-4000-8000-000000000001',
    'ebay',
    'Canon AE-1 current draft',
    'draft',
    '2026-07-17T13:00:00Z',
    '2026-07-17T13:00:00Z'
  ),
  (
    '25210000-0000-4000-8000-000000000003',
    'home-projection-a',
    '25200000-0000-4000-8000-000000000003',
    'ebay',
    'Archived historical listing',
    'archived',
    '2026-07-17T11:00:00Z',
    '2026-07-17T11:00:00Z'
  ),
  (
    '25210000-0000-4000-8000-000000000004',
    'home-projection-b',
    '25200000-0000-4000-8000-000000000004',
    'ebay',
    'Other tenant listing',
    'published',
    '2026-07-17T17:00:00Z',
    '2026-07-17T17:00:00Z'
  );

-- Retained evaluation history for the visible item must not cross the RPC.
insert into public.prediction_logs (
  user_id, item_id, price, listing_model, created_at
)
select
  'home-projection-a',
  '25200000-0000-4000-8000-000000000001',
  series.value,
  'offline-listing',
  '2026-07-16T00:00:00Z'::timestamptz + (series.value * interval '1 second')
from generate_series(1, 250) as series(value);

insert into public.prediction_logs (
  id, user_id, item_id, price, listing_model, created_at
) values
  (
    '25220000-0000-4000-8000-000000000010',
    'home-projection-a',
    '25200000-0000-4000-8000-000000000001',
    100,
    'offline-listing',
    '2026-07-17T14:00:00Z'
  ),
  (
    '25220000-0000-4000-8000-000000000011',
    'home-projection-a',
    '25200000-0000-4000-8000-000000000001',
    205,
    'offline-listing',
    '2026-07-17T14:00:00Z'
  ),
  (
    '25220000-0000-4000-8000-000000000012',
    'home-projection-a',
    '25200000-0000-4000-8000-000000000001',
    null,
    'offline-listing',
    '2026-07-17T15:00:00Z'
  ),
  (
    '25220000-0000-4000-8000-000000000013',
    'home-projection-a',
    '25200000-0000-4000-8000-000000000003',
    999,
    'offline-listing',
    '2026-07-17T16:00:00Z'
  ),
  (
    '25220000-0000-4000-8000-000000000014',
    'home-projection-b',
    '25200000-0000-4000-8000-000000000004',
    400,
    'offline-listing',
    '2026-07-17T17:00:00Z'
  );

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"home-projection-a","role":"authenticated"}',
  true
);

select extensions.is(
  jsonb_array_length(public.get_home_current_item_projection()->'items'),
  2,
  'tenant A receives only its two current Home items'
);
select extensions.is(
  jsonb_array_length(public.get_home_current_item_projection()->'listings'),
  1,
  'tenant A receives only the current eBay listing'
);
select extensions.is(
  jsonb_array_length(public.get_home_current_item_projection()->'predictions'),
  1,
  '250 retained predictions reduce to one current-item price row'
);
select extensions.is(
  (
    select array_agg(item->>'id' order by ordinal)
    from jsonb_array_elements(
      public.get_home_current_item_projection()->'items'
    ) with ordinality as projected(item, ordinal)
  ),
  array[
    '25200000-0000-4000-8000-000000000001',
    '25200000-0000-4000-8000-000000000002'
  ]::text[],
  'current items retain the existing newest-first deterministic order'
);
select extensions.is(
  (
    select (prediction->>'price')::numeric
    from jsonb_array_elements(
      public.get_home_current_item_projection()->'predictions'
    ) as projected(prediction)
  ),
  205::numeric,
  'latest non-null price wins with id as the tied-timestamp tiebreaker'
);
select extensions.ok(
  public.get_home_current_item_projection()::text not like '%25200000-0000-4000-8000-000000000003%',
  'archived item history is excluded from the current projection rows'
);
select extensions.ok(
  public.get_home_current_item_projection()::text not like '%25200000-0000-4000-8000-000000000004%',
  'RLS excludes the other tenant from tenant A projection rows'
);
select extensions.ok(
  (public.get_home_current_item_projection()->>'history_revision_at')::timestamptz
    = '2026-07-17T16:00:00Z'::timestamptz,
  'source revision preserves tenant A historical change semantics'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"home-projection-b","role":"authenticated"}',
  true
);
select extensions.is(
  jsonb_array_length(public.get_home_current_item_projection()->'items'),
  1,
  'tenant B receives its own current item'
);
select extensions.ok(
  public.get_home_current_item_projection()::text not like '%25200000-0000-4000-8000-000000000001%',
  'tenant B cannot read tenant A through the RPC'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"home-projection-empty","role":"authenticated"}',
  true
);
select extensions.is(
  jsonb_array_length(public.get_home_current_item_projection()->'items')
    + jsonb_array_length(public.get_home_current_item_projection()->'listings')
    + jsonb_array_length(public.get_home_current_item_projection()->'predictions'),
  0,
  'an authenticated seller with no rows receives an empty projection'
);

select * from finish();
rollback;
