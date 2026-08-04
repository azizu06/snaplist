begin;

select plan(60);

select has_column(
  'private', 'mobile_item_submissions', 'recovery_id',
  'submission replay truth stores the client recovery id'
);
select has_column(
  'private', 'mobile_item_submissions', 'recovery_token_hash',
  'submission replay truth stores only the recovery token hash'
);
select has_column(
  'public', 'pipeline_runs', 'recovery_id',
  'the owned pipeline run carries its recovery id'
);
select has_column(
  'public', 'pipeline_runs', 'recovery_token_hash',
  'the owned pipeline run carries only the recovery token hash'
);
select hasnt_column(
  'private', 'mobile_item_submissions', 'recovery_token',
  'the raw recovery token cannot land in submission rows'
);
select hasnt_column(
  'public', 'pipeline_runs', 'recovery_token',
  'the raw recovery token cannot land in pipeline rows'
);

select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'private.mobile_item_submissions'::regclass
      and conname = 'mobile_item_submissions_recovery_identity_check'
  ),
  'submission identity is an all-or-nothing UUID and SHA-256 pair'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.pipeline_runs'::regclass
      and conname = 'pipeline_runs_recovery_identity_check'
  ),
  'run identity is an all-or-nothing UUID and SHA-256 pair'
);

select has_function(
  'public', 'find_mobile_item_submission_v3',
  array['text', 'uuid', 'text', 'text', 'uuid', 'text'],
  'Clerk replay lookup has an explicit null guest identity seam'
);
select has_function(
  'public', 'find_mobile_item_submission_v3',
  array['uuid', 'text', 'text', 'uuid', 'text'],
  'verified guest replay lookup binds the client recovery identity'
);
select has_function(
  'public', 'begin_mobile_item_submission_v3',
  array['text', 'uuid', 'text', 'text', 'uuid', 'uuid', 'numeric', 'jsonb', 'jsonb', 'uuid', 'text'],
  'Clerk pre-upload binding explicitly rejects guest identity'
);
select has_function(
  'public', 'begin_mobile_item_submission_v3',
  array['uuid', 'text', 'text', 'uuid', 'uuid', 'numeric', 'jsonb', 'jsonb', 'uuid', 'text'],
  'verified guest pre-upload binding stores recovery identity'
);
select has_function(
  'public', 'commit_mobile_item_submission_v3',
  array['text', 'uuid', 'text', 'text', 'uuid', 'uuid', 'numeric', 'integer', 'integer', 'jsonb', 'jsonb', 'jsonb', 'uuid', 'text'],
  'Clerk atomic commit has no guest authority'
);
select has_function(
  'public', 'commit_mobile_item_submission_v3',
  array['uuid', 'text', 'text', 'uuid', 'uuid', 'numeric', 'integer', 'integer', 'jsonb', 'jsonb', 'jsonb', 'uuid', 'text'],
  'verified guest atomic commit copies recovery identity to the run'
);
select has_trigger(
  'public', 'pipeline_runs', 'pipeline_runs_protect_recovery_identity',
  'run recovery identity cannot be overwritten through tenant RLS updates'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.begin_mobile_item_submission_v3(text,uuid,text,text,uuid,uuid,numeric,jsonb,jsonb,uuid,text)',
    'execute'
  ),
  'the fixed Clerk producer may use v3'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.begin_mobile_item_submission_v3(uuid,text,text,uuid,uuid,numeric,jsonb,jsonb,uuid,text)',
    'execute'
  ),
  'a verified guest may use only the self-derived v3 overload'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.begin_mobile_item_submission_v2(text,uuid,text,text,uuid,uuid,numeric,jsonb,jsonb)',
    'execute'
  ),
  'service producers cannot bypass the explicit v3 identity decision'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.begin_mobile_item_submission_v2(uuid,text,text,uuid,uuid,numeric,jsonb,jsonb)',
    'execute'
  ),
  'verified guests cannot bypass required recovery identity through v2'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.find_mobile_item_submission(uuid,text)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.begin_mobile_item_submission(uuid,text,uuid,uuid,numeric,jsonb)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.commit_mobile_item_submission(uuid,text,uuid,uuid,numeric,integer,integer,jsonb,jsonb)',
    'execute'
  ),
  'verified guests cannot enqueue through any unversioned producer overload'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.find_mobile_item_submission(text,uuid,text)',
    'execute'
  )
  and not has_function_privilege(
    'service_role',
    'public.begin_mobile_item_submission(text,uuid,text,uuid,uuid,numeric,jsonb)',
    'execute'
  )
  and not has_function_privilege(
    'service_role',
    'public.commit_mobile_item_submission(text,uuid,text,uuid,uuid,numeric,integer,integer,jsonb,jsonb)',
    'execute'
  ),
  'legacy fixed-user producers cannot enqueue without an explicit v3 identity decision'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.find_mobile_item_submission_v2(uuid,text,text)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.commit_mobile_item_submission_v2(uuid,text,text,uuid,uuid,numeric,integer,integer,jsonb,jsonb,jsonb)',
    'execute'
  ),
  'verified guests cannot use the remaining v2 lookup or commit overloads'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.find_mobile_item_submission_v2(text,uuid,text,text)',
    'execute'
  )
  and not has_function_privilege(
    'service_role',
    'public.commit_mobile_item_submission_v2(text,uuid,text,text,uuid,uuid,numeric,integer,integer,jsonb,jsonb,jsonb)',
    'execute'
  ),
  'legacy fixed-user producers cannot use the remaining v2 lookup or commit overloads'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.stage_guest_recovery_upload_cleanup(uuid,uuid,text[])',
    'execute'
  ),
  'the worker may establish bounded cleanup before encrypted upload'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.stage_guest_recovery_upload_cleanup(uuid,uuid,text[])',
    'execute'
  ),
  'seller tokens cannot stage arbitrary Storage cleanup'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.complete_pipeline_run_with_guest_recovery(uuid,uuid,jsonb,jsonb)',
    'execute'
  ),
  'the worker has one atomic completion and registration capability'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.complete_pipeline_run(uuid,uuid,jsonb)',
    'execute'
  ),
  'the worker cannot mark a guest run complete without registration'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.complete_pipeline_run_with_guest_recovery(uuid,uuid,jsonb,jsonb)',
    'execute'
  ),
  'seller tokens cannot invoke worker completion'
);
select ok(
  not has_table_privilege(
    'service_role', 'private.mobile_item_submissions', 'select'
  ),
  'the service role has no generic recovery submission-ledger read'
);
select ok(
  not has_table_privilege(
    'authenticated', 'private.mobile_item_submissions', 'update'
  ),
  'seller tokens cannot overwrite private recovery submission truth'
);

