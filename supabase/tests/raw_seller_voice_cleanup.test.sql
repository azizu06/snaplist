begin;

select plan(51);

-- Issue #386: raw seller voice is temporary transcription input. The first
-- durable terminal transcription outcome schedules deletion; a 24 hour ceiling
-- after durable acceptance is the backstop. Spans anchor to now(), which is
-- transaction_timestamp(), so every site in this file agrees and no fixture
-- expires on a calendar rollover.

-- Raw audio is an additional cleanup source. Adding it must not narrow the set,
-- because a source the constraint rejects is cleanup work that can never be
-- queued at all.
savepoint every_cleanup_source;
insert into private.pipeline_storage_cleanup_jobs (source_type, source_id, photo_paths)
select source_type, gen_random_uuid(), array['probe/object']
from unnest(array[
  'staging', 'abandoned_item', 'guest_recovery', 'guest_claim_copy', 'raw_voice'
]) as source_type;
select is(
  (
    select count(distinct job.source_type)::integer
    from private.pipeline_storage_cleanup_jobs job
    where job.photo_paths = array['probe/object']
  ),
  5,
  'every cleanup source stays queueable once raw audio joins them'
);
rollback to savepoint every_cleanup_source;

select extensions.has_function(
  'public', 'record_raw_seller_voice_transcription_outcome',
  array['text', 'uuid', 'text'],
  'terminal transcription outcomes have a durable cleanup seam'
);
select extensions.function_privs_are(
  'public', 'record_raw_seller_voice_transcription_outcome',
  array['text', 'uuid', 'text'], 'service_role',
  array['EXECUTE'], 'only the worker capability records a terminal outcome'
);
select extensions.function_privs_are(
  'public', 'record_raw_seller_voice_transcription_outcome',
  array['text', 'uuid', 'text'], 'authenticated',
  array[]::text[], 'a seller cannot schedule cross-tenant raw voice deletion'
);

insert into private.mobile_item_submission_voice_handoffs (
  user_id,
  idempotency_key,
  request_fingerprint,
  batch_id,
  cleanup_id,
  receipt,
  state,
  item_id,
  run_id,
  cleanup_after,
  accepted_at
) values (
  'raw-voice-owner',
  '86000000-0000-4000-8000-000000000001',
  repeat('a', 64),
  '86000000-0000-4000-8000-0000000000b1',
  '86000000-0000-4000-8000-0000000000c1',
  jsonb_build_object(
    'version', 1,
    'storage_path',
      'raw-voice-owner/pipeline-staging/86000000-0000-4000-8000-0000000000b1/0/voice-'
        || repeat('d', 64) || '.wav',
    'content_sha256', repeat('d', 64),
    'byte_length', 1024,
    'duration_ms', 4000,
    'locale', 'en-US',
    'media_type', 'audio/wav'
  ),
  'accepted',
  '86000000-0000-4000-8000-0000000000d1',
  '86000000-0000-4000-8000-0000000000e1',
  now() + interval '24 hours',
  now()
);

set local role service_role;
select set_config(
  'request.jwt.claims', '{"role":"service_role"}', true
);

select is(
  public.record_raw_seller_voice_transcription_outcome(
    'raw-voice-owner',
    '86000000-0000-4000-8000-0000000000e1',
    'transcribed'
  ),
  true,
  'the first terminal transcription outcome schedules raw audio deletion'
);

reset role;

select is(
  (
    select count(*)::integer
    from private.pipeline_storage_cleanup_jobs job
    where job.source_type = 'raw_voice'
      and job.source_id = '86000000-0000-4000-8000-0000000000c1'
      and job.photo_paths = array[
        'raw-voice-owner/pipeline-staging/86000000-0000-4000-8000-0000000000b1/0/voice-'
          || repeat('d', 64) || '.wav'
      ]
  ),
  1,
  'exactly one retryable cleanup job carries the exact raw audio path'
);

select is(
  (
    select handoff.transcription_outcome
    from private.mobile_item_submission_voice_handoffs handoff
    where handoff.cleanup_id = '86000000-0000-4000-8000-0000000000c1'
  ),
  'transcribed',
  'the handoff records the first terminal outcome'
);

