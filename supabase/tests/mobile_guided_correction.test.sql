begin;

create extension if not exists pgtap with schema extensions;

select extensions.plan(39);

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
  'content_sha256_set_v1',
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

insert into public.prediction_logs (
  id, user_id, item_id, run_id, extracted_attrs, price, price_range,
  confidence, tier_fired, model, listing_model, sources
) values (
  '59760000-0000-4000-8000-000000000001',
  'guided_597_owner',
  '59710000-0000-4000-8000-000000000001',
  '59720000-0000-4000-8000-000000000001',
  '{"brand":"Dell","model":"XPS 15","specs":["16GB RAM"]}'::jsonb,
  170,
  '{"low":150,"high":190}'::jsonb,
  0.75,
  'ebay-sold',
  'vision-model',
  'listing-model',
  '[]'::jsonb
);

insert into public.listings (
  id, user_id, item_id, platform, title, description, copy, status,
  run_id, source_review_revision
) values (
  '59770000-0000-4000-8000-000000000001',
  'guided_597_owner',
  '59710000-0000-4000-8000-000000000001',
  'ebay',
  'Dell XPS 15',
  'Dell XPS 15 in good used condition.',
  '{}'::jsonb,
  'draft',
  '59720000-0000-4000-8000-000000000001',
  '59730000-0000-4000-8000-000000000001'
);
update public.pipeline_runs
set listing_id = '59770000-0000-4000-8000-000000000001'
where id = '59720000-0000-4000-8000-000000000001';

insert into public.ai_item_allowance_periods (
  id, user_id, source, period_key, period_start, expires_date, state, allowance
) values (
  '59780000-0000-4000-8000-000000000001',
  'guided_597_owner',
  'included', 'included-first-run', '-infinity', 'infinity', 'active', 1
);

