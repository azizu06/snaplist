begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(18);

select private.lock_ebay_messaging_account('erasure-completion-a');
select private.lock_ebay_messaging_account('erasure-completion-b');

insert into public.items (id, user_id, attributes)
values
  ('e1000000-0000-4000-8000-000000000001', 'erasure-completion-a', '{}'),
  ('e1000000-0000-4000-8000-000000000002', 'erasure-completion-a', '{}'),
  ('e1000000-0000-4000-8000-000000000003', 'erasure-completion-a', '{}'),
  ('f1000000-0000-4000-8000-000000000001', 'erasure-completion-b', '{}');

insert into public.listings (
  id, user_id, item_id, platform, title, status, ebay_status,
  ebay_publish_claim_id, ebay_publish_claimed_at
)
values
  (
    'e2000000-0000-4000-8000-000000000001',
    'erasure-completion-a',
    'e1000000-0000-4000-8000-000000000001',
    'ebay',
    'Exact completion fixture',
    'draft',
    'publishing',
    'e3000000-0000-4000-8000-000000000001',
    statement_timestamp()
  ),
  (
    'e2000000-0000-4000-8000-000000000002',
    'erasure-completion-a',
    'e1000000-0000-4000-8000-000000000002',
    'ebay',
    'Other dispatched-row fixture',
    'draft',
    'publishing',
    'e3000000-0000-4000-8000-000000000002',
    statement_timestamp()
  ),
  (
    'e2000000-0000-4000-8000-000000000003',
    'erasure-completion-a',
    'e1000000-0000-4000-8000-000000000003',
    'ebay',
    'Fresh publish fixture',
    'draft',
    'publishing',
    'e3000000-0000-4000-8000-000000000003',
    statement_timestamp()
  ),
  (
    'f2000000-0000-4000-8000-000000000001',
    'erasure-completion-b',
    'f1000000-0000-4000-8000-000000000001',
    'ebay',
    'Other tenant fixture',
    'draft',
    'publishing',
    'f3000000-0000-4000-8000-000000000001',
    statement_timestamp()
  );

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"erasure-completion-a","role":"authenticated"}',
  true
);
select set_config('request.headers', '{"x-snaplist-server-auth":"snaplist-local-server-rpc-secret-do-not-use-in-hosted"}', true);
select public.bind_ebay_sandbox_fallback('erasure-completion-a-seller');

create temporary table completion_dispatches on commit drop as
select dispatch_key,
       (lease->>'account_generation')::uuid as account_generation,
       (lease->>'attempt_token')::uuid as attempt_token
from (
  select 'exact'::text as dispatch_key,
         public.begin_ebay_transactional_dispatch(
           'e2000000-0000-4000-8000-000000000001',
           'publish',
           null,
           'e3000000-0000-4000-8000-000000000001',
           null
         ) as lease
  union all
  select 'other-row'::text,
         public.begin_ebay_transactional_dispatch(
           'e2000000-0000-4000-8000-000000000002',
           'publish',
           null,
           'e3000000-0000-4000-8000-000000000002',
           null
         )
) started;

select set_config(
  'request.jwt.claims',
  '{"sub":"erasure-completion-b","role":"authenticated"}',
  true
);
select public.bind_ebay_sandbox_fallback('erasure-completion-b-seller');

insert into completion_dispatches (dispatch_key, account_generation, attempt_token)
select 'other-tenant',
       (lease->>'account_generation')::uuid,
       (lease->>'attempt_token')::uuid
from (
  select public.begin_ebay_transactional_dispatch(
    'f2000000-0000-4000-8000-000000000001',
    'publish',
    null,
    'f3000000-0000-4000-8000-000000000001',
    null
  ) as lease
) started;

reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.begin_account_erasure(
  'erasure-completion-a',
  'e4000000-0000-4000-8000-000000000001'
);
reset role;

select extensions.ok(
  exists (
    select 1
    from private.account_erasure_generations generation
    where generation.user_id_digest = private.account_erasure_user_digest(
      'erasure-completion-a'
    )
  ),
  'owner erasure is active before provider completion tests'
);

create function pg_temp.exact_completion_state()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'listing', (select to_jsonb(listing) from public.listings listing
                where listing.id = 'e2000000-0000-4000-8000-000000000001'),
    'leases', coalesce((select jsonb_agg(to_jsonb(lease) order by lease.user_id, lease.message_id)
                         from private.ebay_provider_dispatch_leases lease
                         where lease.message_id = 'e2000000-0000-4000-8000-000000000001'), '[]'::jsonb)
  )