insert into public.items (
  id, user_id, photos
) values (
  '63820000-0000-4000-8000-000000000010',
  'user_guest_recovery_pgtap',
  array['user_guest_recovery_pgtap/raw/front.jpg']
);
insert into public.pipeline_runs (
  id, user_id, item_id, idempotency_key
) values (
  '63820000-0000-4000-8000-000000000011',
  'user_guest_recovery_pgtap',
  '63820000-0000-4000-8000-000000000010',
  'guest-recovery-pgtap-run'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_guest_recovery_pgtap"}',
  true
);
select throws_ok(
  $$
    update public.pipeline_runs
    set recovery_id = '63820000-0000-4000-8000-000000000012',
        recovery_token_hash = repeat('d', 64)
    where id = '63820000-0000-4000-8000-000000000011'
  $$,
  '42501',
  'permission denied for table pipeline_runs',
  'an authenticated owner has no generic RLS update that could manufacture recovery authority'
);

reset role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"guest-recovery-producer-test"}',
  true
);
select lives_ok(
  $$
    update public.pipeline_runs
    set recovery_id = '63820000-0000-4000-8000-000000000012',
        recovery_token_hash = repeat('d', 64)
    where id = '63820000-0000-4000-8000-000000000011'
  $$,
  'the fixed definer seam may establish recovery identity once'
);
select throws_ok(
  $$
    update public.pipeline_runs
    set recovery_id = '63820000-0000-4000-8000-000000000013',
        recovery_token_hash = repeat('e', 64)
    where id = '63820000-0000-4000-8000-000000000011'
  $$,
  '42501',
  'Pipeline run guest recovery identity is immutable',
  'even the fixed definer seam cannot overwrite established recovery authority'
);

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"guest-recovery-producer-test"}',
  true
);
select throws_ok(
  $$
    select * from public.find_mobile_item_submission_v3(
      'user_authenticated_638',
      '63820000-0000-4000-8000-000000000001'::uuid,
      repeat('a', 64),
      null,
      '63820000-0000-4000-8000-000000000002'::uuid,
      repeat('b', 64)
    )
  $$,
  '22023',
  'Authenticated submissions cannot carry guest recovery identity',
  'the authenticated producer rejects guest authority before replay lookup'
);

