begin;

select plan(33);

select ok(
  to_regclass('private.guest_draft_recoveries') is not null,
  'private guest recovery state exists'
);
select ok(
  not has_table_privilege(
    'service_role', 'private.guest_draft_recoveries', 'select'
  ),
  'service role has no generic guest recovery table access'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.register_guest_draft_recovery(uuid,text,uuid,text,jsonb,jsonb)',
    'execute'
  ),
  'service role may register only through the fixed recovery seam'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.complete_guest_draft_claim(uuid,text,text,uuid,jsonb)',
    'execute'
  ),
  'authenticated callers cannot forge claim completion'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.expire_guest_draft_recoveries(integer)',
    'execute'
  ),
  'anonymous callers cannot run guest expiry'
);

-- Test-only visibility after the privilege assertions above; transaction rollback
-- restores the production-private tables.
grant select on private.guest_draft_recoveries to service_role;
grant select on private.pipeline_storage_cleanup_jobs to service_role;
grant select on public.items, public.pipeline_runs, public.listings,
  public.prediction_logs, public.ai_item_credit_reservations,
  public.ai_item_allowance_periods to service_role;

create temporary table guest_claim_results (
  label text primary key,
  payload jsonb not null
) on commit drop;
grant select, insert, update on guest_claim_results to service_role;

insert into public.items (
  id, user_id, photos, attributes, condition,
  review_revision, review_content_revision
) values
  (
    '10000000-0000-4000-8000-000000000001',
    'guest_pgtap_claim',
    array['guest_pgtap_claim/items/front.enc'],
    '{"brand":"Fixture"}'::jsonb,
    'good',
    '80000000-0000-4000-8000-000000000001',
    '80000000-0000-4000-8000-000000000001'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    'guest_pgtap_expire',
    array['guest_pgtap_expire/items/front.enc'],
    '{"brand":"Expiry"}'::jsonb,
    'good',
    '80000000-0000-4000-8000-000000000002',
    '80000000-0000-4000-8000-000000000002'
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    'guest_pgtap_claim',
    array['guest_pgtap_claim/items/restored.enc'],
    '{}'::jsonb,
    null,
    '80000000-0000-4000-8000-000000000003',
    '80000000-0000-4000-8000-000000000003'
  );

insert into public.pipeline_runs (
  id, user_id, item_id, status, stage, idempotency_key, completed_at,
  failure_code, safe_failure_message
) values
  (
    '20000000-0000-4000-8000-000000000001',
    'guest_pgtap_claim',
    '10000000-0000-4000-8000-000000000001',
    'succeeded',
    'completed',
    'guest-pgtap-claim',
    statement_timestamp(),
    null,
    null
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    'guest_pgtap_expire',
    '10000000-0000-4000-8000-000000000002',
    'succeeded',
    'completed',
    'guest-pgtap-expire',
    statement_timestamp() - interval '24 hours',
    null,
    null
  ),
  (
    '20000000-0000-4000-8000-000000000003',
    'guest_pgtap_claim',
    '10000000-0000-4000-8000-000000000003',
    'failed',
    'identifying',
    'guest-pgtap-restored',
    statement_timestamp(),
    'fixture_failure',
    'Fixture failed safely.'
  );

insert into public.prediction_logs (
  id, user_id, item_id, run_id, extracted_attrs, price, price_range,
  confidence, tier_fired, model, listing_model, sources
) values
  (
    '40000000-0000-4000-8000-000000000001',
    'guest_pgtap_claim',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '{"brand":"Fixture"}'::jsonb,
    25,
    '{"low":20,"high":30}'::jsonb,
    0.8,
    'llm-only',
    'offline-model',
    'offline-listing',
    '[]'::jsonb
  ),
  (
    '40000000-0000-4000-8000-000000000002',
    'guest_pgtap_expire',
    '10000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    '{"brand":"Expiry"}'::jsonb,
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
) values
  (
    '30000000-0000-4000-8000-000000000001',
    'guest_pgtap_claim',
    '10000000-0000-4000-8000-000000000001',
    'ebay',
    'Claim fixture',
    'Durable claim fixture.',
    '{}'::jsonb,
    'draft',
    '20000000-0000-4000-8000-000000000001',
    '80000000-0000-4000-8000-000000000001'
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    'guest_pgtap_expire',
    '10000000-0000-4000-8000-000000000002',
    'ebay',
    'Expiry fixture',
    'Durable expiry fixture.',
    '{}'::jsonb,
    'draft',
    '20000000-0000-4000-8000-000000000002',
    '80000000-0000-4000-8000-000000000002'
  );

