begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(21);

-- =====================================================================
-- Issue #378 — assisted export packs for Facebook Marketplace, Mercari,
-- and Depop.
--
-- The one invariant this contract exists to protect: SnapList CANNOT
-- observe the destination. Preparing a pack, opening the share sheet,
-- copying the text, and saving the photos all prove NOTHING about
-- whether a listing went up. Only an explicit seller confirmation may
-- ever write `Shared`, that confirmation must abort when the pack is
-- stale or when the row never performed a handoff, and no assisted
-- export row may ever reach `published`.
--
-- Every timestamp below is anchored to now() (= transaction_timestamp(),
-- frozen at BEGIN). No wall-clock literal appears in this file, so it
-- cannot expire on a calendar rollover.
-- =====================================================================

insert into public.items (
  id, user_id, attributes, review_content_revision, review_revision
)
values
  (
    'e7100000-0000-4000-8000-000000000001',
    'export-handoff-a',
    '{}',
    'e7200000-0000-4000-8000-000000000001',
    'e7300000-0000-4000-8000-000000000001'
  ),
  (
    'e7100000-0000-4000-8000-000000000002',
    'export-handoff-b',
    '{}',
    'e7200000-0000-4000-8000-000000000002',
    'e7300000-0000-4000-8000-000000000002'
  );

-- ---------------------------------------------------------------------
-- Structure: where the receipt lives and who may write it.
-- ---------------------------------------------------------------------
select extensions.has_table(
  'public', 'export_handoffs',
  'assisted-export handoff receipts are durable tenant rows'
);

select extensions.ok(
  (
    select relation.relrowsecurity
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'export_handoffs'
  ),
  'handoff receipts are isolated by RLS'
);

select extensions.ok(
  has_table_privilege('authenticated', 'public.export_handoffs', 'select'),
  'a seller may read their own handoff receipts'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.export_handoffs', 'insert')
    and not has_table_privilege('authenticated', 'public.export_handoffs', 'update'),
  'a receipt can only be written through the guarded confirmation capability'
);

-- The invariant is enforced by the database itself, not only by the RPC:
-- a `Shared` receipt for a row that never performed a handoff is
-- unrepresentable.
select extensions.throws_ok(
  $$
    insert into public.export_handoffs (
      user_id, item_id, platform, source_review_revision, handoff_at, shared_at
    )
    values (
      'export-handoff-a',
      'e7100000-0000-4000-8000-000000000001',
      'facebook',
      'e7200000-0000-4000-8000-000000000001',
      null,
      now()
    )
  $$,
  '23514',
  null,
  'Shared cannot be recorded for a row that never performed a handoff'
);

-- `Prepared` and `Shared` are the only assisted-export outcomes. A pack
-- row can never claim the eBay-only `published` lifecycle.
select extensions.throws_ok(
  $$
    insert into public.listings (
      user_id, item_id, platform, title, description, copy, status,
      source_review_revision
    )
    values (
      'export-handoff-a',
      'e7100000-0000-4000-8000-000000000001',
      'depop',
      'Assisted export row',
      'Assisted export description',
      '{}'::jsonb,
      'published',
      'e7200000-0000-4000-8000-000000000001'
    )
  $$,
  '23514',
  null,
  'an assisted-export pack row can never reach published'
);

-- ---------------------------------------------------------------------
-- Behaviour, as the owning seller.
--
-- `clerk_user_id()` reads the JWT claim, not the database role, so the
-- tenant identity below governs every guard regardless of which role
-- executes it. The pack write is SECURITY INVOKER, so it runs before the
-- role switch — its guards are the subject here, not the table grants a
-- local stack may or may not carry. The handoff capabilities are
-- SECURITY DEFINER and are exercised as the seller.
-- ---------------------------------------------------------------------
select set_config(
  'request.jwt.claims',
  '{"sub":"export-handoff-a","role":"authenticated"}',
  true
);

select extensions.lives_ok(
  $$
    select public.persist_export_packs(
      'e7100000-0000-4000-8000-000000000001'::uuid,
      'e7200000-0000-4000-8000-000000000001'::uuid,
      'e7300000-0000-4000-8000-000000000001'::uuid,
      jsonb_build_array(
        jsonb_build_object(
          'platform', 'facebook', 'title', 'Facebook pack',
          'description', 'Facebook description', 'copy', '{}'::jsonb
        ),
        jsonb_build_object(
          'platform', 'mercari', 'title', 'Mercari pack',
          'description', 'Mercari description', 'copy', '{}'::jsonb
        ),
        jsonb_build_object(
          'platform', 'depop', 'title', 'Depop row identity',
          'description', 'Depop description', 'copy', '{}'::jsonb
        )
      )
    )
  $$,
  'all three assisted destinations persist in one revision-guarded write'
);

set local role authenticated;

-- Confirming a share SnapList never handed off is the exact defect this
-- family exists to prevent.
select extensions.throws_ok(
  $$
    select public.mark_export_shared(
      'e7100000-0000-4000-8000-000000000001'::uuid,
      'depop',
      'e7200000-0000-4000-8000-000000000001'::uuid,
      'e7300000-0000-4000-8000-000000000001'::uuid
    )
  $$,
  'P0002',
  null,
  'confirmation aborts when the row never performed a handoff'
);

