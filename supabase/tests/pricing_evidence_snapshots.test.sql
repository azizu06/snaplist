begin;

select plan(36);

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

-- A schema-first restore recreates the current catalog before loading immutable
-- V1 rows. Keep one fully coherent historical review-correction fixture here so
-- later validator changes cannot silently redefine already-valid backup data.
insert into public.items (id, user_id, attributes, condition)
values (
  '36600000-0000-4000-8000-000000000001',
  'issue-366-legacy-restore',
  '{"brand":"Sony","model":"WH-1000XM4"}',
  'Used'
);

insert into public.listings (
  id, user_id, item_id, platform, title, description, copy, status, run_id
) values (
  '36600000-0000-4000-8000-000000000004',
  'issue-366-legacy-restore',
  '36600000-0000-4000-8000-000000000001',
  'ebay',
  'Sony WH-1000XM4 Headphones',
  'A coherent historical listing used only for schema-first restore coverage.',
  '{"itemSpecifics":{"Brand":"Sony","Model":"WH-1000XM4"}}',
  'draft',
  '36600000-0000-4000-8000-000000000002'
);

insert into public.prediction_logs (
  id, user_id, item_id, run_id, extracted_attrs, price, price_range,
  confidence, tier_fired, model, listing_model, pricing_model, sources,
  autopilot_enabled, autopilot_eligible
) values (
  '36600000-0000-4000-8000-000000000003',
  'issue-366-legacy-restore',
  '36600000-0000-4000-8000-000000000001',
  '36600000-0000-4000-8000-000000000002',
  '{"brand":"Sony","model":"WH-1000XM4"}',
  102,
  '{"low":99,"high":104}',
  0.8,
  'ebay-sold',
  'legacy-vision',
  'legacy-listing',
  'legacy-pricing',
  (
    select jsonb_agg(
      jsonb_build_object(
        'url', format('https://www.ebay.com/itm/legacy-sale-%s', ordinal),
        'title', format('Verified legacy sale %s', ordinal),
        'kind', 'sold-comp'
      ) order by ordinal
    )
    from generate_series(1, 6) ordinal
  ),
  false,
  false
);

select lives_ok(
  $$
    insert into public.pricing_evidence_snapshots (
      run_id, pipeline_run_id, run_kind, user_id, item_id, prediction_id,
      listing_id, schema_version, item, price_result, evidence, evidence_as_of
    ) values (
      '36600000-0000-4000-8000-000000000002',
      null,
      'review-correction',
      'issue-366-legacy-restore',
      '36600000-0000-4000-8000-000000000001',
      '36600000-0000-4000-8000-000000000003',
      '36600000-0000-4000-8000-000000000004',
      1,
      '{"title":"Sony WH-1000XM4","condition":"Used"}',
      jsonb_build_object(
        'suggested', 102,
        'range', jsonb_build_object('min', 99, 'max', 104),
        'confidence', 0.8,
        'sources', (
          select jsonb_agg(
            jsonb_build_object(
              'url', format('https://www.ebay.com/itm/legacy-sale-%s', ordinal),
              'title', format('Verified legacy sale %s', ordinal),
              'kind', 'sold-comp'
            ) order by ordinal
          )
          from generate_series(1, 6) ordinal
        ),
        'tier', 'ebay-sold',
        'compAgreement', 0.9
      ),
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', format('legacy-sale-%s', ordinal),
            'sourceUrl', format('https://www.ebay.com/itm/legacy-sale-%s', ordinal),
            'title', format('Verified legacy sale %s', ordinal),
            'price', 98 + ordinal,
            'currency', 'USD',
            'kind', 'sold-comparable',
            'priceDisclosure', 'displayed-sold-price',
            'evidenceAsOf', '2026-07-18T12:00:00+00:00'
          ) order by ordinal
        )
        from generate_series(1, 6) ordinal
      ),
      '2026-07-18T12:00:00+00:00'
    )
  $$,
  'schema-first restore accepts a coherent historical six-record V1 snapshot'
);

