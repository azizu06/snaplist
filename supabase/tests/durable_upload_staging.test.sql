begin;

select plan(16);

select has_column('public', 'pipeline_runs', 'batch_id', 'pipeline runs carry a recovery batch id');
select has_column('public', 'pipeline_runs', 'batch_position', 'pipeline runs carry stable batch order');
select has_column('public', 'pipeline_runs', 'capture_input', 'pipeline runs carry a safe capture snapshot');
select has_table('private', 'pipeline_run_usage_reservations', 'run-keyed usage reservations exist');

select col_is_pk(
  'private',
  'pipeline_run_usage_reservations',
  'run_id',
  'each run has one idempotent usage reservation'
);

select has_function(
  'public',
  'stage_pipeline_batch',
  array['text', 'uuid', 'jsonb', 'integer', 'integer'],
  'fixed staging RPC exists'
);
select has_function(
  'public',
  'release_pipeline_run_daily_reservation',
  array['uuid'],
  'run-keyed release RPC exists'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.stage_pipeline_batch(text,uuid,jsonb,integer,integer)',
    'execute'
  ),
  'service role may stage runs'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.stage_pipeline_batch(text,uuid,jsonb,integer,integer)',
    'execute'
  ),
  'sellers cannot invoke the privileged producer RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.release_pipeline_run_daily_reservation(uuid)',
    'execute'
  ),
  'service role may release terminal daily capacity'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.release_pipeline_run_daily_reservation(uuid)',
    'execute'
  ),
  'sellers cannot release capacity directly'
);

select ok(
  not has_table_privilege(
    'service_role',
    'private.pipeline_run_usage_reservations',
    'select'
  ),
  'service role cannot bypass the reservation RPCs'
);
select ok(
  not has_table_privilege(
    'authenticated',
    'private.pipeline_run_usage_reservations',
    'select'
  ),
  'sellers cannot read internal reservations'
);
select ok(
  exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'pipeline_runs'
  ),
  'pipeline run progress is available through Realtime'
);
select ok(
  exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'pipeline_runs_user_batch_created_at_idx'
  ),
  'batch recovery lookup is indexed'
);
select ok(
  exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'pipeline_runs_user_batch_position_idx'
      and indexdef like 'CREATE UNIQUE INDEX%'
  ),
  'batch position is unique within a seller batch'
);

select * from finish();
rollback;
