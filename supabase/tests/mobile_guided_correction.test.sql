begin;

create extension if not exists pgtap with schema extensions;

select extensions.plan(25);

-- Issue #597: the native guided identity correction.
--
-- Two contracts, proved against a real database because both live in SQL:
--
--   1. A confirmed identity has to reach `items.identification`, which is the
--      column `get_mobile_listing_review` projects into the client. A receipt
--      that says "Sony WH-1000XM4" next to a stored identity that still says
--      "Dell XPS 15" is not a correction that succeeded — it is one that
--      silently did not happen, and the seller sees the old identity the
--      moment the client refetches.
--
--   2. Two corrections holding the same review revision must not both reach
--      the pricing provider. Exactly one can win the revision guard; without
--      the claim, the loser's provider spend is billed and then discarded.
--
-- Everything runs inside one rolled-back transaction, so no fixture touches a
-- shared database.

-- A run only attaches to an item that carries a photo identity, so the
-- fixtures below are complete items rather than the minimum the correction
-- itself reads.
insert into public.items (
  id, user_id, photos, attributes, identification, review_revision,
  photo_identity_kind, photo_identity_fingerprint
) values (
  '59710000-0000-4000-8000-000000000001',
  'guided_597_owner',
  array['guided_597_owner/items/photo-0.enc'],
  '{"brand":"Dell","model":"XPS 15","specs":["16GB RAM"]}'::jsonb,
  '{"label":"Dell XPS 15","confident":true,"evidence":0.75}'::jsonb,
  '59730000-0000-4000-8000-000000000001',
  'legacy_path_v0',
  encode(sha256(convert_to(
    array_to_json(array['guided_597_owner/items/photo-0.enc'])::text, 'UTF8'
  )), 'hex')
),
(
  '59710000-0000-4000-8000-000000000002',
  'guided_597_other',
  array['guided_597_other/items/photo-0.enc'],
  '{"brand":"Dell"}'::jsonb,
  '{"label":"Dell XPS 15","confident":true,"evidence":0.75}'::jsonb,
  '59730000-0000-4000-8000-000000000002',
  'legacy_path_v0',
  encode(sha256(convert_to(
    array_to_json(array['guided_597_other/items/photo-0.enc'])::text, 'UTF8'
  )), 'hex')
);

insert into public.pipeline_runs (
  id, user_id, item_id, status, stage, idempotency_key, completed_at
) values (
  '59720000-0000-4000-8000-000000000001',
  'guided_597_owner',
  '59710000-0000-4000-8000-000000000001',
  'succeeded',
  'completed',
  'guided-597-run-1',
  statement_timestamp()
),
(
  '59720000-0000-4000-8000-000000000002',
  'guided_597_other',
  '59710000-0000-4000-8000-000000000002',
  'succeeded',
  'completed',
  'guided-597-run-2',
  statement_timestamp()
);

-- ---------------------------------------------------------------------------
-- Reachability. `clerk_user_id()` reads the JWT claim, not the database role.
-- ---------------------------------------------------------------------------

select extensions.function_privs_are(
  'public', 'sharpen_review_estimate',
  array[
    'uuid', 'uuid', 'uuid', 'jsonb', 'numeric', 'jsonb', 'numeric', 'text',
    'text', 'text', 'text', 'jsonb', 'boolean', 'boolean', 'jsonb'
  ],
  'anon', array[]::text[],
  'an unauthenticated caller cannot sharpen an estimate'
);
select extensions.function_privs_are(
  'public', 'claim_mobile_guided_correction',
  array['text', 'uuid', 'uuid', 'uuid', 'jsonb', 'jsonb'],
  'anon', array[]::text[],
  'an unauthenticated caller cannot claim a correction'
);
select extensions.function_privs_are(
  'public', 'claim_mobile_guided_correction',
  array['text', 'uuid', 'uuid', 'uuid', 'jsonb', 'jsonb'],
  'authenticated', array['EXECUTE'],
  'a seller claims their own correction'
);
select extensions.table_privs_are(
  'private', 'mobile_guided_corrections', 'authenticated', array[]::text[],
  'the claim table is not reachable through the API'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"guided_597_owner","role":"authenticated"}',
  true
);

-- ---------------------------------------------------------------------------
-- 1. The corrected identity reaches the column the client reads.
-- ---------------------------------------------------------------------------

