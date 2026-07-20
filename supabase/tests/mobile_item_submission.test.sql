begin;

select plan(23);

select has_table(
  'private', 'mobile_item_submissions',
  'mobile submission replay truth is private'
);
select has_column(
  'private', 'mobile_item_submissions', 'request_fingerprint',
  'replay truth binds the exact multipart request'
);
select has_column(
  'private', 'mobile_item_submissions', 'photo_receipts',
  'replay truth retains verified photo receipts'
);
select has_column(
  'private', 'mobile_item_submissions', 'cleanup_id',
  'replay truth links the pre-upload cleanup intent'
);
select has_column(
  'private', 'mobile_item_submissions', 'state',
  'submission truth distinguishes resumable upload from committed receipt'
);
select has_column(
  'private', 'mobile_item_submissions', 'cost_basis',
  'the pre-upload binding retains the cost-sensitive input'
);

select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'private.mobile_item_submissions'::regclass
      and conname = 'mobile_item_submissions_pkey'
  ),
  'idempotency is unique per principal'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'private.mobile_item_submissions'::regclass
      and conname = 'mobile_item_submissions_item_owner_fkey'
  ),
  'submission item ownership is composite and durable'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'private.mobile_item_submissions'::regclass
      and conname = 'mobile_item_submissions_run_owner_fkey'
  ),
  'submission run ownership is composite and durable'
);

select has_function(
  'public', 'find_mobile_item_submission', array['text', 'uuid', 'text'],
  'producer has a fixed replay lookup'
);
select has_function(
  'public', 'begin_mobile_item_submission',
  array['text', 'uuid', 'text', 'uuid', 'uuid', 'numeric', 'jsonb'],
  'producer atomically binds uploading truth and cleanup intent'
);
select has_function(
  'public', 'commit_mobile_item_submission',
  array['text', 'uuid', 'text', 'uuid', 'uuid', 'numeric', 'integer', 'integer', 'jsonb', 'jsonb'],
  'producer has one fixed atomic commit'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.begin_mobile_item_submission(text,uuid,text,uuid,uuid,numeric,jsonb)',
    'execute'
  ),
  'service role may invoke the fixed pre-upload binding'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.begin_mobile_item_submission(text,uuid,text,uuid,uuid,numeric,jsonb)',
    'execute'
  ),
  'seller tokens cannot bind server submission truth'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.commit_mobile_item_submission(text,uuid,text,uuid,uuid,numeric,integer,integer,jsonb,jsonb)',
    'execute'
  ),
  'service role may invoke only the fixed commit capability'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.commit_mobile_item_submission(text,uuid,text,uuid,uuid,numeric,integer,integer,jsonb,jsonb)',
    'execute'
  ),
  'seller tokens cannot invoke the service commit capability'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.find_mobile_item_submission(text,uuid,text)',
    'execute'
  ),
  'seller tokens cannot read server idempotency truth'
);
select ok(
  not has_table_privilege(
    'service_role', 'private.mobile_item_submissions', 'select'
  ),
  'the service role has no generic submission-ledger access'
);

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"mobile-submission-round-3"}',
  true
);

select lives_ok(
  $$
    select public.begin_mobile_item_submission(
      'user_test_mobile_submission_round_3',
      '33460000-0000-4000-8000-000000000001'::uuid,
      repeat('d', 64),
      '33460000-0000-4000-8000-000000000001'::uuid,
      '33460000-0000-4000-8000-000000000002'::uuid,
      null,
      jsonb_build_array(jsonb_build_object(
        'ordinal', 0,
        'storage_path',
          'user_test_mobile_submission_round_3/pipeline-staging/'
          || '33460000-0000-4000-8000-000000000001/0/'
          || repeat('c', 64) || '.jpg',
        'content_sha256', repeat('c', 64),
        'byte_length', 4,
        'media_type', 'image/jpeg'
      ))
    )
  $$,
  'the first request durably binds an uploading submission and cleanup intent'
);

update private.pipeline_staging_cleanup_intents intent
set created_at = statement_timestamp() - interval '25 hours',
    cleanup_after = statement_timestamp() - interval '1 hour'
where intent.cleanup_id = '33460000-0000-4000-8000-000000000002'::uuid;

select lives_ok(
  $$
    select public.begin_mobile_item_submission(
      'user_test_mobile_submission_round_3',
      '33460000-0000-4000-8000-000000000001'::uuid,
      repeat('d', 64),
      '33460000-0000-4000-8000-000000000001'::uuid,
      '33460000-0000-4000-8000-000000000002'::uuid,
      null,
      jsonb_build_array(jsonb_build_object(
        'ordinal', 0,
        'storage_path',
          'user_test_mobile_submission_round_3/pipeline-staging/'
          || '33460000-0000-4000-8000-000000000001/0/'
          || repeat('c', 64) || '.jpg',
        'content_sha256', repeat('c', 64),
        'byte_length', 4,
        'media_type', 'image/jpeg'
      ))
    )
  $$,
  'exact pending replay renews the expired cleanup intent atomically'
);

select cmp_ok(
  (
    select intent.cleanup_after
    from private.pipeline_staging_cleanup_intents intent
    where intent.cleanup_id = '33460000-0000-4000-8000-000000000002'::uuid
  ),
  '>',
  statement_timestamp() + interval '23 hours',
  'pending replay protects the exact paths for a fresh retention window'
);

select is(
  (public.prepare_pipeline_retention(25)->>'storageJobsQueued')::integer,
  0,
  'retention cannot queue replay paths for deletion after renewal'
);

select ok(
  exists (
    select 1
    from private.pipeline_staging_cleanup_intents intent
    where intent.cleanup_id = '33460000-0000-4000-8000-000000000002'::uuid
  ),
  'the renewed cleanup intent remains durable until submission commit'
);

select * from finish();

rollback;