select ok(
  private.pricing_evidence_rows_coarse(
    (select jsonb_agg('{}'::jsonb) from generate_series(1, 60))
  ),
  'the historical V1 validator still accepts sixty evidence records'
);
select ok(
  not private.pricing_evidence_rows_coarse(
    (select jsonb_agg('{}'::jsonb) from generate_series(1, 61))
  ),
  'the historical V1 validator still rejects a sixty-first evidence record'
);
select ok(
  private.pricing_evidence_rows_current_write(
    (select jsonb_agg('{}'::jsonb) from generate_series(1, 5))
  ),
  'the current bounded-write validator accepts five verified sold matches'
);
select ok(
  not private.pricing_evidence_rows_current_write(
    (select jsonb_agg('{}'::jsonb) from generate_series(1, 6))
  ),
  'the current bounded-write validator rejects a sixth verified sold match'
);
select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.pricing_evidence_snapshots'::regclass
      and conname = 'pricing_evidence_snapshots_evidence_check'
      and position(
        'pricing_evidence_rows_coarse(evidence)'
        in pg_get_constraintdef(oid)
      ) > 0
  ),
  'the tenant-protected snapshot table keeps the historical V1 validator'
);
select ok(
  position(
    'pricing_evidence_rows_current_write'
    in pg_get_functiondef(
      'public.complete_pipeline_run(uuid,uuid,jsonb)'::regprocedure
    )
  ) > 0,
  'lease-fenced durable completion applies the current bounded-write validator'
);
select ok(
  position(
    'pricing_evidence_rows_current_write'
    in pg_get_functiondef(
      'public.complete_guided_review_correction(text,jsonb)'::regprocedure
    )
  ) > 0,
  'guided-correction completion applies the current bounded-write validator'
);

select ok(
  not has_function_privilege(
    'service_role',
    'private.pricing_evidence_rows_coarse(jsonb)',
    'execute'
  ) and not has_function_privilege(
    'service_role',
    'private.pricing_evidence_rows_current_write(jsonb)',
    'execute'
  ),
  'worker identity cannot invoke either private evidence validator directly'
);
select ok(
  not has_function_privilege(
    'service_role',
    'private.complete_pipeline_run_legacy_evidence_v1(uuid,uuid,jsonb)',
    'execute'
  ) and not has_function_privilege(
    'service_role',
    'private.complete_guided_review_correction_legacy_evidence_v1(text,jsonb)',
    'execute'
  ),
  'worker identity cannot bypass the bounded public completion wrappers'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.complete_pipeline_run_with_guest_recovery(uuid,uuid,jsonb,jsonb)',
    'execute'
  ) and not has_function_privilege(
    'service_role',
    'public.complete_pipeline_run(uuid,uuid,jsonb)',
    'execute'
  ),
  'worker identity persists snapshots only through recovery-aware lease-fenced completion'
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
select is(
  to_regprocedure(
    'public.regenerate_review_listing_with_evidence(uuid,uuid,uuid,uuid,uuid,jsonb,text,jsonb,text,text,jsonb,numeric,jsonb,numeric,text,text,text,text,jsonb,boolean,boolean,jsonb)'
  ),
  null::regprocedure,
  'the authenticated raw-snapshot correction writer is absent from the catalog'
);
select is(
  to_regprocedure(
    'public.regenerate_review_listing_with_credit_and_evidence(uuid,uuid,uuid,uuid,uuid,jsonb,text,jsonb,text,text,jsonb,numeric,jsonb,numeric,text,text,text,text,jsonb,boolean,boolean,jsonb)'
  ),
  null::regprocedure,
  'the authenticated raw-snapshot credit writer is absent from the catalog'
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
  position(
    'least(p_expires_at, v_now + interval ''5 minutes'')'
    in pg_get_functiondef(
      'public.authorize_ai_item_guided_correction(uuid,uuid,uuid,uuid,uuid,text,timestamptz)'::regprocedure
    )
  ) > 0,
  'correction capability expiry is capped by the database clock'
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