$$;

create temporary table exact_before on commit drop as
select pg_temp.exact_completion_state() as state;

create function pg_temp.ordinary_tenant_title_write()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.clerk_user_id() <> 'erasure-completion-a' then
    raise exception using errcode = '42501', message = 'Seller authorization is required';
  end if;

  update public.listings
  set title = 'attempted ordinary write'
  where id = 'e2000000-0000-4000-8000-000000000003'
    and user_id = public.clerk_user_id();

  if not found then
    raise exception using errcode = 'P0002', message = 'Fresh publish fixture is unavailable';
  end if;
end;
$$;

create temporary table ordinary_before on commit drop as
select to_jsonb(listing) as state
from public.listings listing
where listing.id = 'e2000000-0000-4000-8000-000000000003';

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"erasure-completion-a","role":"authenticated"}',
  true
);
select set_config('request.headers', '{"x-snaplist-server-auth":"wrong-server-rpc-secret"}', true);

select extensions.throws_ok(
  $$
    select public.complete_ebay_publish_dispatch(
      'e2000000-0000-4000-8000-000000000001',
      'e3000000-0000-4000-8000-000000000001',
      account_generation,
      null,
      attempt_token,
      'tenant-only-listing',
      'tenant-only-offer',
      41,
      '2026-08-03T00:00:00Z'
    ) from completion_dispatches where dispatch_key = 'exact'
  $$,
  '42501',
  'Server API authorization is required',
  'tenant JWT alone cannot complete an erasing owner dispatch'
);

reset role;
select extensions.results_eq(
  $$select pg_temp.exact_completion_state()$$,
  $$select state from exact_before$$,
  'tenant-only refusal leaves exact completion row and lease unchanged'
);

set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select set_config('request.headers', '{"x-snaplist-server-auth":"snaplist-local-server-rpc-secret-do-not-use-in-hosted"}', true);

select extensions.throws_ok(
  $$
    select public.complete_ebay_publish_dispatch(
      'e2000000-0000-4000-8000-000000000001',
      'e3000000-0000-4000-8000-000000000001',
      account_generation,
      null,
      attempt_token,
      'server-only-listing',
      'server-only-offer',
      41,
      '2026-08-03T00:00:00Z'
    ) from completion_dispatches where dispatch_key = 'exact'
  $$,
  '42501',
  'Seller authorization is required',
  'server key without tenant JWT cannot complete an erasing owner dispatch'
);

reset role;
select extensions.results_eq(
  $$select pg_temp.exact_completion_state()$$,
  $$select state from exact_before$$,
  'server-only refusal leaves exact completion row and lease unchanged'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"erasure-completion-a","role":"authenticated"}',
  true
);

select extensions.throws_ok(
  $$
    select public.complete_ebay_publish_dispatch(
      'e2000000-0000-4000-8000-000000000001',
      'e3000000-0000-4000-8000-000000000002',
      exact.account_generation,
      null,
      other_row.attempt_token,
      'other-row-listing',
      'other-row-offer',
      41,
      '2026-08-03T00:00:00Z'
    )
    from completion_dispatches exact
    join completion_dispatches other_row on other_row.dispatch_key = 'other-row'
    where exact.dispatch_key = 'exact'
  $$,
  'PT409',
  'eBay provider dispatch lease or publish claim changed before local completion',
  'another dispatched row cannot supply claim or lease authority'
);

reset role;
select extensions.results_eq(
  $$select pg_temp.exact_completion_state()$$,
  $$select state from exact_before$$,
  'other-row authority refusal leaves exact completion row and lease unchanged'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"erasure-completion-a","role":"authenticated"}',
  true
);
select set_config('request.headers', '{"x-snaplist-server-auth":"snaplist-local-server-rpc-secret-do-not-use-in-hosted"}', true);
select extensions.throws_ok(
  $$
    select public.complete_ebay_publish_dispatch(
      'e2000000-0000-4000-8000-000000000001',
      'f3000000-0000-4000-8000-000000000001',
      exact.account_generation,
      null,
      other_tenant.attempt_token,
      'other-tenant-listing',
      'other-tenant-offer',
      41,
      '2026-08-03T00:00:00Z'
    )
    from completion_dispatches exact
    join completion_dispatches other_tenant on other_tenant.dispatch_key = 'other-tenant'
    where exact.dispatch_key = 'exact'
  $$,
  'PT409',
  'eBay provider dispatch lease or publish claim changed before local completion',
  'another tenant cannot supply claim or lease authority'
);