insert into public.ai_item_credit_reservations (
  id, user_id, pipeline_run_id, item_id, allowance_period_id,
  logical_run_key, photo_set_fingerprint, photo_identity_kind,
  photo_identity_fingerprint, state, settled_at,
  settled_review_revision, listing_id, prediction_log_id
) values (
  '59790000-0000-4000-8000-000000000001',
  'guided_597_owner',
  '59720000-0000-4000-8000-000000000001',
  '59710000-0000-4000-8000-000000000001',
  '59780000-0000-4000-8000-000000000001',
  'guided-597-run-1',
  encode(sha256(convert_to(
    array_to_json(array['guided_597_owner/items/photo-0.enc'])::text, 'UTF8'
  )), 'hex'),
  'content_sha256_set_v1',
  encode(sha256(convert_to(
    array_to_json(array['guided_597_owner/items/photo-0.enc'])::text, 'UTF8'
  )), 'hex'),
  'settled',
  statement_timestamp(),
  '59730000-0000-4000-8000-000000000001',
  '59770000-0000-4000-8000-000000000001',
  '59760000-0000-4000-8000-000000000001'
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
  array['text', 'uuid', 'uuid', 'uuid', 'jsonb'],
  'anon', array[]::text[],
  'an unauthenticated caller cannot claim a correction'
);
select extensions.function_privs_are(
  'public', 'claim_mobile_guided_correction',
  array['text', 'uuid', 'uuid', 'uuid', 'jsonb'],
  'authenticated', array['EXECUTE'],
  'a seller claims their own correction'
);
select extensions.table_privs_are(
  'private', 'mobile_guided_corrections', 'authenticated', array[]::text[],
  'the claim table is not reachable through the API'
);
select extensions.function_privs_are(
  'public', 'complete_mobile_guided_correction',
  array['text', 'uuid', 'jsonb', 'jsonb'],
  'authenticated', array[]::text[],
  'a seller cannot invoke the fixed privileged completion directly'
);
select extensions.function_privs_are(
  'public', 'complete_mobile_guided_correction',
  array['text', 'uuid', 'jsonb', 'jsonb'],
  'service_role', array['EXECUTE'],
  'only the fixed internal completion client may consume a correction capability'
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

select extensions.throws_ok(
  $$
    select public.claim_mobile_guided_correction(
      'complete',
      '59720000-0000-4000-8000-000000000001'::uuid,
      '59750000-0000-4000-8000-000000000001'::uuid,
      '59740000-0000-4000-8000-000000000002'::uuid,
      '{"addedSpecs":["Noise cancelling"]}'::jsonb
    )
  $$,
  '42501',
  'Guided correction authorization is required.',
  'an authenticated bearer cannot settle a replay receipt outside the atomic completion'
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
  'the refused forged completion leaves the real claim pending'
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
-- 3. One included correction, committed atomically with its replay receipt.
-- ---------------------------------------------------------------------------

select extensions.is(
  public.claim_mobile_guided_correction(
    'prepare',
    '59720000-0000-4000-8000-000000000001'::uuid,
    '59750000-0000-4000-8000-000000000010'::uuid,
    '59740000-0000-4000-8000-000000000002'::uuid,
    '{"addedSpecs":["1TB SSD"]}'::jsonb
  )->>'state',
  'proceed',
  'the mobile correction claim is acquired before allowance authorization'
);

select extensions.lives_ok(
  $$
    select public.authorize_ai_item_guided_correction(
      '59710000-0000-4000-8000-000000000001'::uuid,
      '59770000-0000-4000-8000-000000000001'::uuid,
      '59740000-0000-4000-8000-000000000010'::uuid,
      '59720000-0000-4000-8000-000000000001'::uuid,
      '59740000-0000-4000-8000-000000000002'::uuid,
      repeat('a', 43),
      statement_timestamp() + interval '4 minutes'
    )
  $$,
  'mobile correction uses the existing one-correction allowance boundary'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create function pg_temp.reject_mobile_correction_receipt()
returns trigger
language plpgsql
as $$
begin
  raise exception 'forced late receipt failure';
end;
$$;
create trigger zzzz_test_reject_mobile_correction_receipt
before update on private.mobile_guided_corrections
for each row
when (
  old.idempotency_key = '59750000-0000-4000-8000-000000000010'::uuid
)
execute function pg_temp.reject_mobile_correction_receipt();

select extensions.throws_ok(
  $$
    select public.complete_mobile_guided_correction(
      repeat('a', 43),
      '59750000-0000-4000-8000-000000000010'::uuid,
      '{
        "item_id":"59710000-0000-4000-8000-000000000001",
        "expected_review_revision":"59740000-0000-4000-8000-000000000002",
        "run_id":"59740000-0000-4000-8000-000000000010",
        "attributes":{"brand":"Sony","model":"WH-1000XM4","specs":["1TB SSD"]},
        "identification":{"label":"Sony WH-1000XM4","confident":true,"evidence":1},
        "prediction":{
          "extracted_attrs":{"brand":"Sony","model":"WH-1000XM4","specs":["1TB SSD"]},
          "price":180,"price_range":{"low":160,"high":200},"confidence":0.8,
          "tier_fired":"ebay-sold","model":"vision-model",
          "listing_model":"listing-model","pricing_model":null,"sources":[],
          "autopilot_enabled":false,"autopilot_eligible":false
        }
      }'::jsonb,
      '{
        "schemaVersion":1,"runId":"59740000-0000-4000-8000-000000000010",
        "itemId":"59710000-0000-4000-8000-000000000001",
        "reviewRevision":"59740000-0000-4000-8000-000000000010",
        "effectivePrice":180
      }'::jsonb
    )
  $$,
  'P0001',
  'forced late receipt failure',
  'a late receipt failure aborts the whole correction transaction'
);

select extensions.is(
  (select review_revision from public.items
   where id = '59710000-0000-4000-8000-000000000001'),
  '59740000-0000-4000-8000-000000000002'::uuid,
  'the failed atomic completion leaves the old review revision live'
);
select extensions.is(
  (select guided_correction_completed_at from public.ai_item_credit_reservations
   where id = '59790000-0000-4000-8000-000000000001'),
  null::timestamptz,
  'the failed atomic completion does not spend the included correction'
);
select extensions.is(
  (select state from private.mobile_guided_corrections
   where user_id = 'guided_597_owner'
     and idempotency_key = '59750000-0000-4000-8000-000000000010'),
  'pending',
  'the failed atomic completion leaves no false replay receipt'
);

drop trigger zzzz_test_reject_mobile_correction_receipt
  on private.mobile_guided_corrections;

select extensions.lives_ok(
  $$
    select public.complete_mobile_guided_correction(
      repeat('a', 43),
      '59750000-0000-4000-8000-000000000010'::uuid,
      '{
        "item_id":"59710000-0000-4000-8000-000000000001",
        "expected_review_revision":"59740000-0000-4000-8000-000000000002",
        "run_id":"59740000-0000-4000-8000-000000000010",
        "attributes":{"brand":"Sony","model":"WH-1000XM4","specs":["1TB SSD"]},
        "identification":{"label":"Sony WH-1000XM4","confident":true,"evidence":1},
        "prediction":{
          "extracted_attrs":{"brand":"Sony","model":"WH-1000XM4","specs":["1TB SSD"]},
          "price":180,"price_range":{"low":160,"high":200},"confidence":0.8,
          "tier_fired":"ebay-sold","model":"vision-model",
          "listing_model":"listing-model","pricing_model":null,"sources":[],
          "autopilot_enabled":false,"autopilot_eligible":false
        }
      }'::jsonb,
      '{
        "schemaVersion":1,"runId":"59740000-0000-4000-8000-000000000010",
        "itemId":"59710000-0000-4000-8000-000000000001",
        "reviewRevision":"59740000-0000-4000-8000-000000000010",
        "effectivePrice":180
      }'::jsonb
    )
  $$,
  'the same authorized operation succeeds after the failed transaction'
);