update public.pipeline_runs
set listing_id = case id
  when '20000000-0000-4000-8000-000000000001'::uuid
    then '30000000-0000-4000-8000-000000000001'::uuid
  else '30000000-0000-4000-8000-000000000002'::uuid
end
where id in (
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002'
);

insert into public.ai_item_allowance_periods (
  id, user_id, source, period_key, period_start, expires_date,
  state, allowance
) values
  (
    '50000000-0000-4000-8000-000000000001',
    'guest_pgtap_claim',
    'included',
    'included-first-run',
    '-infinity',
    'infinity',
    'active',
    1
  ),
  (
    '50000000-0000-4000-8000-000000000002',
    'guest_pgtap_expire',
    'included',
    'included-first-run',
    '-infinity',
    'infinity',
    'active',
    1
  );

insert into public.ai_item_credit_reservations (
  id, user_id, pipeline_run_id, item_id, allowance_period_id,
  logical_run_key, photo_set_fingerprint, state, settled_at,
  restored_at, settled_review_revision, listing_id, prediction_log_id
) values
  (
    '60000000-0000-4000-8000-000000000001',
    'guest_pgtap_claim',
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
    'guest-pgtap-claim',
    encode(sha256(convert_to(
      array_to_json(array['guest_pgtap_claim/items/front.enc'])::text,
      'UTF8'
    )), 'hex'),
    'settled',
    statement_timestamp(),
    null,
    '80000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001'
  ),
  (
    '60000000-0000-4000-8000-000000000002',
    'guest_pgtap_expire',
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    '50000000-0000-4000-8000-000000000002',
    'guest-pgtap-expire',
    encode(sha256(convert_to(
      array_to_json(array['guest_pgtap_expire/items/front.enc'])::text,
      'UTF8'
    )), 'hex'),
    'settled',
    statement_timestamp(),
    null,
    '80000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000002',
    '40000000-0000-4000-8000-000000000002'
  ),
  (
    '60000000-0000-4000-8000-000000000003',
    'guest_pgtap_claim',
    '20000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000003',
    '50000000-0000-4000-8000-000000000001',
    'guest-pgtap-restored',
    encode(sha256(convert_to(
      array_to_json(array['guest_pgtap_claim/items/restored.enc'])::text,
      'UTF8'
    )), 'hex'),
    'restored',
    null,
    statement_timestamp(),
    null,
    null,
    null
  );

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into guest_claim_results values (
  'registered',
  public.register_guest_draft_recovery(
    '70000000-0000-4000-8000-000000000001',
    'guest_pgtap_claim',
    '20000000-0000-4000-8000-000000000001',
    repeat('a', 64),
    '{"version":1,"algorithm":"aes-256-gcm","keyId":"fixture","keyEnvelope":"ZW52","nonce":"bm9uY2U=","tag":"dGFn","ciphertext":"Y2lwaGVy"}'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'sourcePath', 'guest_pgtap_claim/items/front.enc',
      'sha256', repeat('b', 64),
      'byteLength', 128
    ))
  )
);

