-- Issue #504: the account-allowance preflight at `begin_guest_draft_claim`.
--
-- `begin` and `complete` are separated by an unbounded client upload, so the
-- authoritative allowance check cannot move out of `complete`. It is duplicated
-- as an unlocked advisory read at `begin` that must deny before the seller
-- copies a single object, and both sites must say whether the denial is
-- permanent (the account's included run is `settled`) or transient (a `reserved`
-- run is still in flight and may yet be `restored`).
--
-- This file is a separate transaction from guest_claim_or_expire.test.sql on
-- purpose: that contract is one long stateful narrative over shared rows, and
-- these cases need a recovery whose target account is chosen per call.

begin;

select plan(12);

-- Test-only visibility. Transaction rollback restores the production grants.
grant select on private.guest_draft_recoveries to service_role;
grant select on public.ai_item_credit_reservations,
  public.ai_item_allowance_periods to service_role;

create temporary table guest_claim_504_results (
  label text primary key,
  payload jsonb not null
) on commit drop;
grant select, insert on guest_claim_504_results to service_role;

-- ---------------------------------------------------------------------------
-- Guest side: one coherent usable draft that `complete` will accept as far as
-- its allowance check.
-- ---------------------------------------------------------------------------

insert into public.items (
  id, user_id, photos, attributes, condition, identification,
  review_revision, review_content_revision,
  photo_identity_kind, photo_identity_fingerprint
) values (
  '11110000-0000-4000-8000-000000000504',
  'guest_pgtap_504',
  array[
    'guest_pgtap_504/items/photo-0.enc',
    'guest_pgtap_504/items/photo-1.enc'
  ],
  '{"brand":"Preflight"}'::jsonb,
  'good',
  '{"kind":"fixture"}'::jsonb,
  '88880000-0000-4000-8000-000000000504',
  '88880000-0000-4000-8000-000000000504',
  'legacy_path_v0',
  encode(sha256(convert_to(
    array_to_json(array[
      'guest_pgtap_504/items/photo-0.enc',
      'guest_pgtap_504/items/photo-1.enc'
    ])::text,
    'UTF8'
  )), 'hex')
);

insert into public.pipeline_runs (
  id, user_id, item_id, status, stage, idempotency_key, completed_at
) values (
  '22220000-0000-4000-8000-000000000504',
  'guest_pgtap_504',
  '11110000-0000-4000-8000-000000000504',
  'succeeded',
  'completed',
  'guest-pgtap-504',
  statement_timestamp()
);

insert into public.prediction_logs (
  id, user_id, item_id, run_id, extracted_attrs, price, price_range,
  confidence, tier_fired, model, listing_model, sources
) values (
  '44440000-0000-4000-8000-000000000504',
  'guest_pgtap_504',
  '11110000-0000-4000-8000-000000000504',
  '22220000-0000-4000-8000-000000000504',
  '{"brand":"Preflight"}'::jsonb,
  25,
  '{"low":20,"high":30}'::jsonb,
  0.8,
  'llm-only',
  'offline-model',
  'offline-listing',
  '[]'::jsonb
);

insert into public.listings (
  id, user_id, item_id, platform, title, description, copy, status,
  run_id, source_review_revision
) values (
  '33330000-0000-4000-8000-000000000504',
  'guest_pgtap_504',
  '11110000-0000-4000-8000-000000000504',
  'ebay',
  'Preflight fixture',
  'Durable preflight fixture.',
  '{}'::jsonb,
  'draft',
  '22220000-0000-4000-8000-000000000504',
  '88880000-0000-4000-8000-000000000504'
);

update public.pipeline_runs
set listing_id = '33330000-0000-4000-8000-000000000504'
where id = '22220000-0000-4000-8000-000000000504';

-- ---------------------------------------------------------------------------
-- Target accounts. Each needs its own item and run because a reservation is
-- keyed to (pipeline_run_id, user_id, item_id).
-- ---------------------------------------------------------------------------

