begin;

select plan(20);

select ok(
  has_function_privilege('service_role', 'public.defer_pipeline_message(bigint,integer)', 'execute'),
  'service_role may defer one claimed queue message'
);
select ok(
  not has_function_privilege('authenticated', 'public.defer_pipeline_message(bigint,integer)', 'execute'),
  'authenticated sellers cannot change queue visibility'
);
select ok(
  has_function_privilege('service_role', 'public.claim_pipeline_run_attempt(uuid,bigint,integer)', 'execute'),
  'service_role may claim a message-paired run attempt'
);
select ok(
  not has_function_privilege('authenticated', 'public.claim_pipeline_run_attempt(uuid,bigint,integer)', 'execute'),
  'authenticated sellers cannot claim worker attempts'
);
select ok(
  has_function_privilege('service_role', 'public.checkpoint_pipeline_run(uuid,uuid,text,jsonb,integer)', 'execute'),
  'service_role may checkpoint a lease-fenced attempt'
);
select ok(
  not has_function_privilege('authenticated', 'public.checkpoint_pipeline_run(uuid,uuid,text,jsonb,integer)', 'execute'),
  'authenticated sellers cannot write worker checkpoints'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.complete_pipeline_run_with_guest_recovery(uuid,uuid,jsonb,jsonb)',
    'execute'
  )
  and not has_function_privilege(
    'service_role',
    'public.complete_pipeline_run(uuid,uuid,jsonb)',
    'execute'
  ),
  'service_role completes only through the lease-fenced recovery-aware seam'
);
select ok(
  not has_function_privilege('authenticated', 'public.complete_pipeline_run(uuid,uuid,jsonb)', 'execute'),
  'authenticated sellers cannot invoke durable completion'
);
select ok(
  has_function_privilege('service_role', 'public.finish_pipeline_run_attempt(uuid,uuid,boolean,integer,text,text)', 'execute'),
  'service_role may persist a lease-fenced retry or failure'
);
select ok(
  has_function_privilege('service_role', 'public.reject_pipeline_message(uuid,bigint,text,text)', 'execute'),
  'service_role may reject only a message-paired malformed job'
);

select ok(
  not has_function_privilege('service_role', 'public.load_pipeline_run_worker_context(uuid)', 'execute'),
  'service_role cannot use the retired unfenced context reader'
);
select ok(
  not has_function_privilege('service_role', 'public.transition_pipeline_run(uuid,text,text,text,integer,text,text)', 'execute'),
  'service_role cannot use the retired unfenced transition helper'
);
select ok(
  not has_function_privilege('service_role', 'public.link_pipeline_run_listing(uuid,uuid)', 'execute'),
  'service_role cannot use the retired unfenced listing linker'
);
select ok(
  not has_function_privilege('service_role', 'private.pipeline_worker_context_json(uuid)', 'execute'),
  'service_role cannot invoke the private worker context helper directly'
);
select ok(
  not has_table_privilege('service_role', 'public.pipeline_runs', 'update'),
  'worker identity has no generic run mutation privilege'
);

select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.pipeline_runs'::regclass
      and conname = 'pipeline_runs_checkpoint_check'
      and contype = 'c'
  ),
  'checkpoint shape and size are database constrained'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.pipeline_runs'::regclass
      and conname = 'pipeline_runs_lease_state_check'
      and contype = 'c'
  ),
  'active lease state is database constrained'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.pipeline_runs'::regclass
      and conname = 'pipeline_runs_retry_time_check'
      and contype = 'c'
  ),
  'retry scheduling state is database constrained'
);
select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'listings'
      and indexname = 'listings_run_id_unique_idx'
      and indexdef like 'CREATE UNIQUE INDEX%WHERE (run_id IS NOT NULL)'
  ),
  'one listing is enforced for each durable run'
);
select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'prediction_logs'
      and indexname = 'prediction_logs_run_id_unique_idx'
      and indexdef like 'CREATE UNIQUE INDEX%WHERE (run_id IS NOT NULL)'
  ),
  'one prediction log is enforced for each durable run'
);

select * from finish();
rollback;