select is(
  (select payload->>'outcome' from guest_claim_results where label = 'registered'),
  'recoverable',
  'durable registration returns the recoverable result'
);
select is(
  (
    select expires_at - usable_draft_at
    from private.guest_draft_recoveries
    where id = '70000000-0000-4000-8000-000000000001'
  ),
  interval '24 hours',
  'the server fixes exactly twenty-four hours'
);
select is(
  (
    select usable_draft_at
    from private.guest_draft_recoveries
    where id = '70000000-0000-4000-8000-000000000001'
  ),
  (
    select completed_at
    from public.pipeline_runs
    where id = '20000000-0000-4000-8000-000000000001'
  ),
  'usable time is the durable run completion time'
);
select is(
  public.recover_guest_draft(
    '70000000-0000-4000-8000-000000000001',
    'guest_pgtap_claim',
    repeat('a', 64)
  )->>'outcome',
  'recoverable',
  'the same encrypted draft replays without another run'
);
select is(
  (
    select count(*)::integer from public.ai_item_credit_reservations
    where pipeline_run_id = '20000000-0000-4000-8000-000000000001'
  ),
  1,
  'recovery replay creates no reservation'
);

insert into guest_claim_results values (
  'begun',
  public.begin_guest_draft_claim(
    '70000000-0000-4000-8000-000000000001',
    'guest_pgtap_claim',
    repeat('a', 64),
    'user_pgtap_claim',
    300
  )
);
select is(
  (select payload->>'outcome' from guest_claim_results where label = 'begun'),
  'copy_required',
  'claim starts with a private Storage copy plan'
);
select is(
  (
    select payload #>> '{objects,0,destinationPath}'
    from guest_claim_results where label = 'begun'
  ),
  'user_pgtap_claim/guest-claims/70000000-0000-4000-8000-000000000001/1',
  'the destination is derived in the account namespace'
);

insert into guest_claim_results values (
  'completed',
  public.complete_guest_draft_claim(
    '70000000-0000-4000-8000-000000000001',
    repeat('a', 64),
    'user_pgtap_claim',
    (
      select (payload->>'claimLeaseToken')::uuid
      from guest_claim_results where label = 'begun'
    ),
    jsonb_build_array(jsonb_build_object(
      'destinationPath', 'user_pgtap_claim/guest-claims/70000000-0000-4000-8000-000000000001/1',
      'sha256', repeat('b', 64),
      'byteLength', 128
    ))
  )
);
set constraints all immediate;

