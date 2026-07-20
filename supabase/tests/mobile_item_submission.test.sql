begin;

select plan(13);

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
  'public', 'commit_mobile_item_submission',
  array['text', 'uuid', 'text', 'uuid', 'uuid', 'numeric', 'integer', 'integer', 'jsonb', 'jsonb'],
  'producer has one fixed atomic commit'
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

select * from finish();

rollback;
