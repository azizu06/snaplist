begin;

create extension if not exists pgtap with schema extensions;

-- CI builds a clean stack from migrations and sets this flag, so it must test
-- the installed migration surface without replacing it. A shared local stack
-- may not have applied this branch migration without reset; there the
-- same DDL is injected only inside this transaction and rolled back at EOF.
select to_regclass('pgtap_ci.require_installed_migrations') is not null
  as require_installed_migration \gset
\if :require_installed_migration
\else
drop function if exists public.begin_mobile_ebay_publish(uuid, uuid, uuid, uuid);
alter table public.listings
  drop column if exists ebay_publish_idempotency_key,
  drop column if exists ebay_publish_expected_review_revision;

alter table public.listings
  add column ebay_publish_idempotency_key uuid,
  add column ebay_publish_expected_review_revision uuid;

comment on column public.listings.ebay_publish_idempotency_key is
  'Mobile confirmation key retained across an ambiguous eBay publish for exact replay.';
comment on column public.listings.ebay_publish_expected_review_revision is
  'Seller-observed review revision paired with the mobile publish confirmation.';

create function public.begin_mobile_ebay_publish(
  p_listing_id uuid,
  p_expected_run_id uuid,
  p_expected_review_revision uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_listing public.listings%rowtype;
  v_item_revision uuid;
  v_snapshot jsonb;
  v_claim jsonb;
  v_claim_id uuid;
begin
  if nullif(v_user_id, '') is null then
    raise exception using errcode = '42501', message = 'Authentication required.';
  end if;
  if p_idempotency_key is null or p_expected_review_revision is null then
    raise exception using errcode = '22023', message = 'Publish confirmation is required.';
  end if;

  select listing.*
  into v_listing
  from public.listings listing
  where listing.id = p_listing_id
    and listing.user_id = v_user_id
    and listing.platform = 'ebay'
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Editable eBay listing changed.';
  end if;

  if v_listing.ebay_status = 'publishing'
    and v_listing.ebay_publish_idempotency_key = p_idempotency_key then
    if v_listing.ebay_publish_expected_review_revision
      is distinct from p_expected_review_revision then
      raise exception using errcode = 'P0002', message = 'Publish confirmation changed.';
    end if;
    select item.review_revision
    into v_item_revision
    from public.items item
    where item.id = v_listing.item_id
      and item.user_id = v_user_id
    for update;
    if v_item_revision is distinct from v_listing.ebay_publish_claim_id then
      raise exception using errcode = 'P0002', message = 'Publish claim changed.';
    end if;
    v_snapshot := public.get_review_snapshot(v_listing.item_id);
    if v_snapshot is null
      or v_snapshot#>>'{listing,id}' is distinct from p_listing_id::text then
      raise exception using errcode = 'P0002', message = 'Publish snapshot changed.';
    end if;
    return jsonb_build_object(
      'claimId', v_listing.ebay_publish_claim_id,
      'listingId', p_listing_id,
      'itemId', v_listing.item_id,
      'title', v_snapshot#>>'{listing,title}',
      'description', v_snapshot#>>'{listing,description}',
      'copy', coalesce(v_snapshot#>'{listing,copy}', '{}'::jsonb),
      'condition', v_snapshot#>>'{item,condition}',
      'photos', coalesce(v_snapshot#>'{item,photos}', '[]'::jsonb),
      'price', v_snapshot#>'{prediction,price}',
      'priceOverride', v_snapshot#>'{item,price_override}'
    );
  end if;

  v_claim := public.begin_ebay_publish(
    p_listing_id,
    p_expected_run_id,
    p_expected_review_revision
  );
  v_claim_id := nullif(v_claim->>'claimId', '')::uuid;
  update public.listings listing
  set ebay_publish_idempotency_key = p_idempotency_key,
      ebay_publish_expected_review_revision = p_expected_review_revision
  where listing.id = p_listing_id
    and listing.user_id = v_user_id
    and listing.ebay_status = 'publishing'
    and listing.ebay_publish_claim_id = v_claim_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Publish claim was lost.';
  end if;
  return v_claim;
end;
$$;

revoke all on function public.begin_mobile_ebay_publish(uuid, uuid, uuid, uuid)
  from public, anon;
grant execute on function public.begin_mobile_ebay_publish(uuid, uuid, uuid, uuid)
  to authenticated;
\endif

select extensions.plan(15);

select extensions.has_function(
  'public',
  'begin_mobile_ebay_publish',
  array['uuid', 'uuid', 'uuid', 'uuid'],
  'mobile publish migration installs the exact-once RPC'
);
select extensions.has_column(
  'public',
  'listings',
  'ebay_publish_idempotency_key',
  'mobile publish migration installs the confirmation key'
);
select extensions.has_column(
  'public',
  'listings',
  'ebay_publish_expected_review_revision',
  'mobile publish migration installs the paired review revision'
);
select extensions.ok(
  position(
    'listing.user_id = v_user_id' in pg_get_functiondef(
      'public.begin_mobile_ebay_publish(uuid,uuid,uuid,uuid)'::regprocedure
    )
  ) > 0,
  'mobile publish RPC keeps its listing tenant predicate'
);
select extensions.ok(
  position(
    'item.user_id = v_user_id' in pg_get_functiondef(
      'public.begin_mobile_ebay_publish(uuid,uuid,uuid,uuid)'::regprocedure
    )
  ) > 0,
  'mobile publish replay keeps its item tenant predicate'
);

insert into public.items (
  id, user_id, attributes, condition, photos, review_revision, price_override
)
values
  (
    'a1000000-0000-4000-8000-000000000628',
    'mobile-publish-tenant-a',
    '{}',
    'good',
    array['mobile-publish-tenant-a/item.jpg'],
    'a3000000-0000-4000-8000-000000000628',
    58.00
  ),
  (
    'b1000000-0000-4000-8000-000000000628',
    'mobile-publish-tenant-b',
    '{}',
    'good',
    array['mobile-publish-tenant-b/item.jpg'],
    'b3000000-0000-4000-8000-000000000628',
    64.00
  );

insert into public.listings (
  id, user_id, item_id, platform, title, description, copy, status, run_id
)
values
  (
    'a2000000-0000-4000-8000-000000000628',
    'mobile-publish-tenant-a',
    'a1000000-0000-4000-8000-000000000628',
    'ebay',
    'Tenant A publish fixture',
    'Tenant A description',
    '{}',
    'draft',
    'a4000000-0000-4000-8000-000000000628'
  ),
  (
    'b2000000-0000-4000-8000-000000000628',
    'mobile-publish-tenant-b',
    'b1000000-0000-4000-8000-000000000628',
    'ebay',
    'Tenant B publish fixture',
    'Tenant B description',
    '{}',
    'draft',
    'b4000000-0000-4000-8000-000000000628'
  );

-- Shared long-lived stacks can predate Supabase's generated table grants.
-- Keep this compatibility grant inside the rolled-back test transaction.
grant select, update on public.items, public.listings to authenticated;
grant select on public.prediction_logs to authenticated;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"mobile-publish-tenant-a","role":"authenticated"}',
  true
);

create temporary table mobile_publish_claim_a on commit drop as
select public.begin_mobile_ebay_publish(
  'a2000000-0000-4000-8000-000000000628',
  'a4000000-0000-4000-8000-000000000628',
  'a3000000-0000-4000-8000-000000000628',
  'a5000000-0000-4000-8000-000000000628'
) as claim;

reset role;
select extensions.is(
  (select claim->>'listingId' from mobile_publish_claim_a),
  'a2000000-0000-4000-8000-000000000628',
  'tenant A starts its own mobile publish claim'
);
select extensions.results_eq(
  $$
    select ebay_publish_idempotency_key
    from public.listings
    where id = 'a2000000-0000-4000-8000-000000000628'
  $$,
  $$values ('a5000000-0000-4000-8000-000000000628'::uuid)$$,
  'tenant A confirmation key is durable on its listing'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"mobile-publish-tenant-a","role":"authenticated"}',
  true
);
create temporary table mobile_publish_replay_a on commit drop as
select public.begin_mobile_ebay_publish(
  'a2000000-0000-4000-8000-000000000628',
  'a4000000-0000-4000-8000-000000000628',
  'a3000000-0000-4000-8000-000000000628',
  'a5000000-0000-4000-8000-000000000628'
) as claim;
reset role;
select extensions.results_eq(
  $$select claim->>'claimId' from mobile_publish_replay_a$$,
  $$select claim->>'claimId' from mobile_publish_claim_a$$,
  'tenant A exact replay returns its original claim'
);

