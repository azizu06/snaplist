begin;

select plan(25);

select ok(
  not has_function_privilege(
    'service_role',
    'private.enforce_credited_item_photo_set_immutable()',
    'execute'
  ),
  'service role cannot invoke the credited-photo trigger helper directly'
);
select ok(
  not has_table_privilege(
    'service_role',
    'private.pipeline_storage_cleanup_jobs',
    'insert'
  ),
  'service role cannot forge the private retention capability'
);

create temporary table credited_retention_fixture (
  label text primary key,
  user_id text not null,
  run_id uuid not null unique,
  item_id uuid not null unique,
  reservation_id uuid,
  allowance_period_id uuid,
  initial_photos text[],
  reservation_before jsonb,
  allowance_period_before jsonb
) on commit drop;
grant select on credited_retention_fixture to anon, authenticated;
grant select, insert, update on credited_retention_fixture to service_role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into credited_retention_fixture (
  label,
  user_id,
  run_id,
  item_id,
  initial_photos
)
select
  fixture.label,
  fixture.user_id,
  staged.run_id,
  staged.item_id,
  array[fixture.photo_path]
from (
  values
    (
      'eligible-failed',
      'credited-retention-failed-user',
      'credited-retention-failed-user/items/front.jpg'
    ),
    (
      'eligible-canceled',
      'credited-retention-canceled-user',
      'credited-retention-canceled-user/items/front.jpg'
    ),
    (
      'settled-success',
      'credited-retention-success-user',
      'credited-retention-success-user/items/front.jpg'
    ),
    (
      'active-leased',
      'credited-retention-active-user',
      'credited-retention-active-user/items/front.jpg'
    ),
    (
      'recent-terminal',
      'credited-retention-recent-user',
      'credited-retention-recent-user/items/front.jpg'
    ),
    (
      'retryable-sibling',
      'credited-retention-retry-user',
      'credited-retention-retry-user/items/front.jpg'
    ),
    (
      'leased-sibling',
      'credited-retention-lease-user',
      'credited-retention-lease-user/items/front.jpg'
    ),
    (
      'foreign-active',
      'credited-retention-foreign-user',
      'credited-retention-foreign-user/items/front.jpg'
    )
) as fixture(label, user_id, photo_path)
cross join lateral public.stage_pipeline_batch(
  fixture.user_id,
  gen_random_uuid(),
  jsonb_build_array(jsonb_build_object(
    'idempotency_key', 'issue-227-' || fixture.label,
    'source', 'single',
    'autopilot_enabled', false,
    'photo_paths', jsonb_build_array(fixture.photo_path),
    'cost_basis', null
  )),
  100,
  100
) staged;

reset role;

update public.pipeline_runs run
set status = 'running',
    stage = 'identifying',
    attempt_count = 1,
    started_at = statement_timestamp() - interval '31 days',
    last_attempted_at = statement_timestamp() - interval '31 days',
    lease_token = gen_random_uuid(),
    lease_expires_at = statement_timestamp() + interval '5 minutes'
from credited_retention_fixture fixture
where run.id = fixture.run_id;

update public.items item
set attributes = '{"brand":"protected"}'::jsonb,
    condition = 'good',
    identification = '{"label":"Protected item","confident":true}'::jsonb
from credited_retention_fixture fixture
where fixture.label = 'settled-success'
  and item.id = fixture.item_id;

insert into public.prediction_logs (
  user_id,
  item_id,
  run_id,
  extracted_attrs,
  price,
  price_range,
  confidence,
  tier_fired,
  model,
  listing_model,
  sources,
  autopilot_enabled,
  autopilot_eligible
)
select
  fixture.user_id,
  fixture.item_id,
  fixture.run_id,
  '{"brand":"protected"}'::jsonb,
  100,
  '{"min":90,"max":110}'::jsonb,
  0.9,
  'llm-only',
  'test-vision',
  'test-listing',
  '[]'::jsonb,
  false,
  false
from credited_retention_fixture fixture
where fixture.label = 'settled-success';