select extensions.ok(
  (
    select public.record_export_handoff(
      'e7100000-0000-4000-8000-000000000001'::uuid,
      'depop',
      'e7200000-0000-4000-8000-000000000001'::uuid,
      'e7300000-0000-4000-8000-000000000001'::uuid
    )
  ) is not null,
  'handing the pack to the destination records a durable handoff'
);

-- eBay is a transactional adapter, never an assisted handoff.
select extensions.throws_ok(
  $$
    select public.record_export_handoff(
      'e7100000-0000-4000-8000-000000000001'::uuid,
      'ebay',
      'e7200000-0000-4000-8000-000000000001'::uuid,
      'e7300000-0000-4000-8000-000000000001'::uuid
    )
  $$,
  '22023',
  null,
  'eBay never receives an assisted-export handoff receipt'
);

select extensions.ok(
  (
    select public.mark_export_shared(
      'e7100000-0000-4000-8000-000000000001'::uuid,
      'depop',
      'e7200000-0000-4000-8000-000000000001'::uuid,
      'e7300000-0000-4000-8000-000000000001'::uuid
    )
  ) is not null,
  'the seller''s explicit confirmation is what writes Shared'
);

-- Age the receipt so a replayed confirmation cannot hide behind now()
-- being frozen for the whole transaction: if the second call rewrote the
-- timestamp, the shifted value would not survive.
reset role;
update public.export_handoffs
set shared_at = shared_at - interval '5 minutes'
where item_id = 'e7100000-0000-4000-8000-000000000001'
  and platform = 'depop';
set local role authenticated;

select extensions.is(
  (
    select public.mark_export_shared(
      'e7100000-0000-4000-8000-000000000001'::uuid,
      'depop',
      'e7200000-0000-4000-8000-000000000001'::uuid,
      'e7300000-0000-4000-8000-000000000001'::uuid
    )
  ),
  now() - interval '5 minutes',
  'a replayed confirmation returns the original receipt instead of a new one'
);

select extensions.is(
  (
    select count(*)::integer
    from public.export_handoffs
    where item_id = 'e7100000-0000-4000-8000-000000000001'
      and platform = 'depop'
  ),
  1,
  'retry cannot duplicate a durable delivery receipt'
);

select extensions.is(
  (
    select count(*)::integer
    from public.export_handoffs
    where item_id = 'e7100000-0000-4000-8000-000000000001'
      and platform in ('facebook', 'mercari')
      and shared_at is not null
  ),
  0,
  'confirming one destination never marks the others shared'
);

-- Gate 2: a listing change must invalidate a mounted confirm sheet. The
-- client passes the revision it rendered; a stale one fails closed.
select extensions.throws_ok(
  $$
    select public.mark_export_shared(
      'e7100000-0000-4000-8000-000000000001'::uuid,
      'facebook',
      'e7200000-0000-4000-8000-000000000001'::uuid,
      'e7300000-0000-4000-8000-000000000009'::uuid
    )
  $$,
  'P0002',
  null,
  'a confirmation carrying a stale revision cannot write Shared'
);

select extensions.throws_ok(
  $$
    select public.record_export_handoff(
      'e7100000-0000-4000-8000-000000000001'::uuid,
      'facebook',
      'e7200000-0000-4000-8000-000000000001'::uuid,
      'e7300000-0000-4000-8000-000000000009'::uuid
    )
  $$,
  'P0002',
  null,
  'a stale pack cannot be handed off at all'
);

-- Only the seller may un-confirm their own bookkeeping.
select extensions.lives_ok(
  $$
    select public.undo_export_shared(
      'e7100000-0000-4000-8000-000000000001'::uuid,
      'depop',
      'e7200000-0000-4000-8000-000000000001'::uuid,
      'e7300000-0000-4000-8000-000000000001'::uuid
    )
  $$,
  'the seller can take back a confirmation they did not mean'
);

select extensions.is(
  (
    select count(*)::integer
    from public.export_handoffs
    where item_id = 'e7100000-0000-4000-8000-000000000001'
      and platform = 'depop'
      and shared_at is null
      and handoff_at is not null
  ),
  1,
  'undo returns the pack to prepared without erasing that a handoff happened'
);

-- ---------------------------------------------------------------------
-- Tenancy.
-- ---------------------------------------------------------------------
select set_config(
  'request.jwt.claims',
  '{"sub":"export-handoff-b","role":"authenticated"}',
  true
);

select extensions.throws_ok(
  $$
    select public.mark_export_shared(
      'e7100000-0000-4000-8000-000000000001'::uuid,
      'depop',
      'e7200000-0000-4000-8000-000000000001'::uuid,
      'e7300000-0000-4000-8000-000000000001'::uuid
    )
  $$,
  'P0002',
  null,
  'another tenant cannot confirm a share on an item they do not own'
);

select extensions.is(
  (
    select count(*)::integer
    from public.export_handoffs
    where item_id = 'e7100000-0000-4000-8000-000000000001'
  ),
  0,
  'handoff receipts are invisible across tenants'
);

-- Retention: a receipt cannot outlive the pack it describes. Guided
-- identity correction deletes stale pack rows when a revision advances.
reset role;
delete from public.listings
where item_id = 'e7100000-0000-4000-8000-000000000001'
  and source_review_revision = 'e7200000-0000-4000-8000-000000000001';

select extensions.is(
  (
    select count(*)::integer
    from public.export_handoffs
    where item_id = 'e7100000-0000-4000-8000-000000000001'
  ),
  0,
  'invalidating the pack deletes its handoff receipt'
);

select * from extensions.finish();
rollback;