select extensions.lives_ok(
  $$
    select public.sharpen_review_estimate(
      '59710000-0000-4000-8000-000000000001'::uuid,
      '59730000-0000-4000-8000-000000000001'::uuid,
      '59740000-0000-4000-8000-000000000001'::uuid,
      '{"brand":"Sony","model":"WH-1000XM4","title":"Sony WH-1000XM4","specs":["16GB RAM","Noise cancelling"]}'::jsonb,
      180.00,
      '{"low":160,"high":200}'::jsonb,
      0.8,
      'ebay-sold',
      'vision-model',
      -- NOT NULL in `prediction_logs`, unlike `model`, which is exactly why a
      -- legacy row can lose its model provenance and still be a real price.
      'listing-model',
      null,
      '[]'::jsonb,
      false,
      false,
      '{"label":"Sony WH-1000XM4","confident":true,"evidence":0.75}'::jsonb
    )
  $$,
  'a seller sharpens their own estimate with a confirmed identity'
);

select extensions.is(
  (
    select item.identification->>'label'
    from public.items item
    where item.id = '59710000-0000-4000-8000-000000000001'
  ),
  'Sony WH-1000XM4',
  'the confirmed identity reaches items.identification, which is what the client reads back'
);
select extensions.is(
  (
    select item.attributes->>'brand'
    from public.items item
    where item.id = '59710000-0000-4000-8000-000000000001'
  ),
  'Sony',
  'the attributes carry the same corrected identity the identification does'
);
select extensions.is(
  (
    select item.review_revision
    from public.items item
    where item.id = '59710000-0000-4000-8000-000000000001'
  ),
  '59740000-0000-4000-8000-000000000001'::uuid,
  'the correction spends the revision the seller held'
);

-- A specs-only sharpen re-prices; it makes no claim about what the item IS, so
-- it must leave the vision step's identification exactly where it was.
select extensions.lives_ok(
  $$
    select public.sharpen_review_estimate(
      '59710000-0000-4000-8000-000000000001'::uuid,
      '59740000-0000-4000-8000-000000000001'::uuid,
      '59740000-0000-4000-8000-000000000002'::uuid,
      '{"brand":"Sony","model":"WH-1000XM4","specs":["16GB RAM","Noise cancelling","Over-ear"]}'::jsonb,
      175.00,
      '{"low":150,"high":200}'::jsonb,
      0.8,
      'ebay-sold',
      'vision-model',
      -- NOT NULL in `prediction_logs`, unlike `model`, which is exactly why a
      -- legacy row can lose its model provenance and still be a real price.
      'listing-model',
      null,
      '[]'::jsonb,
      false,
      false
    )
  $$,
  'a specs-only sharpen omits the identification argument entirely'
);
select extensions.is(
  (
    select item.identification->>'label'
    from public.items item
    where item.id = '59710000-0000-4000-8000-000000000001'
  ),
  'Sony WH-1000XM4',
  'a specs-only sharpen leaves the identification alone rather than blanking it'
);

select extensions.throws_ok(
  $$
    select public.sharpen_review_estimate(
      '59710000-0000-4000-8000-000000000001'::uuid,
      '59740000-0000-4000-8000-000000000002'::uuid,
      '59740000-0000-4000-8000-000000000003'::uuid,
      '{"brand":"Sony"}'::jsonb,
      175.00,
      '{"low":150,"high":200}'::jsonb,
      0.8,
      'ebay-sold',
      'vision-model',
      -- NOT NULL in `prediction_logs`, unlike `model`, which is exactly why a
      -- legacy row can lose its model provenance and still be a real price.
      'listing-model',
      null,
      '[]'::jsonb,
      false,
      false,
      '"not an object"'::jsonb
    )
  $$,
  '22023',
  'Identification must be an object.',
  'a malformed identification is refused rather than projected into the client'
);