select ok(
  position(
    'public.register_guest_draft_recovery'
    in pg_get_functiondef(
      'public.complete_pipeline_run_with_guest_recovery(uuid,uuid,jsonb,jsonb)'::regprocedure
    )
  ) > 0,
  'atomic completion calls the existing recovery registration capability'
);

insert into public.items (
  id, user_id, photos, photo_identity_kind, photo_identity_fingerprint
) values (
  '63825000-0000-4000-8000-000000000010',
  'guest_111111111111111111111111111111111111111111111111',
  array['guest_111111111111111111111111111111111111111111111111/raw/front.jpg'],
  'content_sha256_set_v1',
  repeat('1', 64)
);
insert into public.pipeline_runs (
  id, user_id, item_id, idempotency_key, queue_message_id
) values (
  '63825000-0000-4000-8000-000000000011',
  'guest_111111111111111111111111111111111111111111111111',
  '63825000-0000-4000-8000-000000000010',
  'legacy-guest-without-recovery-authority',
  63825
);
create temporary table legacy_guest_acquisition on commit drop as
select (
  public.claim_pipeline_run_attempt(
    '63825000-0000-4000-8000-000000000011',
    63825,
    300
  )->'context'->'run'->>'lease_token'
)::uuid as lease_token;
select throws_ok(
  $$
    select public.complete_pipeline_run_with_guest_recovery(
      '63825000-0000-4000-8000-000000000011',
      (select lease_token from legacy_guest_acquisition),
      '{}'::jsonb,
      null
    )
  $$,
  '23514',
  'Legacy guest pipeline run has no recovery authority',
  'a pre-migration guest run fails closed instead of becoming unrecoverable'
);
select isnt(
  (select status from public.pipeline_runs
   where id = '63825000-0000-4000-8000-000000000011'),
  'succeeded',
  'a legacy guest run without client authority never reaches durable value'
);

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"guest-recovery-producer-test"}',
  true
);
select public.issue_verified_guest_capability(
  '63830000-0000-4000-8000-000000000001',
  'guest_21d440432c7055a7284db05990333cd2c7d76a8a185db3ef',
  decode(repeat('63', 32), 'hex'),
  statement_timestamp(),
  statement_timestamp() + interval '15 minutes'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","actor":"verified_guest","sub":"guest_21d440432c7055a7284db05990333cd2c7d76a8a185db3ef","cap_id":"63830000-0000-4000-8000-000000000001","snaplist_operation_channel":"verified_guest_publishable"}',
  true
);
select lives_ok(
  $$
    select public.begin_mobile_item_submission_v3(
      '63830000-0000-4000-8000-000000000010'::uuid,
      repeat('a', 64),
      null,
      '63830000-0000-4000-8000-000000000010'::uuid,
      '63830000-0000-4000-8000-000000000011'::uuid,
      0,
      jsonb_build_array(jsonb_build_object(
        'ordinal', 0,
        'storage_path', 'guest_21d440432c7055a7284db05990333cd2c7d76a8a185db3ef/pipeline-staging/63830000-0000-4000-8000-000000000010/0/front.jpg',
        'content_sha256', repeat('b', 64),
        'byte_length', 3,
        'media_type', 'image/jpeg'
      )),
      null,
      '63830000-0000-4000-8000-000000000013'::uuid,
      repeat('d', 64)
    )
  $$,
  'verified guest submission begins with client recovery authority'
);