select isnt(
  (
    select handoff.raw_audio_cleanup_queued_at
    from private.mobile_item_submission_voice_handoffs handoff
    where handoff.cleanup_id = '86000000-0000-4000-8000-0000000000c1'
  ),
  null,
  'the handoff records when deletion became durable work'
);

set local role service_role;
select set_config(
  'request.jwt.claims', '{"role":"service_role"}', true
);

select is(
  public.record_raw_seller_voice_transcription_outcome(
    'raw-voice-owner',
    '86000000-0000-4000-8000-0000000000e1',
    'failed'
  ),
  false,
  'a later terminal outcome schedules no second deletion'
);

select is(
  public.record_raw_seller_voice_transcription_outcome(
    'raw-voice-owner',
    '86000000-0000-4000-8000-0000000000ff',
    'transcribed'
  ),
  false,
  'an unknown run schedules nothing instead of failing the worker'
);

select extensions.throws_ok(
  $$select public.record_raw_seller_voice_transcription_outcome(
    'raw-voice-owner',
    '86000000-0000-4000-8000-0000000000e1',
    'running'
  )$$,
  '22023',
  'Invalid seller voice transcription outcome',
  'a non-terminal outcome cannot schedule deletion'
);

reset role;

select is(
  (
    select count(*)::integer
    from private.pipeline_storage_cleanup_jobs job
    where job.source_type = 'raw_voice'
  ),
  1,
  'replayed terminal outcomes never queue a second deletion'
);

select is(
  (
    select handoff.transcription_outcome
    from private.mobile_item_submission_voice_handoffs handoff
    where handoff.cleanup_id = '86000000-0000-4000-8000-0000000000c1'
  ),
  'transcribed',
  'the first recorded terminal outcome is immutable'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"raw-voice-owner","role":"authenticated"}',
  true
);
select extensions.throws_ok(
  $$select public.record_raw_seller_voice_transcription_outcome(
    'raw-voice-owner',
    '86000000-0000-4000-8000-0000000000e1',
    'transcribed'
  )$$,
  '42501',
  'permission denied for function record_raw_seller_voice_transcription_outcome',
  'an authenticated seller cannot drive raw voice deletion'
);
reset role;

-- The event trigger only ever deletes earlier. The ceiling is what makes the
-- 24 hour promise true when transcription never reaches a terminal outcome.
select extensions.has_function(
  'public', 'prepare_raw_seller_voice_retention', array['integer'],
  'the raw voice ceiling has a bounded preparation RPC'
);
select extensions.function_privs_are(
  'public', 'prepare_raw_seller_voice_retention', array['integer'],
  'service_role',
  array['EXECUTE'], 'service role receives fixed raw voice retention authority'
);
select extensions.function_privs_are(
  'public', 'prepare_raw_seller_voice_retention', array['integer'],
  'authenticated',
  array[]::text[], 'a seller cannot sweep another tenant raw audio'
);

insert into private.mobile_item_submission_voice_handoffs (
  user_id,
  idempotency_key,
  request_fingerprint,
  batch_id,
  cleanup_id,
  receipt,
  state,
  cleanup_after
) values (
  'raw-voice-overdue',
  '86000000-0000-4000-8000-000000000002',
  repeat('b', 64),
  '86000000-0000-4000-8000-0000000000b2',
  '86000000-0000-4000-8000-0000000000c2',
  jsonb_build_object(
    'version', 1,
    'storage_path',
      'raw-voice-overdue/pipeline-staging/86000000-0000-4000-8000-0000000000b2/0/voice-'
        || repeat('e', 64) || '.wav',
    'content_sha256', repeat('e', 64),
    'byte_length', 2048,
    'duration_ms', 9000,
    'locale', null,
    'media_type', 'audio/wav'
  ),
  'staged',
  now() - interval '1 minute'
);