reset role;
select extensions.results_eq(
  $$select pg_temp.exact_completion_state()$$,
  $$select state from exact_before$$,
  'other-tenant authority refusal leaves exact completion row and lease unchanged'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"erasure-completion-a","role":"authenticated"}',
  true
);
select set_config('request.headers', '{"x-snaplist-server-auth":"snaplist-local-server-rpc-secret-do-not-use-in-hosted"}', true);
select extensions.lives_ok(
  $$
    select public.complete_ebay_publish_dispatch(
      'e2000000-0000-4000-8000-000000000001',
      'e3000000-0000-4000-8000-000000000001',
      account_generation,
      null,
      attempt_token,
      'exact-provider-listing',
      'exact-provider-offer',
      42,
      '2026-08-03T00:00:00Z'
    ) from completion_dispatches where dispatch_key = 'exact'
  $$,
  'exact dispatched row completes with both tenant and server authority after erasure starts'
);

reset role;
select extensions.results_eq(
  $$select title from public.listings where id = 'e2000000-0000-4000-8000-000000000001'$$,
  $$select state->'listing'->>'title' from exact_before$$,
  'successful completion keeps fields outside its fixed completion set unchanged'
);

create temporary table exact_after on commit drop as
select pg_temp.exact_completion_state() as state;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"erasure-completion-a","role":"authenticated"}',
  true
);
select set_config('request.headers', '{"x-snaplist-server-auth":"snaplist-local-server-rpc-secret-do-not-use-in-hosted"}', true);
select extensions.throws_ok(
  $$
    select public.complete_ebay_publish_dispatch(
      'e2000000-0000-4000-8000-000000000001',
      'e3000000-0000-4000-8000-000000000001',
      account_generation,
      null,
      attempt_token,
      'replayed-listing',
      'replayed-offer',
      999,
      '2026-08-03T00:01:00Z'
    ) from completion_dispatches where dispatch_key = 'exact'
  $$,
  'PT409',
  'eBay provider dispatch lease or publish claim changed before local completion',
  'completion token replay is refused after successful completion'
);

reset role;
select extensions.results_eq(
  $$select pg_temp.exact_completion_state()$$,
  $$select state from exact_after$$,
  'replay refusal leaves completed listing and consumed lease unchanged'
);

reset role;
select extensions.ok(
  exists (
    select 1
    from private.account_erasure_generations generation
    where generation.user_id_digest = private.account_erasure_user_digest(
      'erasure-completion-a'
    )
  ),
  'valid completion does not reopen owner mutation authority'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"erasure-completion-a","role":"authenticated"}',
  true
);
select set_config('request.headers', '{"x-snaplist-server-auth":"snaplist-local-server-rpc-secret-do-not-use-in-hosted"}', true);

select extensions.throws_ok(
  $$
    select public.begin_ebay_transactional_dispatch(
      'e2000000-0000-4000-8000-000000000003',
      'publish',
      null,
      'e3000000-0000-4000-8000-000000000003',
      null
    )
  $$,
  '55000',
  'Account erasure has started for this account',
  'fresh publish dispatch remains fenced while owner erasure is active'
);

select extensions.throws_ok(
  $$select pg_temp.ordinary_tenant_title_write()$$,
  '55000',
  'Account erasure has started for this account',
  'ordinary tenant title write remains fenced while owner erasure is active'
);

reset role;
select extensions.results_eq(
  $$select to_jsonb(listing) from public.listings listing where listing.id = 'e2000000-0000-4000-8000-000000000003'$$,
  $$select state from ordinary_before$$,
  'ordinary tenant write refusal leaves fresh publish fixture unchanged'
);

set local role authenticated;

select set_config(
  'request.jwt.claims',
  '{"sub":"erasure-completion-b","role":"authenticated"}',
  true
);

select extensions.lives_ok(
  $$
    select public.complete_ebay_publish_dispatch(
      'f2000000-0000-4000-8000-000000000001',
      'f3000000-0000-4000-8000-000000000001',
      account_generation,
      null,
      attempt_token,
      'other-tenant-provider-listing',
      'other-tenant-provider-offer',
      43,
      '2026-08-03T00:00:00Z'
    ) from completion_dispatches where dispatch_key = 'other-tenant'
  $$,
  'foreign dispatch remains valid only for its own full authority'
);

select * from extensions.finish();
rollback;