create temporary table guest_submission_receipt on commit drop as
select committed.*
from public.commit_mobile_item_submission_v3(
  '63830000-0000-4000-8000-000000000010'::uuid,
  repeat('a', 64),
  null,
  '63830000-0000-4000-8000-000000000010'::uuid,
  '63830000-0000-4000-8000-000000000011'::uuid,
  0,
  100,
  100,
  jsonb_build_object(
    'kind', 'content_sha256_set_v1',
    'fingerprint', encode(
      extensions.digest(pg_catalog.convert_to(repeat('b', 64), 'UTF8'), 'sha256'),
      'hex'
    )
  ),
  jsonb_build_array(jsonb_build_object(
    'ordinal', 0,
    'storage_path', 'guest_21d440432c7055a7284db05990333cd2c7d76a8a185db3ef/pipeline-staging/63830000-0000-4000-8000-000000000010/0/front.jpg',
    'content_sha256', repeat('b', 64),
    'byte_length', 3,
    'media_type', 'image/jpeg'
  )),
  null,
  '63830000-0000-4000-8000-000000000013'::uuid,
  repeat('d', 64)
) committed;

reset role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"guest-recovery-producer-test"}',
  true
);
select is(
  (select count(*)::integer from guest_submission_receipt
   where denial_reason is null),
  1,
  'guest v3 commit creates one durable run'
);
select is(
  (select concat(run.recovery_id, ':', run.recovery_token_hash)
   from public.pipeline_runs run
   join guest_submission_receipt receipt on receipt.run_id = run.id),
  '63830000-0000-4000-8000-000000000013:' || repeat('d', 64),
  'guest v3 commit copies the exact recovery identity onto the stored run'
);

create temporary table acquired_guest_run on commit drop as
select
  receipt.item_id,
  receipt.run_id,
  receipt.queue_message_id,
  (
    public.claim_pipeline_run_attempt(
      receipt.run_id,
      receipt.queue_message_id,
      300
    )->'context'->'run'->>'lease_token'
  )::uuid as lease_token
from guest_submission_receipt receipt;

select ok(
  (select lease_token is not null from acquired_guest_run),
  'the submitted guest run is acquired through the production worker seam'
);
select public.checkpoint_pipeline_run(
  run_id,
  lease_token,
  'generating',
  jsonb_build_object(
    'identified', jsonb_build_object('attributes', jsonb_build_object('brand', 'Sony')),
    'priced', jsonb_build_object(
      'evidenceAsOf', statement_timestamp()::text,
      'result', jsonb_build_object('suggested', 50)
    ),
    'generated', jsonb_build_object('title', 'Sony headphones')
  ),
  300
)
from acquired_guest_run;

select lives_ok(
  $$
    select public.stage_guest_recovery_upload_cleanup(
      run_id,
      lease_token,
      array[
        'guest_21d440432c7055a7284db05990333cd2c7d76a8a185db3ef/guest-recovery/63830000-0000-4000-8000-000000000013/0-front.enc'
      ]
    )
    from acquired_guest_run
  $$,
  'the acquired run records cleanup authority before encrypted upload'
);
select is(
  (select count(*)::integer
   from private.pipeline_storage_cleanup_jobs cleanup
   where cleanup.source_type = 'guest_recovery'
     and cleanup.source_id = '63830000-0000-4000-8000-000000000013'
     and cleanup.state = 'pending'),
  1,
  'a preparation failure would leave one bounded cleanup job for uploaded ciphertext'
);