insert into public.items (id, user_id, photos, attributes, identification)
values
  (
    '11110000-0000-4000-8000-000000000511',
    'user_pgtap_504_settled',
    array['user_pgtap_504_settled/items/own.enc'],
    '{"brand":"Own"}'::jsonb,
    '{"kind":"fixture"}'::jsonb
  ),
  (
    '11110000-0000-4000-8000-000000000512',
    'user_pgtap_504_reserved',
    array['user_pgtap_504_reserved/items/own.enc'],
    '{"brand":"Own"}'::jsonb,
    '{"kind":"fixture"}'::jsonb
  ),
  (
    '11110000-0000-4000-8000-000000000513',
    'user_pgtap_504_clean',
    array['user_pgtap_504_clean/items/own.enc'],
    '{"brand":"Own"}'::jsonb,
    '{"kind":"fixture"}'::jsonb
  );

insert into public.pipeline_runs (
  id, user_id, item_id, status, stage, idempotency_key, completed_at,
  attempt_count, started_at, last_attempted_at, lease_token, lease_expires_at
) values
  (
    '22220000-0000-4000-8000-000000000511',
    'user_pgtap_504_settled',
    '11110000-0000-4000-8000-000000000511',
    'succeeded',
    'completed',
    'user-pgtap-504-settled',
    statement_timestamp(),
    1,
    statement_timestamp(),
    statement_timestamp(),
    null,
    null
  ),
  -- A reserved credit belongs to a run still in flight.
  (
    '22220000-0000-4000-8000-000000000512',
    'user_pgtap_504_reserved',
    '11110000-0000-4000-8000-000000000512',
    'running',
    'identifying',
    'user-pgtap-504-reserved',
    null,
    1,
    statement_timestamp(),
    statement_timestamp(),
    '99990000-0000-4000-8000-000000000512',
    statement_timestamp() + interval '5 minutes'
  ),
  (
    '22220000-0000-4000-8000-000000000513',
    'user_pgtap_504_clean',
    '11110000-0000-4000-8000-000000000513',
    'running',
    'identifying',
    'user-pgtap-504-clean',
    null,
    1,
    statement_timestamp(),
    statement_timestamp(),
    '99990000-0000-4000-8000-000000000513',
    statement_timestamp() + interval '5 minutes'
  );

insert into public.ai_item_allowance_periods (
  id, user_id, source, period_key, period_start, expires_date, state, allowance
) values
  (
    '55550000-0000-4000-8000-000000000504',
    'guest_pgtap_504',
    'included', 'included-first-run', '-infinity', 'infinity', 'active', 1
  ),
  (
    '55550000-0000-4000-8000-000000000511',
    'user_pgtap_504_settled',
    'included', 'included-first-run', '-infinity', 'infinity', 'active', 1
  ),
  (
    '55550000-0000-4000-8000-000000000512',
    'user_pgtap_504_reserved',
    'included', 'included-first-run', '-infinity', 'infinity', 'active', 1
  ),
  -- The clean account already owns the canonical container. An unoccupied
  -- period must not read as a spent one.
  (
    '55550000-0000-4000-8000-000000000513',
    'user_pgtap_504_clean',
    'included', 'included-first-run', '-infinity', 'infinity', 'active', 1
  );