select extensions.throws_ok(
  $$
    select public.sharpen_review_estimate(
      '59710000-0000-4000-8000-000000000001'::uuid,
      '59730000-0000-4000-8000-000000000001'::uuid,
      '59740000-0000-4000-8000-000000000004'::uuid,
      '{"brand":"Sony"}'::jsonb,
      175.00,
      '{"low":150,"high":200}'::jsonb,
      0.8,
      'ebay-sold',
      'vision-model',
      -- NOT NULL in `prediction_logs`, unlike `model`, which is exactly why a
      -- legacy row can lose its model provenance and still be a real price.
      'listing-model',
      null,
      '[]'::jsonb,
      false,
      false,
      '{"label":"Stale","confident":false,"evidence":0.1}'::jsonb
    )
  $$,
  'P0002',
  'Review changed. Reload and try again.',
  'a correction aimed at a spent revision cannot write an identity'
);
select extensions.is(
  (
    select item.identification->>'label'
    from public.items item
    where item.id = '59710000-0000-4000-8000-000000000001'
  ),
  'Sony WH-1000XM4',
  'the refused correction wrote no identity at all'
);

-- ---------------------------------------------------------------------------
-- 2. The claim, which is what keeps provider spend to one per seller intent.
-- ---------------------------------------------------------------------------

select extensions.is(
  public.claim_mobile_guided_correction(
    'prepare',
    '59720000-0000-4000-8000-000000000001'::uuid,
    '59750000-0000-4000-8000-000000000001'::uuid,
    '59740000-0000-4000-8000-000000000002'::uuid,
    '{"addedSpecs":["Noise cancelling"]}'::jsonb
  )->>'state',
  'proceed',
  'the first correction of a revision is allowed to reach the provider'
);
select extensions.is(
  public.claim_mobile_guided_correction(
    'prepare',
    '59720000-0000-4000-8000-000000000001'::uuid,
    '59750000-0000-4000-8000-000000000002'::uuid,
    '59740000-0000-4000-8000-000000000002'::uuid,
    '{"addedSpecs":["Over-ear"]}'::jsonb
  )->>'state',
  'in_progress',
  'a competing correction on the same revision never reaches the provider'
);
select extensions.is(
  public.claim_mobile_guided_correction(
    'prepare',
    '59720000-0000-4000-8000-000000000001'::uuid,
    '59750000-0000-4000-8000-000000000001'::uuid,
    '59740000-0000-4000-8000-000000000002'::uuid,
    '{"addedSpecs":["Noise cancelling"]}'::jsonb
  )->>'state',
  'in_progress',
  'the same key replayed while its own lease is live does not run twice'
);

select extensions.throws_ok(
  $$
    select public.claim_mobile_guided_correction(
      'prepare',
      '59720000-0000-4000-8000-000000000001'::uuid,
      '59750000-0000-4000-8000-000000000001'::uuid,
      '59740000-0000-4000-8000-000000000002'::uuid,
      '{"addedSpecs":["Something else entirely"]}'::jsonb
    )
  $$,
  'P0003',
  'This Idempotency-Key is already bound to a different correction.',
  'one key cannot be reused for a different correction'
);

select extensions.is(
  public.claim_mobile_guided_correction(
    'complete',
    '59720000-0000-4000-8000-000000000001'::uuid,
    '59750000-0000-4000-8000-000000000001'::uuid,
    '59740000-0000-4000-8000-000000000002'::uuid,
    '{"addedSpecs":["Noise cancelling"]}'::jsonb,
    '{"schemaVersion":1,"effectivePrice":180}'::jsonb
  )->>'state',
  'completed',
  'a finished correction records its receipt'
);
select extensions.is(
  public.claim_mobile_guided_correction(
    'prepare',
    '59720000-0000-4000-8000-000000000001'::uuid,
    '59750000-0000-4000-8000-000000000001'::uuid,
    '59740000-0000-4000-8000-000000000002'::uuid,
    '{"addedSpecs":["Noise cancelling"]}'::jsonb
  )->'receipt'->>'effectivePrice',
  '180',
  'a client retry is answered from the stored receipt instead of re-priced'
);

-- A released lease has to leave the seller able to try again immediately —
-- a failure that stranded the lease would lock them out of their own item.
select extensions.is(
  public.claim_mobile_guided_correction(
    'fail',
    '59720000-0000-4000-8000-000000000001'::uuid,
    '59750000-0000-4000-8000-000000000002'::uuid,
    '59740000-0000-4000-8000-000000000002'::uuid,
    '{"addedSpecs":["Over-ear"]}'::jsonb
  )->>'state',
  'unchanged',
  'releasing a lease that was never granted changes nothing'
);