select lives_ok(
  $$
    select public.complete_pipeline_run_with_guest_recovery(
      (select run_id from acquired_guest_run),
      (select lease_token from acquired_guest_run),
      jsonb_build_object(
        'item', jsonb_build_object(
          'attributes', jsonb_build_object('brand', 'Sony'),
          'condition', 'good',
          'identification', jsonb_build_object(
            'label', 'Sony headphones',
            'confident', true,
            'evidence', 1
          )
        ),
        'listing', jsonb_build_object(
          'platform', 'ebay',
          'title', 'Sony headphones',
          'description', 'Used headphones.',
          'copy', '{}'::jsonb,
          'status', 'draft'
        ),
        'prediction', jsonb_build_object(
          'extracted_attrs', jsonb_build_object('brand', 'Sony'),
          'autopilot_enabled', false,
          'autopilot_eligible', false,
          'price', 50,
          'price_range', jsonb_build_object('low', 40, 'high', 60),
          'confidence', 0.5,
          'tier_fired', 'llm-only',
          'model', 'vision-model',
          'listing_model', 'listing-model',
          'pricing_model', null,
          'sources', '[]'::jsonb
        ),
        'pricing_snapshot', jsonb_build_object(
          'schema_version', 1,
          'item', jsonb_build_object('title', 'Sony headphones', 'condition', 'good'),
          'price_result', jsonb_build_object(
            'suggested', 50,
            'range', jsonb_build_object('min', 40, 'max', 60),
            'confidence', 0.5,
            'sources', '[]'::jsonb,
            'tier', 'llm-only'
          ),
          'evidence', '[]'::jsonb
        )
      ),
      jsonb_build_object(
        'recoveryId', '63830000-0000-4000-8000-000000000013',
        'guestUserId', 'guest_21d440432c7055a7284db05990333cd2c7d76a8a185db3ef',
        'pipelineRunId', (select run_id::text from acquired_guest_run),
        'recoveryTokenHash', repeat('d', 64),
        'encryptedArtifact', jsonb_build_object(
          'version', 1,
          'algorithm', 'aes-256-gcm',
          'keyId', 'guest-recovery-key-v1',
          'keyEnvelope', 'AQ==',
          'nonce', 'AQEBAQEBAQEBAQEB',
          'tag', 'AgICAgICAgICAgICAgICAg==',
          'ciphertext', 'Aw=='
        ),
        'storageManifest', jsonb_build_array(jsonb_build_object(
          'sourcePath', 'guest_21d440432c7055a7284db05990333cd2c7d76a8a185db3ef/guest-recovery/63830000-0000-4000-8000-000000000013/0-front.enc',
          'sha256', repeat('a', 64),
          'byteLength', 52428837,
          'encryption', jsonb_build_object(
            'algorithm', 'aes-256-gcm',
            'keyId', 'guest-recovery-key-v1',
            'nonce', 'BAQEBAQEBAQEBAQE',
            'tag', 'BQUFBQUFBQUFBQUFBQUFBQ=='
          )
        ))
      )
    )
  $$,
  'one usable guest draft atomically completes and registers its encrypted recovery'
);