-- The occupancy predicate reads only allowance_period_id and state, so the
-- target reservations carry synthetic terminal evidence ids.
insert into public.ai_item_credit_reservations (
  id, user_id, pipeline_run_id, item_id, allowance_period_id,
  logical_run_key, photo_set_fingerprint, state, settled_at,
  settled_review_revision, listing_id, prediction_log_id
) values
  (
    '66660000-0000-4000-8000-000000000504',
    'guest_pgtap_504',
    '22220000-0000-4000-8000-000000000504',
    '11110000-0000-4000-8000-000000000504',
    '55550000-0000-4000-8000-000000000504',
    'guest-pgtap-504',
    encode(sha256(convert_to(
      array_to_json(array[
        'guest_pgtap_504/items/photo-0.enc',
        'guest_pgtap_504/items/photo-1.enc'
      ])::text,
      'UTF8'
    )), 'hex'),
    'settled',
    statement_timestamp(),
    '88880000-0000-4000-8000-000000000504',
    '33330000-0000-4000-8000-000000000504',
    '44440000-0000-4000-8000-000000000504'
  ),
  (
    '66660000-0000-4000-8000-000000000511',
    'user_pgtap_504_settled',
    '22220000-0000-4000-8000-000000000511',
    '11110000-0000-4000-8000-000000000511',
    '55550000-0000-4000-8000-000000000511',
    'user-pgtap-504-settled',
    repeat('a', 64),
    'settled',
    statement_timestamp(),
    '88880000-0000-4000-8000-000000000511',
    '33330000-0000-4000-8000-000000000511',
    '44440000-0000-4000-8000-000000000511'
  );

insert into public.ai_item_credit_reservations (
  id, user_id, pipeline_run_id, item_id, allowance_period_id,
  logical_run_key, photo_set_fingerprint, state
) values (
  '66660000-0000-4000-8000-000000000512',
  'user_pgtap_504_reserved',
  '22220000-0000-4000-8000-000000000512',
  '11110000-0000-4000-8000-000000000512',
  '55550000-0000-4000-8000-000000000512',
  'user-pgtap-504-reserved',
  repeat('b', 64),
  'reserved'
);

