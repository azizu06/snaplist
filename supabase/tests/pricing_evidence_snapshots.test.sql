begin;

select plan(24);

select ok(
  has_table_privilege('authenticated', 'public.pricing_evidence_snapshots', 'select'),
  'authenticated sellers may read pricing evidence through tenant RLS'
);
select ok(
  not has_table_privilege('authenticated', 'public.pricing_evidence_snapshots', 'insert'),
  'authenticated sellers cannot create evidence snapshots'
);
select ok(
  not has_table_privilege('authenticated', 'public.pricing_evidence_snapshots', 'update'),
  'authenticated sellers cannot mutate evidence snapshots'
);
select ok(
  not has_table_privilege('authenticated', 'public.pricing_evidence_snapshots', 'delete'),
  'authenticated sellers cannot delete evidence snapshots directly'
);

select ok(
  not has_table_privilege('service_role', 'public.pricing_evidence_snapshots', 'select'),
  'worker identity cannot bypass the run-scoped completion capability to read snapshots'
);
select ok(
  not has_table_privilege('service_role', 'public.pricing_evidence_snapshots', 'insert'),
  'worker identity cannot bypass durable completion to create snapshots'
);
select ok(
  not has_table_privilege('service_role', 'public.pricing_evidence_snapshots', 'update'),
  'worker identity cannot mutate evidence snapshots'
);
select ok(
  not has_table_privilege('service_role', 'public.pricing_evidence_snapshots', 'delete'),
  'worker identity cannot delete evidence snapshots'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.pricing_evidence_snapshots'::regclass),
  'pricing evidence snapshots enforce row level security'
);
select ok(
  exists (
    select 1
    from pg_policy
    where polrelid = 'public.pricing_evidence_snapshots'::regclass
      and polname = 'pricing_evidence_snapshots_select_own'
  ),
  'pricing evidence has one tenant-select policy'
);
select ok(
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.pricing_evidence_snapshots'::regclass
      and tgname = 'prevent_pricing_evidence_snapshot_update'
      and not tgisinternal
  ),
  'database rejects every snapshot update'
);

select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.pricing_evidence_snapshots'::regclass
      and conname = 'pricing_evidence_snapshots_run_fkey'
  ),
  'snapshot tenant and item identity is bound to its durable run'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.pricing_evidence_snapshots'::regclass
      and conname = 'pricing_evidence_snapshots_prediction_fkey'
  ),
  'snapshot is bound to its same-run prediction log'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.pricing_evidence_snapshots'::regclass
      and conname = 'pricing_evidence_snapshots_listing_fkey'
  ),
  'snapshot is bound to its same-run listing'
);

select ok(
  not has_function_privilege(
    'service_role',
    'private.pricing_evidence_rows_coarse(jsonb)',
    'execute'
  ),
  'worker identity cannot invoke the private evidence validator directly'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.complete_pipeline_run(uuid,uuid,jsonb)',
    'execute'
  ),
  'worker identity persists snapshots only through lease-fenced completion'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.complete_pipeline_run(uuid,uuid,jsonb)',
    'execute'
  ),
  'authenticated sellers cannot invoke durable completion'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.regenerate_review_listing(uuid,uuid,uuid,uuid,uuid,jsonb,text,jsonb,text,text,jsonb,numeric,jsonb,numeric,text,text,text,text,jsonb,boolean,boolean)',
    'execute'
  ),
  'the correction seam without evidence is retired'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.regenerate_review_listing_with_credit(uuid,uuid,uuid,uuid,uuid,jsonb,text,jsonb,text,text,jsonb,numeric,jsonb,numeric,text,text,text,text,jsonb,boolean,boolean)',
    'execute'
  ),
  'the credit correction seam without evidence is retired'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.authorize_ai_item_guided_correction(uuid,uuid,uuid,uuid,uuid,text,timestamptz)',
    'execute'
  ),
  'authenticated correction may mint a bound short-lived capability'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.authorize_ai_item_guided_correction(uuid,uuid,uuid,uuid,uuid,text,timestamptz)',
    'execute'
  ),
  'anonymous callers cannot mint correction capabilities'
);
select ok(
  has_function_privilege(
    'service_role', 'public.complete_guided_review_correction(text,jsonb)', 'execute'
  ),
  'the internal role may invoke only the fixed correction completion'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.complete_guided_review_correction(text,jsonb)', 'execute'
  ),
  'authenticated callers cannot invoke privileged completion'
);
select ok(
  not has_table_privilege(
    'service_role', 'private.guided_correction_completion_capabilities', 'select'
  ) and not has_table_privilege(
    'authenticated', 'private.guided_correction_completion_capabilities', 'select'
  ),
  'capability digests are inaccessible outside fixed functions'
);

select * from finish();
rollback;