insert into private.mobile_item_submission_voice_handoffs (
  user_id,
  idempotency_key,
  request_fingerprint,
  batch_id,
  cleanup_id,
  receipt,
  state,
  item_id,
  run_id,
  cleanup_after,
  accepted_at,
  raw_audio_deleted_at
) values (
  'raw-voice-settled',
  '86000000-0000-4000-8000-000000000003',
  repeat('c', 64),
  '86000000-0000-4000-8000-0000000000b3',
  '86000000-0000-4000-8000-0000000000c3',
  jsonb_build_object(
    'version', 1,
    'storage_path',
      'raw-voice-settled/pipeline-staging/86000000-0000-4000-8000-0000000000b3/0/voice-'
        || repeat('f', 64) || '.wav',
    'content_sha256', repeat('f', 64),
    'byte_length', 512,
    'duration_ms', 1500,
    'locale', 'en-US',
    'media_type', 'audio/wav'
  ),
  'accepted',
  '86000000-0000-4000-8000-0000000000d3',
  '86000000-0000-4000-8000-0000000000e3',
  now() - interval '2 hours',
  now() - interval '26 hours',
  now() - interval '1 hour'
);

set local role service_role;
select set_config(
  'request.jwt.claims', '{"role":"service_role"}', true
);

select is(
  public.prepare_raw_seller_voice_retention(25),
  jsonb_build_object('rawVoiceJobsQueued', 1, 'skippedForLock', false),
  'the ceiling queues exactly the overdue undeleted raw audio'
);

select is(
  public.prepare_raw_seller_voice_retention(25),
  jsonb_build_object('rawVoiceJobsQueued', 0, 'skippedForLock', false),
  'a repeated sweep queues no duplicate deletion'
);

reset role;

select is(
  (
    select count(*)::integer
    from private.pipeline_storage_cleanup_jobs job
    where job.source_type = 'raw_voice'
      and job.source_id = '86000000-0000-4000-8000-0000000000c2'
      and job.photo_paths = array[
        'raw-voice-overdue/pipeline-staging/86000000-0000-4000-8000-0000000000b2/0/voice-'
          || repeat('e', 64) || '.wav'
      ]
  ),
  1,
  'an uncommitted staged upload past the ceiling is still deleted'
);

select is(
  (
    select count(*)::integer
    from private.pipeline_storage_cleanup_jobs job
    where job.source_type = 'raw_voice'
      and job.source_id = '86000000-0000-4000-8000-0000000000c3'
  ),
  0,
  'raw audio already proven absent is never queued again'
);

select is(
  (
    select count(*)::integer
    from private.pipeline_storage_cleanup_jobs job
    where job.source_type = 'raw_voice'
  ),
  2,
  'the ceiling never touches a handoff that is not yet due'
);

-- A claimed job is not authority to delete, and completion is the only place a
-- deletion may be reported. The executor must be able to tell raw audio apart
-- from photo cleanup so it can prove absence before claiming completion.
set local role service_role;
select set_config(
  'request.jwt.claims', '{"role":"service_role"}', true
);

create temporary table raw_voice_claim on commit drop as
select public.claim_pipeline_storage_cleanup(300) as claim;

select is(
  (select claim->'job'->>'sourceType' from raw_voice_claim),
  'raw_voice',
  'the executor can tell raw seller audio apart from photo cleanup'
);

select is(
  (
    select public.authorize_pipeline_storage_cleanup(
      (claim->'job'->>'jobId')::uuid,
      (claim->'job'->>'leaseToken')::uuid
    )->>'kind'
    from raw_voice_claim
  ),
  'authorized',
  'raw audio deletion is authorized immediately before the Storage call'
);

select is(
  (
    select public.complete_pipeline_storage_cleanup(
      (claim->'job'->>'jobId')::uuid,
      (claim->'job'->>'leaseToken')::uuid
    )
    from raw_voice_claim
  ),
  true,
  'a proven Storage removal completes the durable cleanup job'
);

reset role;

select isnt(
  (
    select handoff.raw_audio_deleted_at
    from private.mobile_item_submission_voice_handoffs handoff
    where handoff.cleanup_id = '86000000-0000-4000-8000-0000000000c1'
  ),
  null,
  'completion records the named raw voice deletion proof'
);

