begin;

select plan(57);

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
  has_function_privilege(
    'service_role',
    'public.queue_guest_claim_copy_cleanup(uuid,text,text,uuid)',
    'execute'
  ),
  'service role may requeue only one exact guest claim-copy lease'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.queue_guest_claim_copy_cleanup(uuid,text,text,uuid)',
    'execute'
  ),
  'authenticated callers cannot mint claim-copy cleanup authority'
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
  id, user_id, photos, attributes, condition, identification,
  review_revision, review_content_revision
) values
  (
    '10000000-0000-4000-8000-000000000001',
    'guest_pgtap_claim',
    array['guest_pgtap_claim/items/front.enc'],
    '{"brand":"Fixture"}'::jsonb,
    'good',
    '{"kind":"fixture"}'::jsonb,
    '80000000-0000-4000-8000-000000000001',
    '80000000-0000-4000-8000-000000000001'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    'guest_pgtap_expire',
    array['guest_pgtap_expire/items/front.enc'],
    '{"brand":"Expiry"}'::jsonb,
    'good',
    '{"kind":"fixture"}'::jsonb,
    '80000000-0000-4000-8000-000000000002',
    '80000000-0000-4000-8000-000000000002'
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    'guest_pgtap_claim',
    array['guest_pgtap_claim/items/restored.enc'],
    '{}'::jsonb,
    null,
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
    statement_timestamp() - interval '23 hours',
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

-- Simulate the included #168 guided correction before the guest claims. The
-- settled reservation remains bound to the original pipeline prediction while
-- the editable draft is coherently paired to this current corrected evidence.
insert into public.prediction_logs (
  id, user_id, item_id, run_id, extracted_attrs, price, price_range,
  confidence, tier_fired, model, listing_model, sources
) values (
  '40000000-0000-4000-8000-000000000004',
  'guest_pgtap_claim',
  '10000000-0000-4000-8000-000000000001',
  '90000000-0000-4000-8000-000000000001',
  '{"brand":"Corrected Fixture"}'::jsonb,
  27,
  '{"low":22,"high":32}'::jsonb,
  0.9,
  'llm-only',
  'offline-corrected-model',
  'offline-corrected-listing',
  '[]'::jsonb
);
update public.items
set attributes = '{"brand":"Corrected Fixture"}'::jsonb,
    review_revision = '90000000-0000-4000-8000-000000000001',
    review_content_revision = '90000000-0000-4000-8000-000000000001'
where id = '10000000-0000-4000-8000-000000000001';
update public.listings
set run_id = '90000000-0000-4000-8000-000000000001',
    source_review_revision = '90000000-0000-4000-8000-000000000001'
where id = '30000000-0000-4000-8000-000000000001';
update public.ai_item_credit_reservations
set guided_correction_revision = '80000000-0000-4000-8000-000000000001',
    guided_correction_started_at = statement_timestamp(),
    guided_correction_completed_at = statement_timestamp(),
    updated_at = statement_timestamp()
where id = '60000000-0000-4000-8000-000000000001';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select throws_ok(
  $$
    select public.register_guest_draft_recovery(
      '70000000-0000-4000-8000-000000000001',
      'guest_pgtap_claim',
      '20000000-0000-4000-8000-000000000001',
      repeat('a', 64),
      '{"version":1,"algorithm":"aes-256-gcm","keyId":"fixture","keyEnvelope":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=","nonce":"AgICAgICAgICAgI=","tag":"AwMDAwMDAwMDAwMDAwMDAw==","ciphertext":"ZW5jcnlwdGVkLWRyYWZ0"}'::jsonb,
      jsonb_build_array(jsonb_build_object(
        'sourcePath', 'guest_pgtap_claim/items/front.enc',
        'sha256', repeat('b', 64),
        'byteLength', 128
      ))
    )
  $$,
  '22023',
  'Invalid encrypted guest recovery artifact',
  'an eleven-byte AES-GCM IV is rejected before registration'
);
select throws_ok(
  $$
    select public.register_guest_draft_recovery(
      '70000000-0000-4000-8000-000000000001',
      'guest_pgtap_claim',
      '20000000-0000-4000-8000-000000000001',
      repeat('a', 64),
      '{"version":1,"algorithm":"aes-256-gcm","keyId":"fixture","keyEnvelope":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=","nonce":"AgICAgICAgICAgIC","tag":"AwMDAwMDAwMDAwMDAwMDAw==","ciphertext":"ZW5jcnlwdGVkLWRyYWZ0"}'::jsonb,
      jsonb_build_array(jsonb_build_object(
        'sourcePath', 'guest_pgtap_claim/items/front.enc',
        'sha256', repeat('b', 64),
        'byteLength', 128
      ))
    )
  $$,
  '22023',
  'Invalid private Storage recovery manifest',
  'unlabeled Storage bytes cannot become recoverable ciphertext'
);
select throws_ok(
  $$
    select public.register_guest_draft_recovery(
      '70000000-0000-4000-8000-000000000001',
      'guest_pgtap_claim',
      '20000000-0000-4000-8000-000000000001',
      repeat('a', 64),
      '{"version":1,"algorithm":"aes-256-gcm","keyId":"fixture","keyEnvelope":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=","nonce":"AgICAgICAgICAgIC","tag":"AwMDAwMDAwMDAwMDAwMDAw==","ciphertext":"ZW5jcnlwdGVkLWRyYWZ0"}'::jsonb,
      jsonb_build_array(jsonb_build_object(
        'sourcePath', 'guestXpgtap_claim/items/front.enc',
        'sha256', repeat('b', 64),
        'byteLength', 128,
        'encryption', jsonb_build_object(
          'algorithm', 'aes-256-gcm',
          'keyId', 'fixture',
          'nonce', 'BAQEBAQEBAQEBAQE',
          'tag', 'BQUFBQUFBQUFBQUFBQUFBQ=='
        )
      ))
    )
  $$,
  '22023',
  'Invalid private Storage recovery manifest',
  'an underscore in the guest id is matched literally, never as LIKE wildcard'
);

insert into guest_claim_results values (
  'registered',
  public.register_guest_draft_recovery(
    '70000000-0000-4000-8000-000000000001',
    'guest_pgtap_claim',
    '20000000-0000-4000-8000-000000000001',
    repeat('a', 64),
    '{"version":1,"algorithm":"aes-256-gcm","keyId":"fixture","keyEnvelope":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=","nonce":"AgICAgICAgICAgIC","tag":"AwMDAwMDAwMDAwMDAwMDAw==","ciphertext":"ZW5jcnlwdGVkLWRyYWZ0"}'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'sourcePath', 'guest_pgtap_claim/items/front.enc',
      'sha256', repeat('b', 64),
      'byteLength', 128,
      'encryption', jsonb_build_object(
        'algorithm', 'aes-256-gcm',
        'keyId', 'fixture',
        'nonce', 'BAQEBAQEBAQEBAQE',
        'tag', 'BQUFBQUFBQUFBQUFBQUFBQ=='
      )
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
  'user_pgtap_claim/guest-claims/70000000-0000-4000-8000-000000000001/'
    || (
      select payload->>'claimLeaseToken'
      from guest_claim_results where label = 'begun'
    ) || '/1',
  'the destination is derived in the account namespace'
);

reset role;
update private.guest_draft_recoveries
set claim_lease_expires_at = statement_timestamp() - interval '1 second'
where id = '70000000-0000-4000-8000-000000000001';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into guest_claim_results values (
  'begun-retry',
  public.begin_guest_draft_claim(
    '70000000-0000-4000-8000-000000000001',
    'guest_pgtap_claim',
    repeat('a', 64),
    'user_pgtap_claim',
    300
  )
);
select isnt(
  (select payload #>> '{objects,0,destinationPath}' from guest_claim_results where label = 'begun'),
  (select payload #>> '{objects,0,destinationPath}' from guest_claim_results where label = 'begun-retry'),
  'a retry receives a lease-unique destination namespace'
);
select is(
  (
    select photo_paths[1]
    from private.pipeline_storage_cleanup_jobs
    where source_type = 'guest_claim_copy'
      and source_id = (
        select (payload->>'claimLeaseToken')::uuid
        from guest_claim_results where label = 'begun'
      )
  ),
  (select payload #>> '{objects,0,destinationPath}' from guest_claim_results where label = 'begun'),
  'the obsolete lease path has durable bounded cleanup intent before replacement'
);

-- Simulate a cleanup worker finishing before a stale process reports its late
-- write. The exact obsolete lease must be able to recreate durable cleanup.
reset role;
update private.pipeline_storage_cleanup_jobs
set state = 'running',
    attempt_count = 1,
    available_at = statement_timestamp(),
    lease_token = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    lease_expires_at = statement_timestamp() + interval '5 minutes'
where source_type = 'guest_claim_copy'
  and source_id = (
    select (payload->>'claimLeaseToken')::uuid
    from guest_claim_results where label = 'begun'
  );
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select ok(
  public.queue_guest_claim_copy_cleanup(
    '70000000-0000-4000-8000-000000000001',
    repeat('a', 64),
    'user_pgtap_claim',
    (
      select (payload->>'claimLeaseToken')::uuid
      from guest_claim_results where label = 'begun'
    )
  ),
  'a late writer durably marks an already-running cleanup for another sweep'
);
select ok(
  public.complete_pipeline_storage_cleanup(
    (
      select job_id from private.pipeline_storage_cleanup_jobs
      where source_type = 'guest_claim_copy'
        and source_id = (
          select (payload->>'claimLeaseToken')::uuid
          from guest_claim_results where label = 'begun'
        )
    ),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ),
  'running cleanup completion observes the durable late-writer marker'
);
select is(
  (
    select state || ':' || guest_copy_writer_quiesced::text || ':'
      || resweep_requested::text || ':' || guest_copy_final_sweep_armed::text
    from private.pipeline_storage_cleanup_jobs
    where source_type = 'guest_claim_copy'
      and source_id = (
        select (payload->>'claimLeaseToken')::uuid
        from guest_claim_results where label = 'begun'
      )
  ),
  'pending:true:false:true',
  'the late writer forces one more bounded cleanup sweep instead of losing intent'
);

reset role;
delete from private.pipeline_storage_cleanup_jobs
where source_type = 'guest_claim_copy'
  and source_id = (
    select (payload->>'claimLeaseToken')::uuid
    from guest_claim_results where label = 'begun'
  );
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into guest_claim_results values (
  'completed',
  public.complete_guest_draft_claim(
    '70000000-0000-4000-8000-000000000001',
    repeat('a', 64),
    'user_pgtap_claim',
    (
      select (payload->>'claimLeaseToken')::uuid
      from guest_claim_results where label = 'begun-retry'
    ),
    jsonb_build_array(jsonb_build_object(
      'destinationPath', (
        select payload #>> '{objects,0,destinationPath}'
        from guest_claim_results where label = 'begun-retry'
      ),
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
select ok(
  public.queue_guest_claim_copy_cleanup(
    '70000000-0000-4000-8000-000000000001',
    repeat('a', 64),
    'user_pgtap_claim',
    (
      select (payload->>'claimLeaseToken')::uuid
      from guest_claim_results where label = 'begun'
    )
  ),
  'a late stale writer durably requeues only its obsolete lease namespace'
);
select is(
  (
    select photo_paths[1]
    from private.pipeline_storage_cleanup_jobs
    where source_type = 'guest_claim_copy'
      and source_id = (
        select (payload->>'claimLeaseToken')::uuid
        from guest_claim_results where label = 'begun'
      )
  ),
  (select payload #>> '{objects,0,destinationPath}' from guest_claim_results where label = 'begun'),
  'requeued stale cleanup cannot target the successful retry lease'
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
  (select user_id from public.prediction_logs where id = '40000000-0000-4000-8000-000000000004'),
  'user_pgtap_claim',
  'the current guided-correction prediction transfers with its draft run'
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
select throws_ok(
  $$
    select public.begin_guest_draft_claim(
      '70000000-0000-4000-8000-000000000001',
      'guest_pgtap_claim',
      repeat('a', 64),
      'user_pgtap_other',
      300
    )
  $$,
  'P0002',
  'Guest recovery not found',
  'terminal claim start never discloses claimed ids to another account'
);
select throws_ok(
  $$
    select public.release_guest_draft_claim(
      '70000000-0000-4000-8000-000000000001',
      repeat('a', 64),
      'user_pgtap_other',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
  $$,
  'P0002',
  'Guest recovery not found',
  'terminal claim release never discloses claimed ids to another account'
);
select throws_ok(
  $$
    select public.complete_guest_draft_claim(
      '70000000-0000-4000-8000-000000000001',
      repeat('a', 64),
      'user_pgtap_other',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '[]'::jsonb
    )
  $$,
  'P0002',
  'Guest recovery not found',
  'terminal claim completion never discloses claimed ids to another account'
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
    '{"version":1,"algorithm":"aes-256-gcm","keyId":"fixture","keyEnvelope":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=","nonce":"AgICAgICAgICAgIC","tag":"AwMDAwMDAwMDAwMDAwMDAw==","ciphertext":"ZW5jcnlwdGVkLWRyYWZ0"}'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'sourcePath', 'guest_pgtap_expire/items/front.enc',
      'sha256', repeat('d', 64),
      'byteLength', 128,
      'encryption', jsonb_build_object(
        'algorithm', 'aes-256-gcm',
        'keyId', 'fixture',
        'nonce', 'BAQEBAQEBAQEBAQE',
        'tag', 'BQUFBQUFBQUFBQUFBQUFBQ=='
      )
    ))
  )
);
select is(
  (select payload->>'outcome' from guest_claim_results where label = 'expired-registration'),
  'recoverable',
  'the guest draft registers before its server-owned boundary'
);

reset role;
update private.guest_draft_recoveries
set usable_draft_at = statement_timestamp() - interval '24 hours',
    expires_at = statement_timestamp()
where id = '70000000-0000-4000-8000-000000000002';
update public.listings
set status = 'active',
    ebay_listing_id = 'provider-listing-175',
    ebay_status = 'published'
where id = '30000000-0000-4000-8000-000000000002';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select throws_ok(
  $$ select public.expire_guest_draft_recoveries(25) $$,
  '55000',
  'Guest expiry requires unclaimed draft evidence',
  'expiry fails closed when provider-success listing state wins first'
);
select is(
  (
    select cardinality(photos)
    from public.items
    where id = '10000000-0000-4000-8000-000000000002'
  ),
  1,
  'failed-closed expiry preserves successful listing photo references'
);
select is(
  (
    select count(*)::integer
    from public.listings
    where id = '30000000-0000-4000-8000-000000000002'
      and status = 'active'
      and ebay_listing_id = 'provider-listing-175'
  ),
  1,
  'failed-closed expiry preserves provider listing truth'
);

reset role;
update public.listings
set status = 'draft',
    ebay_listing_id = null,
    ebay_status = null
where id = '30000000-0000-4000-8000-000000000002';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (public.expire_guest_draft_recoveries(25)->>'expiredCount')::integer,
  1,
  'the exact server boundary expires after the unclaimed-draft predicate holds'
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

reset role;
insert into private.guest_draft_recoveries (
  id, guest_user_id, pipeline_run_id, item_id, draft_id, reservation_id,
  allowance_period_id, recovery_token_hash, encrypted_artifact,
  storage_manifest, storage_object_count, usable_draft_at, expires_at, state,
  claim_target_user_id, claim_lease_token, claim_lease_expires_at
) values (
  '70000000-0000-4000-8000-000000000004',
  'guest_pgtap_four',
  '20000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000004',
  '30000000-0000-4000-8000-000000000004',
  '60000000-0000-4000-8000-000000000004',
  '50000000-0000-4000-8000-000000000004',
  repeat('e', 64),
  '{"version":1,"algorithm":"aes-256-gcm","keyId":"fixture","keyEnvelope":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=","nonce":"AgICAgICAgICAgIC","tag":"AwMDAwMDAwMDAwMDAwMDAw==","ciphertext":"ZW5jcnlwdGVkLWRyYWZ0"}'::jsonb,
  jsonb_build_array(
    jsonb_build_object(
      'sourcePath', 'guest_pgtap_four/items/1.enc',
      'sha256', repeat('1', 64),
      'byteLength', 1,
      'encryption', jsonb_build_object(
        'algorithm', 'aes-256-gcm', 'keyId', 'fixture',
        'nonce', 'BAQEBAQEBAQEBAQE',
        'tag', 'DAwMDAwMDAwMDAwMDAwMDA=='
      )
    ),
    jsonb_build_object(
      'sourcePath', 'guest_pgtap_four/items/2.enc',
      'sha256', repeat('2', 64),
      'byteLength', 1,
      'encryption', jsonb_build_object(
        'algorithm', 'aes-256-gcm', 'keyId', 'fixture',
        'nonce', 'BQUFBQUFBQUFBQUF',
        'tag', 'DQ0NDQ0NDQ0NDQ0NDQ0NDQ=='
      )
    ),
    jsonb_build_object(
      'sourcePath', 'guest_pgtap_four/items/3.enc',
      'sha256', repeat('3', 64),
      'byteLength', 1,
      'encryption', jsonb_build_object(
        'algorithm', 'aes-256-gcm', 'keyId', 'fixture',
        'nonce', 'BgYGBgYGBgYGBgYG',
        'tag', 'Dg4ODg4ODg4ODg4ODg4ODg=='
      )
    ),
    jsonb_build_object(
      'sourcePath', 'guest_pgtap_four/items/4.enc',
      'sha256', repeat('4', 64),
      'byteLength', 1,
      'encryption', jsonb_build_object(
        'algorithm', 'aes-256-gcm', 'keyId', 'fixture',
        'nonce', 'BwcHBwcHBwcHBwcH',
        'tag', 'Dw8PDw8PDw8PDw8PDw8PDw=='
      )
    )
  ),
  4,
  statement_timestamp() - interval '24 hours',
  statement_timestamp(),
  'copying',
  'user_pgtap_four',
  '90000000-0000-4000-8000-000000000004',
  statement_timestamp() + interval '5 minutes'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select lives_ok(
  $$ select public.expire_guest_draft_recoveries(25) $$,
  'copying-state expiry accepts four source plus four destination paths'
);
select is(
  (select state from private.guest_draft_recoveries where id = '70000000-0000-4000-8000-000000000004'),
  'expired',
  'four-photo copying recovery reaches the stable expired outcome'
);
select is(
  (
    select cardinality(photo_paths)
    from private.pipeline_storage_cleanup_jobs
    where source_type = 'guest_recovery'
      and source_id = '70000000-0000-4000-8000-000000000004'
  ),
  4,
  'four guest source objects remain one bounded cleanup job'
);
select is(
  (
    select cardinality(photo_paths)
    from private.pipeline_storage_cleanup_jobs
    where source_type = 'guest_claim_copy'
      and source_id = '90000000-0000-4000-8000-000000000004'
  ),
  4,
  'four obsolete account copies remain a separate bounded cleanup job'
);

select * from finish();
rollback;
