begin;

select plan(9);

select extensions.has_function(
  'public',
  'get_pipeline_run_retry_projection',
  array['uuid'],
  'authenticated durable-run retry projection exists'
);
select extensions.ok(
  (
    select procedure.prosecdef
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = 'get_pipeline_run_retry_projection'
      and procedure.pronargs = 1
  ),
  'retry projection is SECURITY DEFINER with an internal Clerk tenant predicate'
);
select extensions.is(
  (
    select procedure.provolatile::text
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = 'get_pipeline_run_retry_projection'
      and procedure.pronargs = 1
  ),
  's',
  'retry projection is a stable read'
);
select extensions.ok(
  has_function_privilege(
    'authenticated',
    'public.get_pipeline_run_retry_projection(uuid)',
    'execute'
  ),
  'authenticated sellers may read their retry projection'
);
select extensions.ok(
  not has_function_privilege(
    'anon',
    'public.get_pipeline_run_retry_projection(uuid)',
    'execute'
  ),
  'anonymous callers cannot read retry projections'
);
select extensions.ok(
  not has_function_privilege(
    'service_role',
    'public.get_pipeline_run_retry_projection(uuid)',
    'execute'
  ),
  'service role has no mobile retry-projection capability'
);
select extensions.has_function(
  'private',
  'get_manual_retry_credit_projection',
  array['uuid', 'text'],
  'canonical manual-retry accounting has one shared projection'
);
select extensions.ok(
  not has_function_privilege(
    'authenticated',
    'private.get_manual_retry_credit_projection(uuid,text)',
    'execute'
  ),
  'authenticated sellers cannot invoke the private accounting helper'
);
select extensions.ok(
  not has_function_privilege(
    'service_role',
    'private.get_manual_retry_credit_projection(uuid,text)',
    'execute'
  ),
  'service role cannot invoke the private accounting helper'
);

select * from finish();

rollback;