set local role service_role;
select set_config(
  'request.jwt.claims', '{"role":"service_role"}', true
);

select is(
  (
    select public.complete_pipeline_storage_cleanup(
      (claim->'job'->>'jobId')::uuid,
      (claim->'job'->>'leaseToken')::uuid
    )
    from raw_voice_claim
  ),
  false,
  'a replayed completion cannot report a second deletion'
);

create temporary table raw_voice_failed_claim on commit drop as
select public.claim_pipeline_storage_cleanup(300) as claim;

select is(
  (
    select public.fail_pipeline_storage_cleanup(
      (claim->'job'->>'jobId')::uuid,
      (claim->'job'->>'leaseToken')::uuid,
      'Raw voice cleanup failed and will be retried.'
    )
    from raw_voice_failed_claim
  ),
  true,
  'a failed removal returns the job for retry'
);

reset role;

select is(
  (
    select handoff.raw_audio_deleted_at
    from private.mobile_item_submission_voice_handoffs handoff
    where handoff.cleanup_id = '86000000-0000-4000-8000-0000000000c2'
  ),
  null,
  'a failed removal never records a deletion proof'
);

select is(
  (
    select job.state
    from private.pipeline_storage_cleanup_jobs job
    where job.source_type = 'raw_voice'
      and job.source_id = '86000000-0000-4000-8000-0000000000c2'
  ),
  'pending',
  'unproven raw audio stays durable work instead of disappearing'
);

-- The 24 hour ceiling is the product promise, so the table refuses a write that
-- would push a deadline past it rather than trusting every future caller.
select extensions.throws_ok(
  $$update private.mobile_item_submission_voice_handoffs
    set cleanup_after = accepted_at + interval '25 hours'
    where cleanup_id = '86000000-0000-4000-8000-0000000000c1'$$,
  '23514',
  null,
  'no write can move a raw voice deadline past 24 hours after acceptance'
);

-- Deleting one tenant raw audio must not read, queue, or remove another
-- tenant object, and must leave the authoritative artifacts standing.
insert into public.items (
  id, user_id, photos, attributes, condition, identification,
  review_revision, review_content_revision,
  photo_identity_kind, photo_identity_fingerprint
) values (
  '86000000-0000-4000-8000-0000000000d4',
  'raw-voice-tenant-a',
  array['raw-voice-tenant-a/items/photo-0.enc'],
  '{"brand":"Fixture"}'::jsonb,
  'good',
  '{"kind":"fixture"}'::jsonb,
  '86000000-0000-4000-8000-0000000000f4',
  '86000000-0000-4000-8000-0000000000f4',
  'content_sha256_set_v1',
  repeat('4', 64)
);

insert into public.pipeline_runs (
  id, user_id, item_id, idempotency_key
) values (
  '86000000-0000-4000-8000-0000000000e4',
  'raw-voice-tenant-a',
  '86000000-0000-4000-8000-0000000000d4',
  'raw-voice-tenant-a-run'
);

insert into public.listings (
  id, user_id, item_id, platform, run_id
) values (
  '86000000-0000-4000-8000-00000000a004',
  'raw-voice-tenant-a',
  '86000000-0000-4000-8000-0000000000d4',
  'ebay',
  '86000000-0000-4000-8000-0000000000e4'
);