-- Definer rights stop at the caller's own tenancy, so the claim can never
-- become a cross-tenant existence probe.
select extensions.throws_ok(
  $$
    select public.claim_mobile_guided_correction(
      'prepare',
      '59720000-0000-4000-8000-000000000002'::uuid,
      '59750000-0000-4000-8000-000000000003'::uuid,
      '59730000-0000-4000-8000-000000000002'::uuid,
      '{"addedSpecs":["Anything"]}'::jsonb
    )
  $$,
  'P0002',
  'This run is unavailable.',
  'a seller cannot claim a correction on another tenant run'
);
select extensions.is(
  (
    select count(*)::integer
    from private.mobile_guided_corrections claim
    where claim.user_id <> 'guided_597_owner'
  ),
  0,
  'the refused cross-tenant claim left no row behind'
);

-- ---------------------------------------------------------------------------
-- 4. The claim table is tenant data, so account erasure has to reach it.
--
-- `account_erasure.test.sql` derives every table carrying a `user_id` into its
-- erasure scope and asserts the catalog wiring: a fence trigger exists, and the
-- completion proof names the table. That guard is what caught this table being
-- added without either. Catalog wiring is not the contract though — these three
-- assert the behaviour it is supposed to produce, the same way #384 asserted it
-- for `public.export_handoffs` rather than trusting the derived guard alone.
-- ---------------------------------------------------------------------------

-- No savepoint here: this is the file's last block, and rolling back to one
-- would discard pgTAP's own result rows along with the fixtures — the counter
-- lives in a temp table and is as transactional as everything else. The outer
-- `rollback` at the bottom is what keeps all of this off the shared database.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.user_settings (user_id) values ('guided_597_owner');

-- Measured as a delta, not a total. A total reads zero after erasure whether or
-- not `account_erasure_owned_row_count` mentions this table at all, so it would
-- pass with the count line deleted.
create temporary table guided_correction_erasure_probe as
select private.account_erasure_owned_row_count('guided_597_owner') as before_claim;

insert into private.mobile_guided_corrections (
  user_id, idempotency_key, run_id, expected_review_revision, intent
) values (
  'guided_597_owner',
  '59750000-0000-4000-8000-0000000000e1',
  '59720000-0000-4000-8000-000000000001',
  '59730000-0000-4000-8000-000000000001',
  '{"addedSpecs":["Includes original charger"]}'::jsonb
);
select extensions.is(
  private.account_erasure_owned_row_count('guided_597_owner')
    - (select before_claim from guided_correction_erasure_probe),
  1,
  'an in-flight correction raises the count that has to reach zero before erasure may finish'
);

-- The row a cascade cannot reach. `run_id` cascades from `public.pipeline_runs`,
-- but the completion proof counts `where user_id = …` — two different keys, and
-- nothing cross-checks them, because the claim RPC enforces the match while the
-- table itself does not. A row carrying this tenant's `user_id` against another
-- tenant's run is therefore counted forever and deleted by no foreign key, which
-- is what strands an erasure at "Mandatory account erasure work is incomplete".
-- 20260801120000 argued exactly this for `public.export_handoffs`; the explicit
-- delete is what makes it reachable, and this row is what proves the delete is
-- load-bearing rather than a duplicate of the cascade.
insert into private.mobile_guided_corrections (
  user_id, idempotency_key, run_id, expected_review_revision, intent
) values (
  'guided_597_owner',
  '59750000-0000-4000-8000-0000000000e4',
  '59720000-0000-4000-8000-000000000002',
  '59730000-0000-4000-8000-000000000002',
  '{"addedSpecs":["Anything"]}'::jsonb
);

select public.begin_account_erasure(
  'guided_597_owner', '59750000-0000-4000-8000-0000000000e2'
);
select extensions.throws_ok(
  $$insert into private.mobile_guided_corrections (
      user_id, idempotency_key, run_id, expected_review_revision, intent
    )
    values (
      'guided_597_owner',
      '59750000-0000-4000-8000-0000000000e3',
      '59720000-0000-4000-8000-000000000001',
      '59730000-0000-4000-8000-000000000001',
      '{"addedSpecs":["Anything"]}'::jsonb
    )$$,
  '55000',
  null,
  'a correction cannot be claimed into an account already being erased'
);

select public.advance_account_erasure(
  (select generation_id from private.account_erasure_generations
   where user_id = 'guided_597_owner')
);
select extensions.is(
  private.account_erasure_owned_row_count('guided_597_owner'),
  0,
  'counting corrections cannot leave an erasure with no way to reach zero'
);


select * from extensions.finish();
rollback;