-- RLS remains separately covered by shared-stack suites. Run cross-tenant
-- probes as the local database owner (which has BYPASSRLS) while retaining each
-- tenant JWT, so only the RPC's explicit user_id predicates can refuse them.
select set_config(
  'request.jwt.claims',
  '{"sub":"mobile-publish-tenant-b","role":"authenticated"}',
  true
);
select extensions.throws_ok(
  $$
    select public.begin_mobile_ebay_publish(
      'a2000000-0000-4000-8000-000000000628',
      'a4000000-0000-4000-8000-000000000628',
      'a3000000-0000-4000-8000-000000000628',
      'a5000000-0000-4000-8000-000000000628'
    )
  $$,
  'P0002',
  'Editable eBay listing changed.',
  'tenant B cannot replay tenant A claim even without RLS masking the RPC predicate'
);
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"mobile-publish-tenant-a","role":"authenticated"}',
  true
);
create temporary table mobile_publish_replay_a_after_refusal on commit drop as
select public.begin_mobile_ebay_publish(
  'a2000000-0000-4000-8000-000000000628',
  'a4000000-0000-4000-8000-000000000628',
  'a3000000-0000-4000-8000-000000000628',
  'a5000000-0000-4000-8000-000000000628'
) as claim;
reset role;
select extensions.results_eq(
  $$select claim->>'claimId' from mobile_publish_replay_a_after_refusal$$,
  $$select claim->>'claimId' from mobile_publish_claim_a$$,
  'tenant A row refused to tenant B remains an otherwise accepted exact replay'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"mobile-publish-tenant-b","role":"authenticated"}',
  true
);
create temporary table mobile_publish_claim_b on commit drop as
select public.begin_mobile_ebay_publish(
  'b2000000-0000-4000-8000-000000000628',
  'b4000000-0000-4000-8000-000000000628',
  'b3000000-0000-4000-8000-000000000628',
  'b5000000-0000-4000-8000-000000000628'
) as claim;
reset role;
select extensions.is(
  (select claim->>'listingId' from mobile_publish_claim_b),
  'b2000000-0000-4000-8000-000000000628',
  'tenant B starts its own mobile publish claim'
);
select extensions.results_eq(
  $$
    select ebay_publish_idempotency_key
    from public.listings
    where id = 'b2000000-0000-4000-8000-000000000628'
  $$,
  $$values ('b5000000-0000-4000-8000-000000000628'::uuid)$$,
  'tenant B confirmation key is durable on its listing'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"mobile-publish-tenant-a","role":"authenticated"}',
  true
);
select extensions.throws_ok(
  $$
    select public.begin_mobile_ebay_publish(
      'b2000000-0000-4000-8000-000000000628',
      'b4000000-0000-4000-8000-000000000628',
      'b3000000-0000-4000-8000-000000000628',
      'b5000000-0000-4000-8000-000000000628'
    )
  $$,
  'P0002',
  'Editable eBay listing changed.',
  'tenant A cannot replay tenant B claim even without RLS masking the RPC predicate'
);
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"mobile-publish-tenant-b","role":"authenticated"}',
  true
);
create temporary table mobile_publish_replay_b_after_refusal on commit drop as
select public.begin_mobile_ebay_publish(
  'b2000000-0000-4000-8000-000000000628',
  'b4000000-0000-4000-8000-000000000628',
  'b3000000-0000-4000-8000-000000000628',
  'b5000000-0000-4000-8000-000000000628'
) as claim;
reset role;
select extensions.results_eq(
  $$select claim->>'claimId' from mobile_publish_replay_b_after_refusal$$,
  $$select claim->>'claimId' from mobile_publish_claim_b$$,
  'tenant B row refused to tenant A remains an otherwise accepted exact replay'
);
select extensions.ok(
  (select claim->>'claimId' from mobile_publish_claim_a)
    <> (select claim->>'claimId' from mobile_publish_claim_b),
  'distinct tenants keep distinct durable publish claims'
);

select * from extensions.finish();
rollback;