insert into private.mobile_item_submission_voice_handoffs (
  user_id,
  idempotency_key,
  request_fingerprint,
  batch_id,
  cleanup_id,
  receipt,
  state,
  item_id,
  run_id,
  cleanup_after,
  accepted_at
) values (
  'raw-voice-tenant-a',
  '86000000-0000-4000-8000-000000000004',
  repeat('4', 64),
  '86000000-0000-4000-8000-0000000000b4',
  '86000000-0000-4000-8000-0000000000c4',
  jsonb_build_object(
    'version', 1,
    'storage_path',
      'raw-voice-tenant-a/pipeline-staging/86000000-0000-4000-8000-0000000000b4/0/voice-'
        || repeat('4', 64) || '.wav',
    'content_sha256', repeat('4', 64),
    'byte_length', 4096,
    'duration_ms', 12000,
    'locale', 'en-US',
    'media_type', 'audio/wav'
  ),
  'accepted',
  '86000000-0000-4000-8000-0000000000d4',
  '86000000-0000-4000-8000-0000000000e4',
  now() + interval '23 hours',
  now()
), (
  'raw-voice-tenant-b',
  '86000000-0000-4000-8000-000000000005',
  repeat('5', 64),
  '86000000-0000-4000-8000-0000000000b5',
  '86000000-0000-4000-8000-0000000000c5',
  jsonb_build_object(
    'version', 1,
    'storage_path',
      'raw-voice-tenant-b/pipeline-staging/86000000-0000-4000-8000-0000000000b5/0/voice-'
        || repeat('5', 64) || '.wav',
    'content_sha256', repeat('5', 64),
    'byte_length', 4096,
    'duration_ms', 12000,
    'locale', 'en-US',
    'media_type', 'audio/wav'
  ),
  'accepted',
  '86000000-0000-4000-8000-0000000000d5',
  '86000000-0000-4000-8000-0000000000e5',
  now() + interval '23 hours',
  now()
);

set local role service_role;
select set_config(
  'request.jwt.claims', '{"role":"service_role"}', true
);

select is(
  public.record_raw_seller_voice_transcription_outcome(
    'raw-voice-tenant-a',
    '86000000-0000-4000-8000-0000000000e5',
    'transcribed'
  ),
  false,
  'one tenant identity cannot schedule another tenant raw audio deletion'
);

select is(
  public.record_raw_seller_voice_transcription_outcome(
    'raw-voice-tenant-a',
    '86000000-0000-4000-8000-0000000000e4',
    'transcribed'
  ),
  true,
  'the owning tenant schedules its own raw audio deletion'
);

create temporary table tenant_a_claim on commit drop as
select public.claim_pipeline_storage_cleanup(300) as claim;

select is(
  (select claim->'job'->'photoPaths' from tenant_a_claim),
  to_jsonb(array[
    'raw-voice-tenant-a/pipeline-staging/86000000-0000-4000-8000-0000000000b4/0/voice-'
      || repeat('4', 64) || '.wav'
  ]),
  'the claim carries only the owning tenant Storage path'
);

select is(
  (
    select public.authorize_pipeline_storage_cleanup(
      (claim->'job'->>'jobId')::uuid,
      (claim->'job'->>'leaseToken')::uuid
    )->'photoPaths'
    from tenant_a_claim
  ),
  to_jsonb(array[
    'raw-voice-tenant-a/pipeline-staging/86000000-0000-4000-8000-0000000000b4/0/voice-'
      || repeat('4', 64) || '.wav'
  ]),
  'the fence re-authorizes only the owning tenant Storage path'
);

select is(
  (
    select public.complete_pipeline_storage_cleanup(
      (claim->'job'->>'jobId')::uuid,
      (claim->'job'->>'leaseToken')::uuid
    )
    from tenant_a_claim
  ),
  true,
  'the owning tenant raw audio deletion completes'
);

reset role;

select isnt(
  (
    select handoff.raw_audio_deleted_at
    from private.mobile_item_submission_voice_handoffs handoff
    where handoff.cleanup_id = '86000000-0000-4000-8000-0000000000c4'
  ),
  null,
  'the owning tenant receives its deletion proof'
);

select is(
  (
    select count(*)::integer
    from private.mobile_item_submission_voice_handoffs handoff
    where handoff.user_id = 'raw-voice-tenant-b'
      and handoff.raw_audio_deleted_at is null
      and handoff.raw_audio_cleanup_queued_at is null
      and handoff.transcription_outcome is null
  ),
  1,
  'a foreign tenant raw audio is untouched by the deletion'
);

-- The transcript is seller context that outlives the audio; nothing else the
-- seller can see may disappear with the raw bytes.
select is(
  (
    select count(*)::integer from public.items item
    where item.id = '86000000-0000-4000-8000-0000000000d4'
  ),
  1,
  'the item survives raw audio deletion'
);