select is(
  (select count(*)::integer from private.guest_draft_recoveries
   where id = '63830000-0000-4000-8000-000000000013'),
  1,
  'usable-draft completion creates exactly one recovery row'
);
select is(
  (select (storage_manifest->0->>'byteLength')::bigint
   from private.guest_draft_recoveries
   where id = '63830000-0000-4000-8000-000000000013'),
  52428837::bigint,
  'registration accepts a 50 MiB photo plus the 37-byte encryption envelope'
);
select throws_ok(
  $$
    select public.register_guest_draft_recovery(
      '63830000-0000-4000-8000-000000000013'::uuid,
      'guest_21d440432c7055a7284db05990333cd2c7d76a8a185db3ef',
      (select run_id from acquired_guest_run),
      repeat('d', 64),
      (select encrypted_artifact
       from private.guest_draft_recoveries
       where id = '63830000-0000-4000-8000-000000000013'),
      jsonb_set(
        (select storage_manifest
         from private.guest_draft_recoveries
         where id = '63830000-0000-4000-8000-000000000013'),
        '{0,byteLength}',
        '52428838'::jsonb
      ),
      array[
        'guest_21d440432c7055a7284db05990333cd2c7d76a8a185db3ef/pipeline-staging/63830000-0000-4000-8000-000000000002/0/front.jpg'
      ]::text[]
    )
  $$,
  '22023',
  'Invalid private Storage recovery manifest',
  'registration rejects one byte beyond the encrypted 50 MiB boundary'
);
select is(
  (select recovery_token_hash from private.guest_draft_recoveries
   where id = '63830000-0000-4000-8000-000000000013'),
  repeat('d', 64),
  'the recovery row stores the native token hash'
);
select ok(
  position(
    'raw-recovery-token'
    in coalesce((
      select to_jsonb(recovery)::text
      from private.guest_draft_recoveries recovery
      where recovery.id = '63830000-0000-4000-8000-000000000013'
    ), '')
  ) = 0,
  'the raw token does not land in the recovery row'
);
select is(
  (select item.photos
   from public.items item
   join acquired_guest_run acquired on acquired.item_id = item.id),
  array[
    'guest_21d440432c7055a7284db05990333cd2c7d76a8a185db3ef/guest-recovery/63830000-0000-4000-8000-000000000013/0-front.enc'
  ],
  'the usable guest result references the encrypted recovery photo envelope'
);
select is(
  (select private.guest_manifest_source_paths(recovery.storage_manifest)
   from private.guest_draft_recoveries recovery
   where recovery.id = '63830000-0000-4000-8000-000000000013'),
  (select item.photos
   from public.items item
   join acquired_guest_run acquired on acquired.item_id = item.id),
  'the unchanged claim and expiry contracts see the exact item photo paths'
);
select is(
  (select count(*)::integer
   from private.pipeline_storage_cleanup_jobs cleanup
   where cleanup.source_type = 'guest_recovery'
     and cleanup.source_id = '63830000-0000-4000-8000-000000000013'),
  0,
  'atomic registration consumes the pre-upload cleanup job'
);
select is(
  (select count(*)::integer
   from private.pipeline_storage_cleanup_jobs cleanup
   where cleanup.source_type = 'staging'
     and cleanup.source_id = '63830000-0000-4000-8000-000000000013'
     and cleanup.state = 'pending'),
  1,
  'atomic registration queues one cleanup job for superseded plaintext photos'
);
select is(
  (select cleanup.photo_paths
   from private.pipeline_storage_cleanup_jobs cleanup
   where cleanup.source_type = 'staging'
     and cleanup.source_id = '63830000-0000-4000-8000-000000000013'),
  array[
    'guest_21d440432c7055a7284db05990333cd2c7d76a8a185db3ef/pipeline-staging/63830000-0000-4000-8000-000000000010/0/front.jpg'
  ],
  'plaintext cleanup is bounded to the exact submitted photo paths'
);
select is(
  (select count(*)::integer
   from public.ai_item_credit_reservations reservation
   where reservation.pipeline_run_id = (select run_id from acquired_guest_run)
     and reservation.state = 'settled'
     and reservation.restored_at is null),
  1,
  'recovery registration leaves the normal completion with one settled credit'
);
select is(
  (select reservation.photo_set_fingerprint
   from public.ai_item_credit_reservations reservation
   where reservation.pipeline_run_id = (select run_id from acquired_guest_run)),
  encode(
    sha256(convert_to(array_to_json(array[
      'guest_21d440432c7055a7284db05990333cd2c7d76a8a185db3ef/pipeline-staging/63830000-0000-4000-8000-000000000010/0/front.jpg'
    ]::text[])::text, 'UTF8')),
    'hex'
  ),
  'the storage-address remap does not rewrite credited photo-set accounting'
);
select throws_ok(
  $$
    select public.complete_pipeline_run_with_guest_recovery(
      (select run_id from acquired_guest_run),
      (select lease_token from acquired_guest_run),
      '{}'::jsonb,
      '{}'::jsonb
    )
  $$,
  '55000',
  'Pipeline worker lease is stale',
  'a redelivered terminal run cannot execute completion again'
);
select is(
  (select count(*)::integer from private.guest_draft_recoveries
   where pipeline_run_id = (select run_id from acquired_guest_run)),
  1,
  'redelivery leaves one registered recovery for the run'
);

insert into private.app_attest_keys (
  key_id, app_id, environment, public_key_pem, receipt,
  assertion_counter, bundle_version, validation_category
) values (
  'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
  'TEAMID1234.dev.snaplist.ios',
  'production',
  '-----BEGIN PUBLIC KEY-----fixed',
  decode('01', 'hex'),
  1,
  '1',
  1
);

select ok(
  public.issue_guest_claim_handoff(
    '63830000-0000-4000-8000-000000000016'::uuid,
    decode(repeat('ab', 32), 'hex'),
    'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
    'TEAMID1234.dev.snaplist.ios',
    'production',
    'guest_21d440432c7055a7284db05990333cd2c7d76a8a185db3ef',
    '63830000-0000-4000-8000-000000000013'::uuid,
    repeat('d', 64),
    (select photo_identity_fingerprint from public.items
     where id = (select item_id from acquired_guest_run)),
    statement_timestamp(),
    statement_timestamp() + interval '5 minutes'
  ),
  'the registered run is immediately eligible for guesthandoff_v1 issuance'
);
select is(
  (select handoff.photo_set_fingerprint
   from private.guest_claim_handoffs handoff
   where handoff.handoff_id = '63830000-0000-4000-8000-000000000016'),
  (select item.photo_identity_fingerprint
   from public.items item
   where item.id = (select item_id from acquired_guest_run)),
  'the issuable handoff preserves the run immutable photo-set fingerprint'
);

select * from finish();

rollback;