select extensions.is(
  (select review_revision from public.items
   where id = '59710000-0000-4000-8000-000000000001'),
  '59740000-0000-4000-8000-000000000010'::uuid,
  'successful completion advances the item in the receipt transaction'
);
select extensions.ok(
  (select guided_correction_completed_at is not null
   from public.ai_item_credit_reservations
   where id = '59790000-0000-4000-8000-000000000001'),
  'successful completion marks the one included correction consumed'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"guided_597_owner","role":"authenticated"}',
  true
);
select extensions.is(
  public.claim_mobile_guided_correction(
    'prepare',
    '59720000-0000-4000-8000-000000000001'::uuid,
    '59750000-0000-4000-8000-000000000010'::uuid,
    '59740000-0000-4000-8000-000000000002'::uuid,
    '{"addedSpecs":["1TB SSD"]}'::jsonb
  )->'receipt'->>'runId',
  '59740000-0000-4000-8000-000000000010',
  'an exact retry replays the receipt committed with the item'
);
select extensions.is(
  public.claim_mobile_guided_correction(
    'prepare',
    '59720000-0000-4000-8000-000000000001'::uuid,
    '59750000-0000-4000-8000-000000000011'::uuid,
    '59740000-0000-4000-8000-000000000010'::uuid,
    '{"addedSpecs":["2TB SSD"]}'::jsonb
  )->>'state',
  'proceed',
  'a refreshed fresh-key request reaches the shared allowance boundary'
);
select extensions.throws_ok(
  $$
    select public.authorize_ai_item_guided_correction(
      '59710000-0000-4000-8000-000000000001'::uuid,
      '59770000-0000-4000-8000-000000000001'::uuid,
      '59740000-0000-4000-8000-000000000011'::uuid,
      '59720000-0000-4000-8000-000000000001'::uuid,
      '59740000-0000-4000-8000-000000000010'::uuid,
      repeat('b', 43),
      statement_timestamp() + interval '4 minutes'
    )
  $$,
  'P0001',
  'The included guided correction is unavailable.',
  'a refreshed fresh-key request cannot spend pricing a second time'
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