select is(
  (select payload->>'outcome' from guest_claim_results where label = 'completed'),
  'claimed',
  'verified Storage completes one authoritative claim'
);
select is(
  (select user_id from public.items where id = '10000000-0000-4000-8000-000000000001'),
  'user_pgtap_claim',
  'item ownership transfers atomically'
);
select is(
  (select user_id from public.pipeline_runs where id = '20000000-0000-4000-8000-000000000001'),
  'user_pgtap_claim',
  'run ownership transfers atomically'
);
select is(
  (select user_id from public.listings where id = '30000000-0000-4000-8000-000000000001'),
  'user_pgtap_claim',
  'draft ownership transfers atomically'
);
select is(
  (select user_id from public.prediction_logs where id = '40000000-0000-4000-8000-000000000001'),
  'user_pgtap_claim',
  'provider prediction evidence transfers with the draft'
);
select is(
  (select user_id from public.ai_item_credit_reservations where id = '60000000-0000-4000-8000-000000000001'),
  'user_pgtap_claim',
  'the exact reservation id remaps to the account'
);
select is(
  (select state from public.ai_item_credit_reservations where id = '60000000-0000-4000-8000-000000000001'),
  'settled',
  'claim neither settles nor restores the already-settled reservation'
);
select is(
  (
    select user_id || ':' || state || ':' || allowance_period_id::text
    from public.ai_item_credit_reservations
    where id = '60000000-0000-4000-8000-000000000003'
  ),
  'guest_pgtap_claim:restored:50000000-0000-4000-8000-000000000001',
  'restored guest accounting history stays bound to its original tenant period'
);
select is(
  (
    select period.user_id
    from public.ai_item_credit_reservations reservation
    join public.ai_item_allowance_periods period
      on period.id = reservation.allowance_period_id
     and period.user_id = reservation.user_id
    where reservation.id = '60000000-0000-4000-8000-000000000001'
  ),
  'user_pgtap_claim',
  'the exact settled reservation consumes the account included period'
);
select is(
  (
    select count(*)::integer from public.ai_item_credit_reservations
    where pipeline_run_id = '20000000-0000-4000-8000-000000000001'
  ),
  1,
  'claim creates no duplicate reservation'
);
select is(
  (
    select photo_paths[1]
    from private.pipeline_storage_cleanup_jobs
    where source_type = 'guest_recovery'
      and source_id = '70000000-0000-4000-8000-000000000001'
  ),
  'guest_pgtap_claim/items/front.enc',
  'only the guest source path enters bounded cleanup'
);
select is(
  public.resolve_guest_recovery_outcome(
    '70000000-0000-4000-8000-000000000001',
    repeat('a', 64),
    'user_pgtap_claim'
  )->>'outcome',
  'claimed',
  'claim retry returns the stable terminal outcome'
);
select throws_ok(
  $$
    select public.resolve_guest_recovery_outcome(
      '70000000-0000-4000-8000-000000000001',
      repeat('a', 64),
      'user_pgtap_other'
    )
  $$,
  'P0002',
  'Guest recovery not found',
  'a claimed outcome is fenced to its authenticated account target'
);
select is(
  public.recover_guest_draft(
    '70000000-0000-4000-8000-000000000001',
    'guest_pgtap_claim',
    repeat('a', 64)
  )->>'purgeLocalRecovery',
  'true',
  'stale guest devices are told to purge local encrypted recovery'
);

insert into guest_claim_results values (
  'expired-registration',
  public.register_guest_draft_recovery(
    '70000000-0000-4000-8000-000000000002',
    'guest_pgtap_expire',
    '20000000-0000-4000-8000-000000000002',
    repeat('c', 64),
    '{"version":1,"algorithm":"aes-256-gcm","keyId":"fixture","keyEnvelope":"ZW52","nonce":"bm9uY2U=","tag":"dGFn","ciphertext":"Y2lwaGVy"}'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'sourcePath', 'guest_pgtap_expire/items/front.enc',
      'sha256', repeat('d', 64),
      'byteLength', 128
    ))
  )
);
select is(
  (select payload->>'outcome' from guest_claim_results where label = 'expired-registration'),
  'expired',
  'the exact boundary expires instead of opening a claim window'
);
select is(
  (
    select cardinality(photos)
    from public.items
    where id = '10000000-0000-4000-8000-000000000002'
  ),
  0,
  'expiry scrubs guest item photo references'
);
select is(
  (
    select count(*)::integer
    from public.listings
    where id = '30000000-0000-4000-8000-000000000002'
  ),
  0,
  'expiry deletes the unclaimed draft artifact'
);
select is(
  (
    select count(*)::integer
    from public.prediction_logs
    where id = '40000000-0000-4000-8000-000000000002'
  ),
  1,
  'expiry preserves required provider prediction evidence'
);
select is(
  (
    select count(*)::integer
    from public.ai_item_credit_reservations
    where id = '60000000-0000-4000-8000-000000000002'
      and state = 'settled'
  ),
  1,
  'expiry preserves exact settled accounting evidence'
);
select is(
  (
    select count(*)::integer
    from private.pipeline_storage_cleanup_jobs
    where source_type = 'guest_recovery'
      and source_id = '70000000-0000-4000-8000-000000000002'
  ),
  1,
  'expiry queues one idempotent Storage cleanup job'
);
select is(
  (public.expire_guest_draft_recoveries(25)->>'expiredCount')::integer,
  0,
  'repeated bounded cleanup does not expire terminal state twice'
);

select * from finish();
rollback;