select is(
  (
    select count(*)::integer from public.pipeline_runs run
    where run.id = '86000000-0000-4000-8000-0000000000e4'
  ),
  1,
  'the run survives raw audio deletion'
);

select is(
  (
    select count(*)::integer from public.listings listing
    where listing.id = '86000000-0000-4000-8000-00000000a004'
      and listing.item_id = '86000000-0000-4000-8000-0000000000d4'
  ),
  1,
  'the listing draft survives raw audio deletion'
);

select is(
  (
    select item.photos from public.items item
    where item.id = '86000000-0000-4000-8000-0000000000d4'
  ),
  array['raw-voice-tenant-a/items/photo-0.enc'],
  'the item photo set survives raw audio deletion'
);

select is(
  (
    select count(*)::integer
    from private.pipeline_storage_cleanup_jobs job
    where 'raw-voice-tenant-a/items/photo-0.enc' = any(job.photo_paths)
  ),
  0,
  'raw audio deletion never queues an item photo for removal'
);

-- A raw voice job that dead-lettered would otherwise sit unresolved forever:
-- the object is still present and no proof can ever be recorded. The ceiling
-- sweep is the recovery path, so it revives the job instead of skipping it.
update private.pipeline_storage_cleanup_jobs job
set state = 'dead',
    lease_token = null,
    lease_expires_at = null,
    safe_error = 'Raw seller voice cleanup exhausted its attempts.'
where job.source_type = 'raw_voice'
  and job.source_id = '86000000-0000-4000-8000-0000000000c2';
update private.mobile_item_submission_voice_handoffs handoff
set cleanup_after = now() - interval '1 minute'
where handoff.cleanup_id = '86000000-0000-4000-8000-0000000000c2';

set local role service_role;
select set_config(
  'request.jwt.claims', '{"role":"service_role"}', true
);

select is(
  public.prepare_raw_seller_voice_retention(25),
  jsonb_build_object('rawVoiceJobsQueued', 1, 'skippedForLock', false),
  'the ceiling revives raw audio deletion that dead-lettered'
);

reset role;

select is(
  (
    select job.state
    from private.pipeline_storage_cleanup_jobs job
    where job.source_type = 'raw_voice'
      and job.source_id = '86000000-0000-4000-8000-0000000000c2'
  ),
  'pending',
  'the revived deletion is claimable durable work again'
);

-- Account erasure cannot wait out the ceiling, and cannot report completion
-- while an object still lacks its named proof.
select extensions.function_privs_are(
  'public', 'delete_raw_seller_voice_for_account_erasure', array['text'],
  'authenticated',
  array[]::text[], 'a seller cannot drive another tenant erasure capability'
);

set local role service_role;
select set_config(
  'request.jwt.claims', '{"role":"service_role"}', true
);

select is(
  public.delete_raw_seller_voice_for_account_erasure('raw-voice-tenant-b')
    ->>'complete',
  'false',
  'erasure does not report completion while raw audio lacks its proof'
);

select is(
  public.delete_raw_seller_voice_for_account_erasure('raw-voice-tenant-a')
    ->>'complete',
  'true',
  'erasure reports completion once every object carries its proof'
);

select is(
  public.delete_raw_seller_voice_for_account_erasure('raw-voice-tenant-a')
    ->>'queued_count',
  '0',
  'an erased tenant with nothing left queues no further deletion'
);

reset role;

select is(
  (
    select count(*)::integer
    from private.pipeline_storage_cleanup_jobs job
    where job.source_type = 'raw_voice'
      and job.source_id = '86000000-0000-4000-8000-0000000000c5'
  ),
  1,
  'erasure publishes the erased tenant raw audio deletion immediately'
);

select isnt(
  (
    select handoff.raw_audio_cleanup_queued_at
    from private.mobile_item_submission_voice_handoffs handoff
    where handoff.cleanup_id = '86000000-0000-4000-8000-0000000000c5'
  ),
  null,
  'erasure records when the deletion became durable work'
);

select * from finish();
rollback;
