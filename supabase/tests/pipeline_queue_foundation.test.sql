begin;

select plan(30);

select ok(
  exists (select 1 from pg_extension where extname = 'pgmq'),
  'pgmq is installed'
);

select ok(
  exists (
    select 1
    from pg_extension
    where extname = 'pgmq'
      and (
        split_part(extversion, '.', 1)::integer,
        split_part(extversion, '.', 2)::integer,
        split_part(extversion, '.', 3)::integer
      ) >= (1, 4, 4)
  ),
  'installed pgmq is at least the supported 1.4.4 contract'
);

select ok(
  exists (
    select 1
    from pg_proc function
    join pg_namespace schema on schema.oid = function.pronamespace
    where schema.nspname = 'pgmq'
      and function.proname = 'send'
      and function.pronargs >= 2
      and function.pronargs - function.pronargdefaults <= 2
      and function.proargtypes[0] = 'text'::regtype
      and function.proargtypes[1] = 'jsonb'::regtype
  ),
  'pgmq.send is callable with two arguments via an overload or defaults'
);

select lives_ok(
  $$select * from pgmq.send(
    'pipeline_jobs',
    '{"run_id":"11111111-1111-4111-8111-111111111111","schema_version":1}'::jsonb
  )$$,
  'two-argument send works without relying on the post-1.5 delay overload'
);

select ok(
  exists (
    select 1 from pgmq.meta
    where queue_name = 'pipeline_jobs' and not is_unlogged
  ),
  'pipeline_jobs is a logged Basic Queue'
);

select is(
  (
    select relpersistence::text
    from pg_class relation
    join pg_namespace schema on schema.oid = relation.relnamespace
    where schema.nspname = 'pgmq' and relation.relname = 'q_pipeline_jobs'
  ),
  'p',
  'active queue table is durable/logged'
);

select is(
  (
    select relpersistence::text
    from pg_class relation
    join pg_namespace schema on schema.oid = relation.relnamespace
    where schema.nspname = 'pgmq' and relation.relname = 'a_pipeline_jobs'
  ),
  'p',
  'archive queue table is durable/logged'
);

select ok(to_regnamespace('pgmq_public') is null, 'pgmq_public is not exposed');
select ok(not has_schema_privilege('anon', 'pgmq', 'usage'), 'anon cannot use pgmq');
select ok(not has_schema_privilege('authenticated', 'pgmq', 'usage'), 'authenticated cannot use pgmq');
select ok(not has_schema_privilege('service_role', 'pgmq', 'usage'), 'service_role cannot bypass queue RPCs');

select ok(
  not has_table_privilege('service_role', 'public.pipeline_runs', 'select'),
  'service_role has no generic run read privilege'
);
select ok(
  not has_table_privilege('service_role', 'public.pipeline_runs', 'update'),
  'service_role has no generic run mutation privilege'
);
select ok(
  has_table_privilege('authenticated', 'public.pipeline_runs', 'select'),
  'authenticated sellers may read RLS-scoped runs'
);
select ok(
  has_column_privilege('authenticated', 'public.pipeline_runs', 'user_id', 'insert'),
  'authenticated sellers may create an own-item run with the narrow columns'
);
select ok(
  not has_table_privilege('authenticated', 'public.pipeline_runs', 'update'),
  'authenticated sellers cannot mutate run state directly'
);

select ok(
  has_function_privilege('service_role', 'public.enqueue_pipeline_message(uuid,smallint)', 'execute'),
  'service_role has the enqueue capability'
);
select ok(
  not has_function_privilege('authenticated', 'public.enqueue_pipeline_message(uuid,smallint)', 'execute'),
  'authenticated cannot enqueue directly'
);
select ok(
  has_function_privilege('service_role', 'public.claim_pipeline_messages(integer,integer)', 'execute'),
  'service_role has the claim capability'
);
select ok(
  not has_function_privilege('authenticated', 'public.claim_pipeline_messages(integer,integer)', 'execute'),
  'authenticated cannot claim work'
);
select ok(
  has_function_privilege('service_role', 'public.ack_pipeline_message(bigint)', 'execute'),
  'service_role has the acknowledge capability'
);
select ok(
  not has_function_privilege('authenticated', 'public.ack_pipeline_message(bigint)', 'execute'),
  'authenticated cannot acknowledge work'
);
select ok(
  not has_function_privilege('service_role', 'public.load_pipeline_run_worker_context(uuid)', 'execute'),
  'service_role cannot invoke the retired unfenced context reader'
);
select ok(
  not has_function_privilege('authenticated', 'public.load_pipeline_run_worker_context(uuid)', 'execute'),
  'authenticated cannot invoke worker tenant context reads'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.pipeline_runs'::regclass),
  'pipeline_runs has RLS enabled'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.pipeline_runs'::regclass
      and conname = 'pipeline_runs_user_idempotency_key_key'
      and contype = 'u'
  ),
  'tenant idempotency is unique'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.pipeline_runs'::regclass
      and conname = 'pipeline_runs_item_user_fkey'
      and contype = 'f'
  ),
  'run item ownership has a composite foreign key'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.pipeline_runs'::regclass
      and conname = 'pipeline_runs_listing_item_user_fkey'
      and contype = 'f'
  ),
  'run listing ownership has a composite foreign key'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.pipeline_runs'::regclass
      and conname = 'pipeline_runs_status_check'
      and contype = 'c'
  ),
  'run statuses are constrained'
);
select ok(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.pipeline_runs'::regclass
      and tgname = 'pipeline_runs_enforce_transition'
      and not tgisinternal
  ),
  'legal state transitions are database-enforced'
);

select * from finish();
rollback;
