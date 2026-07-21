begin;

select plan(12);

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"mobile-submission-five-photos"}',
  true
);

create temporary table issue352_input (
  receipts jsonb not null,
  fingerprint text not null
) on commit drop;

insert into issue352_input (receipts, fingerprint)
select
  jsonb_agg(
    jsonb_build_object(
      'ordinal', photo.ordinal,
      'storage_path',
        'user_test_mobile_submission_five/pipeline-staging/'
        || '35260000-0000-4000-8000-000000000001/0/'
        || photo.ordinal::text || '-' || photo.digest || '.jpg',
      'content_sha256', photo.digest,
      'byte_length', 4 + photo.ordinal,
      'media_type', 'image/jpeg'
    ) order by photo.ordinal
  ),
  encode(
    sha256(convert_to(string_agg(photo.digest, E'\n' order by photo.digest), 'UTF8')),
    'hex'
  )
from (
  select ordinal, lpad(to_hex(ordinal + 1), 64, '0') as digest
  from generate_series(0, 4) ordinal
) photo;

select lives_ok(
  $$
    select public.begin_mobile_item_submission(
      'user_test_mobile_submission_five',
      '35260000-0000-4000-8000-000000000001'::uuid,
      repeat('a', 64),
      '35260000-0000-4000-8000-000000000001'::uuid,
      '35260000-0000-4000-8000-000000000002'::uuid,
      12.34,
      (select receipts from issue352_input)
    )
  $$,
  'five verified receipts bind one durable pre-upload cleanup intent'
);

select is(
  (
    select jsonb_array_length(submission.photo_receipts)
    from private.mobile_item_submissions submission
    where submission.user_id = 'user_test_mobile_submission_five'
      and submission.idempotency_key =
        '35260000-0000-4000-8000-000000000001'::uuid
  ),
  5,
  'the private replay ledger preserves all five ordered receipts'
);

select lives_ok(
  $$
    create temporary table issue352_commit on commit drop as
    select *
    from public.commit_mobile_item_submission(
      'user_test_mobile_submission_five',
      '35260000-0000-4000-8000-000000000001'::uuid,
      repeat('a', 64),
      '35260000-0000-4000-8000-000000000001'::uuid,
      '35260000-0000-4000-8000-000000000002'::uuid,
      12.34,
      15,
      20,
      jsonb_build_object(
        'kind', 'content_sha256_set_v1',
        'fingerprint', (select fingerprint from issue352_input)
      ),
      (select receipts from issue352_input)
    )
  $$,
  'five verified receipts atomically create one item, reservation, run, and queue message'
);

select is(
  (
    select item.photos
    from public.items item
    join issue352_commit committed on committed.item_id = item.id
  ),
  array(
    select receipt.value->>'storage_path'
    from issue352_input input,
      jsonb_array_elements(input.receipts) with ordinality receipt(value, position)
    order by receipt.position
  ),
  'the durable item preserves exact presentation order for ordinal zero through four'
);

select is(
  (
    select run.capture_input->>'photo_count'
    from public.pipeline_runs run
    join issue352_commit committed on committed.run_id = run.id
  ),
  '5',
  'canonical worker acquisition records five single-item photos'
);

select is(
  (
    select count(*)::integer
    from public.ai_item_credit_reservations reservation
    join issue352_commit committed
      on committed.run_id = reservation.pipeline_run_id
  ),
  1,
  'five photos reserve exactly one AI-item credit'
);

select is(
  (
    select count(*)::integer
    from pgmq.q_pipeline_jobs message
    join issue352_commit committed
      on message.message->>'run_id' = committed.run_id::text
  ),
  1,
  'accepted five-photo intake publishes exactly one durable queue message'
);

select lives_ok(
  $$
    create temporary table issue352_replay on commit drop as
    select *
    from public.commit_mobile_item_submission(
      'user_test_mobile_submission_five',
      '35260000-0000-4000-8000-000000000001'::uuid,
      repeat('a', 64),
      '35260000-0000-4000-8000-000000000001'::uuid,
      '35260000-0000-4000-8000-000000000002'::uuid,
      12.34,
      15,
      20,
      jsonb_build_object(
        'kind', 'content_sha256_set_v1',
        'fingerprint', (select fingerprint from issue352_input)
      ),
      (select receipts from issue352_input)
    )
  $$,
  'the exact five-photo commit is replayable after an ambiguous response'
);

select is(
  (
    select replay.run_id::text || ':' || replay.is_replay::text
    from issue352_replay replay
  ),
  (
    select committed.run_id::text || ':true'
    from issue352_commit committed
  ),
  'exact replay returns the original run without duplicate durable work'
);

select throws_ok(
  $$
    select public.begin_mobile_item_submission(
      'user_test_mobile_submission_five',
      '35260000-0000-4000-8000-000000000001'::uuid,
      repeat('b', 64),
      '35260000-0000-4000-8000-000000000001'::uuid,
      '35260000-0000-4000-8000-000000000002'::uuid,
      12.34,
      (
        select jsonb_agg(receipt.value order by receipt.position)
        from issue352_input input,
          jsonb_array_elements(input.receipts) with ordinality receipt(value, position)
        where receipt.position <= 4
      )
    )
  $$,
  '23514',
  'Mobile item submission idempotency conflict',
  'a changed valid photo count conflicts with the bound logical request'
);

select throws_ok(
  $$
    select public.begin_mobile_item_submission(
      'user_test_mobile_submission_six',
      '35260000-0000-4000-8000-000000000006'::uuid,
      repeat('c', 64),
      '35260000-0000-4000-8000-000000000006'::uuid,
      '35260000-0000-4000-8000-000000000007'::uuid,
      null,
      (
        select jsonb_agg(jsonb_build_object(
          'ordinal', photo.ordinal,
          'storage_path',
            'user_test_mobile_submission_six/pipeline-staging/'
            || '35260000-0000-4000-8000-000000000006/0/'
            || photo.ordinal::text || '-' || photo.digest || '.jpg',
          'content_sha256', photo.digest,
          'byte_length', 4,
          'media_type', 'image/jpeg'
        ) order by photo.ordinal)
        from (
          select ordinal, lpad(to_hex(ordinal + 1), 64, '0') as digest
          from generate_series(0, 5) ordinal
        ) photo
      )
    )
  $$,
  '22023',
  'Invalid uploading mobile item submission',
  'six photos fail before durable cleanup or run work begins'
);

select throws_ok(
  $$
    select * from public.stage_pipeline_batch(
      'user_test_batch_stays_four',
      '35260000-0000-4000-8000-000000000008'::uuid,
      jsonb_build_array(jsonb_build_object(
        'idempotency_key', 'batch-five',
        'source', 'batch',
        'autopilot_enabled', false,
        'photo_paths', jsonb_build_array(
          'user_test_batch_stays_four/photo-0.jpg',
          'user_test_batch_stays_four/photo-1.jpg',
          'user_test_batch_stays_four/photo-2.jpg',
          'user_test_batch_stays_four/photo-3.jpg',
          'user_test_batch_stays_four/photo-4.jpg'
        ),
        'cost_basis', null
      )),
      15,
      20
    )
  $$,
  '22023',
  'Invalid pipeline staging entry',
  'the compatibility migration does not widen haul or batch intake'
);

select * from finish();

rollback;
