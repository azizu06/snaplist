begin;

select plan(18);

select has_column(
  'public', 'items', 'photo_identity_kind',
  'items version their logical photo-set identity'
);
select has_column(
  'public', 'items', 'photo_identity_fingerprint',
  'items persist the logical photo-set fingerprint'
);
select has_column(
  'public', 'pipeline_runs', 'photo_identity_kind',
  'pipeline runs version their logical photo-set identity'
);
select has_column(
  'public', 'pipeline_runs', 'photo_identity_fingerprint',
  'pipeline runs persist the logical photo-set fingerprint'
);
select has_column(
  'public', 'ai_item_credit_reservations', 'photo_identity_kind',
  'credit reservations version their logical photo-set identity'
);
select has_column(
  'public', 'ai_item_credit_reservations', 'photo_identity_fingerprint',
  'credit reservations retain the logical photo-set fingerprint'
);

select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.items'::regclass
      and conname = 'items_photo_identity_kind_check'
  ),
  'item photo identity kind is constrained'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.pipeline_runs'::regclass
      and conname = 'pipeline_runs_photo_identity_kind_check'
  ),
  'run photo identity kind is constrained'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.ai_item_credit_reservations'::regclass
      and conname = 'ai_item_credit_reservations_photo_identity_kind_check'
  ),
  'reservation photo identity kind is constrained'
);

select has_function(
  'public',
  'stage_pipeline_batch',
  array['text', 'uuid', 'jsonb', 'integer', 'integer', 'jsonb'],
  'fixed staging seam accepts verified photo identities'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.stage_pipeline_batch(text,uuid,jsonb,integer,integer,jsonb)',
    'execute'
  ),
  'service role may use the fixed verified-identity staging seam'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.stage_pipeline_batch(text,uuid,jsonb,integer,integer,jsonb)',
    'execute'
  ),
  'sellers cannot forge verified photo identities'
);

select ok(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.items'::regclass
      and tgname = 'enforce_photo_identity_immutable'
      and not tgisinternal
  ),
  'item photo identity has an immutable trigger'
);
select ok(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.pipeline_runs'::regclass
      and tgname = 'enforce_photo_identity_immutable'
      and not tgisinternal
  ),
  'run photo identity has an immutable trigger'
);
select ok(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.ai_item_credit_reservations'::regclass
      and tgname = 'enforce_photo_identity_immutable'
      and not tgisinternal
  ),
  'reservation photo identity has an immutable trigger'
);

select ok(
  not has_function_privilege(
    'service_role', 'private.assign_item_photo_identity()', 'execute'
  ),
  'service role cannot invoke item identity assignment directly'
);
select ok(
  not has_function_privilege(
    'service_role', 'private.assign_pipeline_run_photo_identity()', 'execute'
  ),
  'service role cannot invoke run identity assignment directly'
);
select ok(
  not has_function_privilege(
    'service_role', 'private.enforce_photo_identity_immutable()', 'execute'
  ),
  'service role cannot invoke identity immutability directly'
);

select * from finish();

rollback;