insert into public.listings (
  id,
  user_id,
  item_id,
  platform,
  title,
  description,
  copy,
  status,
  run_id
)
select
  '22700000-0000-4000-8000-000000000010'::uuid,
  fixture.user_id,
  fixture.item_id,
  'ebay',
  'Protected item',
  'Protected successful listing retained by issue 227.',
  '{"itemSpecifics":{"Brand":"protected"}}'::jsonb,
  'draft',
  fixture.run_id
from credited_retention_fixture fixture
where fixture.label = 'settled-success';

update public.pipeline_runs run
set listing_id = '22700000-0000-4000-8000-000000000010'::uuid
from credited_retention_fixture fixture
where fixture.label = 'settled-success'
  and run.id = fixture.run_id;

update public.pipeline_runs run
set status = 'succeeded',
    stage = 'completed',
    completed_at = statement_timestamp() - interval '31 days',
    lease_token = null,
    lease_expires_at = null
from credited_retention_fixture fixture
where fixture.label = 'settled-success'
  and run.id = fixture.run_id;

update public.pipeline_runs run
set status = case
      when fixture.label = 'eligible-canceled' then 'canceled'
      else 'failed'
    end,
    failure_code = case
      when fixture.label = 'eligible-canceled' then null
      else 'provider_unavailable'
    end,
    safe_failure_message = case
      when fixture.label = 'eligible-canceled' then null
      else 'The listing could not be prepared.'
    end,
    completed_at = case
      when fixture.label = 'recent-terminal'
        then statement_timestamp() - interval '1 day'
      else statement_timestamp() - interval '31 days'
    end,
    lease_token = null,
    lease_expires_at = null
from credited_retention_fixture fixture
where fixture.label in (
    'eligible-failed',
    'eligible-canceled',
    'recent-terminal',
    'retryable-sibling',
    'leased-sibling'
  )
  and run.id = fixture.run_id;

create temporary table credited_retention_sibling (
  label text primary key,
  run_id uuid not null unique,
  item_id uuid not null
) on commit drop;

insert into credited_retention_sibling (label, run_id, item_id)
select
  fixture.label,
  gen_random_uuid(),
  fixture.item_id
from credited_retention_fixture fixture
where fixture.label in ('retryable-sibling', 'leased-sibling');

insert into public.pipeline_runs (
  id,
  user_id,
  item_id,
  idempotency_key
)
select
  sibling.run_id,
  fixture.user_id,
  fixture.item_id,
  'issue-227-' || fixture.label || '-secondary'
from credited_retention_sibling sibling
join credited_retention_fixture fixture using (label);

update public.pipeline_runs run
set status = 'running',
    stage = 'identifying',
    attempt_count = 1,
    started_at = statement_timestamp() - interval '1 day',
    last_attempted_at = statement_timestamp() - interval '1 day',
    lease_token = gen_random_uuid(),
    lease_expires_at = statement_timestamp() + interval '5 minutes'
from credited_retention_sibling sibling
where run.id = sibling.run_id;

update public.pipeline_runs run
set status = 'failed',
    failure_code = 'provider_unavailable',
    safe_failure_message = 'The listing could not be prepared.',
    completed_at = statement_timestamp() - interval '1 day',
    lease_token = null,
    lease_expires_at = null
from credited_retention_sibling sibling
where sibling.label = 'retryable-sibling'
  and run.id = sibling.run_id;

update credited_retention_fixture fixture
set reservation_id = reservation.id,
    allowance_period_id = reservation.allowance_period_id,
    reservation_before = to_jsonb(reservation),
    allowance_period_before = to_jsonb(period)
from public.ai_item_credit_reservations reservation
join public.ai_item_allowance_periods period
  on period.id = reservation.allowance_period_id
where reservation.pipeline_run_id = fixture.run_id;