insert into private.guest_draft_recoveries (
  id, guest_user_id, pipeline_run_id, item_id, draft_id, reservation_id,
  allowance_period_id, recovery_token_hash, encrypted_artifact,
  storage_manifest, storage_object_count, usable_draft_at, expires_at, state
) values (
  '77770000-0000-4000-8000-000000000504',
  'guest_pgtap_504',
  '22220000-0000-4000-8000-000000000504',
  '11110000-0000-4000-8000-000000000504',
  '33330000-0000-4000-8000-000000000504',
  '66660000-0000-4000-8000-000000000504',
  '55550000-0000-4000-8000-000000000504',
  repeat('5', 64),
  '{"version":1,"algorithm":"aes-256-gcm","keyId":"fixture","keyEnvelope":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=","nonce":"AgICAgICAgICAgIC","tag":"AwMDAwMDAwMDAwMDAwMDAw==","ciphertext":"ZW5jcnlwdGVkLWRyYWZ0"}'::jsonb,
  jsonb_build_array(
    jsonb_build_object(
      'sourcePath', 'guest_pgtap_504/items/photo-0.enc',
      'sha256', repeat('1', 64),
      'byteLength', 128,
      'encryption', jsonb_build_object(
        'algorithm', 'aes-256-gcm', 'keyId', 'fixture',
        'nonce', 'BAQEBAQEBAQEBAQE',
        'tag', 'DAwMDAwMDAwMDAwMDAwMDA=='
      )
    ),
    jsonb_build_object(
      'sourcePath', 'guest_pgtap_504/items/photo-1.enc',
      'sha256', repeat('2', 64),
      'byteLength', 256,
      'encryption', jsonb_build_object(
        'algorithm', 'aes-256-gcm', 'keyId', 'fixture',
        'nonce', 'BQUFBQUFBQUFBQUF',
        'tag', 'DQ0NDQ0NDQ0NDQ0NDQ0NDQ=='
      )
    )
  ),
  2,
  statement_timestamp(),
  statement_timestamp() + interval '24 hours',
  'claimable'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- The permanent denial. The account's included run is settled and never
-- returns, so the seller must learn that before a single byte moves.
-- ---------------------------------------------------------------------------

select throws_ok(
  $$
    select public.begin_guest_draft_claim(
      '77770000-0000-4000-8000-000000000504',
      'guest_pgtap_504',
      repeat('5', 64),
      'user_pgtap_504_settled',
      '11111111-1111-4111-8111-000000000511',
      300
    )
  $$,
  'SL001',
  'Account included credit is already spent on another run',
  'a spent account is denied at claim start, never handed a copy plan'
);

select is(
  (
    select state
      || ':' || coalesce(claim_idempotency_user_id, '-')
      || ':' || coalesce(claim_idempotency_key::text, '-')
      || ':' || coalesce(claim_target_user_id, '-')
      || ':' || coalesce(claim_lease_token::text, '-')
    from private.guest_draft_recoveries
    where id = '77770000-0000-4000-8000-000000000504'
  ),
  'claimable:-:-:-:-',
  'the permanent preflight denial binds no key, writes no state, mints no lease'
);

-- ---------------------------------------------------------------------------
-- The transient denial. A `reserved` run may still be restored, so this one
-- must not present as permanent.
-- ---------------------------------------------------------------------------

select throws_ok(
  $$
    select public.begin_guest_draft_claim(
      '77770000-0000-4000-8000-000000000504',
      'guest_pgtap_504',
      repeat('5', 64),
      'user_pgtap_504_reserved',
      '11111111-1111-4111-8111-000000000512',
      300
    )
  $$,
  'SL002',
  'Account included credit is reserved by a run in flight',
  'an in-flight account run is denied as transient, not as permanent'
);

select is(
  (
    select state
      || ':' || coalesce(claim_idempotency_user_id, '-')
      || ':' || coalesce(claim_target_user_id, '-')
    from private.guest_draft_recoveries
    where id = '77770000-0000-4000-8000-000000000504'
  ),
  'claimable:-:-',
  'the transient preflight denial also leaves the recovery row untouched'
);

-- ---------------------------------------------------------------------------
-- The allowed path. An account that owns an unoccupied included period still
-- receives its copy plan, and both denials above left the row claimable by it.
-- ---------------------------------------------------------------------------

insert into guest_claim_504_results values (
  'begun-clean',
  public.begin_guest_draft_claim(
    '77770000-0000-4000-8000-000000000504',
    'guest_pgtap_504',
    repeat('5', 64),
    'user_pgtap_504_clean',
    '11111111-1111-4111-8111-000000000513',
    300
  )
);

select is(
  (select payload->>'outcome' from guest_claim_504_results where label = 'begun-clean'),
  'copy_required',
  'an unoccupied included period is not a spent one and still starts the claim'
);

select is(
  (
    select claim_idempotency_user_id || ':' || state || ':' || claim_target_user_id
    from private.guest_draft_recoveries
    where id = '77770000-0000-4000-8000-000000000504'
  ),
  'user_pgtap_504_clean:copying:user_pgtap_504_clean',
  'the earlier denials never bound the recovery to the accounts they refused'
);

-- ---------------------------------------------------------------------------
-- The upload window. The preflight is advisory, so `complete` still owns the
-- authoritative check and must distinguish the same two truths.
-- ---------------------------------------------------------------------------

reset role;
insert into public.ai_item_credit_reservations (
  id, user_id, pipeline_run_id, item_id, allowance_period_id,
  logical_run_key, photo_set_fingerprint, state
) values (
  '66660000-0000-4000-8000-000000000523',
  'user_pgtap_504_clean',
  '22220000-0000-4000-8000-000000000513',
  '11110000-0000-4000-8000-000000000513',
  '55550000-0000-4000-8000-000000000513',
  'user-pgtap-504-clean',
  repeat('c', 64),
  'reserved'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select throws_ok(
  $$
    select public.complete_guest_draft_claim(
      '77770000-0000-4000-8000-000000000504',
      repeat('5', 64),
      'user_pgtap_504_clean',
      (
        select (payload->>'claimLeaseToken')::uuid
        from guest_claim_504_results where label = 'begun-clean'
      ),
      (
        select jsonb_agg(entry.value - 'sourcePath' order by entry.ordinality)
        from guest_claim_504_results result,
          lateral jsonb_array_elements(result.payload->'objects')
            with ordinality entry(value, ordinality)
        where result.label = 'begun-clean'
      )
    )
  $$,
  'SL002',
  'Account included credit is reserved by a run in flight',
  'the authoritative check reports an in-flight account run as transient'
);

reset role;
delete from public.ai_item_credit_reservations
where id = '66660000-0000-4000-8000-000000000523';
insert into public.ai_item_credit_reservations (
  id, user_id, pipeline_run_id, item_id, allowance_period_id,
  logical_run_key, photo_set_fingerprint, state, settled_at,
  settled_review_revision, listing_id, prediction_log_id
) values (
  '66660000-0000-4000-8000-000000000533',
  'user_pgtap_504_clean',
  '22220000-0000-4000-8000-000000000513',
  '11110000-0000-4000-8000-000000000513',
  '55550000-0000-4000-8000-000000000513',
  'user-pgtap-504-clean',
  repeat('c', 64),
  'settled',
  statement_timestamp(),
  '88880000-0000-4000-8000-000000000513',
  '33330000-0000-4000-8000-000000000513',
  '44440000-0000-4000-8000-000000000513'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select throws_ok(
  $$
    select public.complete_guest_draft_claim(
      '77770000-0000-4000-8000-000000000504',
      repeat('5', 64),
      'user_pgtap_504_clean',
      (
        select (payload->>'claimLeaseToken')::uuid
        from guest_claim_504_results where label = 'begun-clean'
      ),
      (
        select jsonb_agg(entry.value - 'sourcePath' order by entry.ordinality)
        from guest_claim_504_results result,
          lateral jsonb_array_elements(result.payload->'objects')
            with ordinality entry(value, ordinality)
        where result.label = 'begun-clean'
      )
    )
  $$,
  'SL001',
  'Account included credit is already spent on another run',
  'an account that spends its included run mid-upload is still rejected at completion'
);

select is(
  (
    select state || ':' || coalesce(claim_target_user_id, '-')
    from private.guest_draft_recoveries
    where id = '77770000-0000-4000-8000-000000000504'
  ),
  'copying:user_pgtap_504_clean',
  'a rejected completion leaves the lease exactly as the claim start left it'
);

-- ---------------------------------------------------------------------------
-- The idempotency-key paths keep their own error and keep winning the race
-- against the preflight, so a rebind is never reported as a spent allowance.
-- ---------------------------------------------------------------------------

select throws_ok(
  $$
    select public.begin_guest_draft_claim(
      '77770000-0000-4000-8000-000000000504',
      'guest_pgtap_504',
      repeat('5', 64),
      'user_pgtap_504_clean',
      '22222222-2222-4222-8222-000000000513',
      300
    )
  $$,
  '23505',
  'Guest claim Idempotency-Key is already bound',
  'a second logical mutation key still raises the unchanged bind conflict'
);

select throws_ok(
  $$
    select public.begin_guest_draft_claim(
      '77770000-0000-4000-8000-000000000504',
      'guest_pgtap_504',
      repeat('5', 64),
      'user_pgtap_504_other',
      '11111111-1111-4111-8111-000000000513',
      300
    )
  $$,
  'P0002',
  'Guest recovery not found',
  'the cross-account fence still answers before any allowance is read'
);

select throws_ok(
  $$
    select public.begin_guest_draft_claim(
      '77770000-0000-4000-8000-000000000504',
      'guest_pgtap_504',
      repeat('5', 64),
      'user_pgtap_504_clean',
      '11111111-1111-4111-8111-000000000513',
      300
    )
  $$,
  'SL001',
  'Account included credit is already spent on another run',
  'a same-key retry after the account spends its run is told the truth, not to wait'
);

select * from finish();
rollback;