select is(
  (
    select reservation.state
    from public.ai_item_credit_reservations reservation
    join credited_retention_fixture fixture
      on fixture.reservation_id = reservation.id
    where fixture.label = 'eligible-failed'
  ),
  'restored',
  'a failed credited run is restored before retention'
);
select is(
  (
    select reservation.state
    from public.ai_item_credit_reservations reservation
    join credited_retention_fixture fixture
      on fixture.reservation_id = reservation.id
    where fixture.label = 'eligible-canceled'
  ),
  'restored',
  'a canceled credited run is restored before retention'
);
select is(
  (
    select reservation.state
    from public.ai_item_credit_reservations reservation
    join credited_retention_fixture fixture
      on fixture.reservation_id = reservation.id
    where fixture.label = 'settled-success'
  ),
  'settled',
  'a successful credited run is settled before retention'
);
select is(
  (
    select reservation.state
    from public.ai_item_credit_reservations reservation
    join credited_retention_fixture fixture
      on fixture.reservation_id = reservation.id
    where fixture.label = 'active-leased'
  ),
  'reserved',
  'an active leased run keeps its reservation before retention'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table credited_retention_result on commit drop as
select public.prepare_pipeline_retention(100) as value;
reset role;

select is(
  (
    select (value->>'storageJobsQueued')::integer
    from credited_retention_result
  ),
  2,
  'only the eligible failed and canceled captures queue Storage cleanup'
);
select is(
  (
    select cardinality(item.photos)
    from public.items item
    join credited_retention_fixture fixture on fixture.item_id = item.id
    where fixture.label = 'eligible-failed'
  ),
  0,
  'eligible credited failed-run photos are released'
);
select is(
  (
    select cardinality(item.photos)
    from public.items item
    join credited_retention_fixture fixture on fixture.item_id = item.id
    where fixture.label = 'eligible-canceled'
  ),
  0,
  'eligible credited canceled-run photos are released'
);
select is(
  (
    select count(*)::integer
    from private.pipeline_storage_cleanup_jobs job
    join credited_retention_fixture fixture on fixture.item_id = job.source_id
    where fixture.label in ('eligible-failed', 'eligible-canceled')
      and job.source_type = 'abandoned_item'
  ),
  2,
  'each released credited photo set has one durable exact-path cleanup job'
);
select is(
  (
    select count(*)::integer
    from private.pipeline_storage_cleanup_jobs job
    join credited_retention_fixture fixture on fixture.item_id = job.source_id
    where fixture.label in ('eligible-failed', 'eligible-canceled')
      and job.photo_paths is not distinct from fixture.initial_photos
  ),
  2,
  'cleanup jobs preserve both exact ordered captured photo sets'
);
select results_eq(
  $$
    select fixture.label, item.photos
    from credited_retention_fixture fixture
    join public.items item on item.id = fixture.item_id
    where fixture.label in (
      'active-leased',
      'foreign-active',
      'leased-sibling',
      'recent-terminal',
      'retryable-sibling',
      'settled-success'
    )
    order by fixture.label
  $$,
  $$
    select fixture.label, fixture.initial_photos
    from credited_retention_fixture fixture
    where fixture.label in (
      'active-leased',
      'foreign-active',
      'leased-sibling',
      'recent-terminal',
      'retryable-sibling',
      'settled-success'
    )
    order by fixture.label
  $$,
  'active, foreign, leased, recent, retryable-sibling, and successful photos stay protected'
);
select is(
  (
    select item.photos
    from public.items item
    join credited_retention_fixture fixture on fixture.item_id = item.id
    where fixture.label = 'settled-success'
  ),
  (
    select initial_photos
    from credited_retention_fixture
    where label = 'settled-success'
  ),
  'successful listing photos remain available'
);
select is(
  (
    select count(*)::integer
    from public.pipeline_runs run
    join credited_retention_fixture fixture on fixture.run_id = run.id
    where fixture.label in ('eligible-failed', 'eligible-canceled')
      and run.retention_cleaned_at is not null
      and run.capture_input is null
  ),
  2,
  'eligible terminal runs become non-retryable accounting tombstones'
);
select is(
  (
    select jsonb_agg(to_jsonb(reservation) order by fixture.label)
    from credited_retention_fixture fixture
    join public.ai_item_credit_reservations reservation
      on reservation.id = fixture.reservation_id
  ),
  (
    select jsonb_agg(fixture.reservation_before order by fixture.label)
    from credited_retention_fixture fixture
  ),
  'retention leaves every settled, restored, and reserved credit row byte-stable'
);
select is(
  (
    select jsonb_agg(to_jsonb(period) order by fixture.label)
    from credited_retention_fixture fixture
    join public.ai_item_allowance_periods period
      on period.id = fixture.allowance_period_id
  ),
  (
    select jsonb_agg(fixture.allowance_period_before order by fixture.label)
    from credited_retention_fixture fixture
  ),
  'retention leaves allowance history byte-stable'
);
select is(
  (
    select count(*)::integer
    from public.ai_item_credit_reservations reservation
    join credited_retention_fixture fixture on fixture.reservation_id = reservation.id
  ),
  8,
  'retention preserves every durable reservation row'
);
select is(
  (
    select count(*)::integer
    from public.ai_item_credit_reservations reservation
    join credited_retention_fixture fixture on fixture.reservation_id = reservation.id
    where reservation.photo_set_fingerprint = encode(
      sha256(convert_to(array_to_json(fixture.initial_photos)::text, 'UTF8')),
      'hex'
    )
  ),
  8,
  'every immutable captured photo-set fingerprint remains unchanged'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"credited-retention-recent-user","role":"authenticated"}',
  true
);
select throws_ok(
  $$
    update public.items item
    set photos = '{}'::text[]
    from credited_retention_fixture fixture
    where fixture.label = 'recent-terminal'
      and item.id = fixture.item_id
  $$,
  '23514',
  'A credited item photo set is immutable; start a new AI-item run',
  'authenticated sellers still cannot clear a credited photo set'
);
reset role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$
    update public.items item
    set photos = '{}'::text[]
    from credited_retention_fixture fixture
    where fixture.label = 'recent-terminal'
      and item.id = fixture.item_id
  $$,
  '23514',
  'A credited item photo set is immutable; start a new AI-item run',
  'service role still cannot clear a credited photo set directly'
);
select throws_ok(
  $$
    update public.items item
    set photos = array['credited-retention-failed-user/items/replacement.jpg']
    from credited_retention_fixture fixture
    where fixture.label = 'eligible-failed'
      and item.id = fixture.item_id
  $$,
  '23514',
  'A credited item photo set is immutable; start a new AI-item run',
  'the same-transaction retention capability cannot be reused for another photo mutation'
);
reset role;

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select lives_ok(
  $$
    update public.items item
    set photos = '{}'::text[]
    from credited_retention_fixture fixture
    where fixture.label = 'foreign-active'
      and item.id = fixture.item_id
  $$,
  'anonymous updates fail closed without exposing credited photo rows'
);
reset role;
select is(
  (
    select item.photos
    from public.items item
    join credited_retention_fixture fixture on fixture.item_id = item.id
    where fixture.label = 'foreign-active'
  ),
  (
    select initial_photos
    from credited_retention_fixture
    where label = 'foreign-active'
  ),
  'anonymous callers cannot change a foreign tenant credited photo set'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table credited_retention_second_result on commit drop as
select public.prepare_pipeline_retention(100) as value;
reset role;

select is(
  (
    select (value->>'storageJobsQueued')::integer
    from credited_retention_second_result
  ),
  0,
  'a repeated retention pass cannot queue or release the same photo set twice'
);
select is(
  (
    select jsonb_agg(to_jsonb(reservation) order by fixture.label)
    from credited_retention_fixture fixture
    join public.ai_item_credit_reservations reservation
      on reservation.id = fixture.reservation_id
  ),
  (
    select jsonb_agg(fixture.reservation_before order by fixture.label)
    from credited_retention_fixture fixture
  ),
  'repeated retention still cannot change credit history'
);

select * from finish();
rollback;
