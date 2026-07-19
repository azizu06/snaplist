-- Issue #240: preserve the exact accepted sold evidence for one durable run and
-- expose it through tenant RLS without ever reconstructing facts from citations.

create or replace function private.pricing_evidence_rows_valid(p_evidence jsonb)
returns boolean
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
begin
  if jsonb_typeof(p_evidence) is distinct from 'array'
    or jsonb_array_length(p_evidence) > 60
    or octet_length(p_evidence::text) > 131072 then
    return false;
  end if;

  for v_row in select value from jsonb_array_elements(p_evidence)
  loop
    if jsonb_typeof(v_row) is distinct from 'object'
      or not (v_row ?& array[
        'id', 'sourceUrl', 'price', 'currency', 'kind', 'priceDisclosure'
      ])
      or jsonb_typeof(v_row->'id') is distinct from 'string'
      or char_length(v_row->>'id') not between 1 and 2048
      or jsonb_typeof(v_row->'sourceUrl') is distinct from 'string'
      or char_length(v_row->>'sourceUrl') not between 1 and 2048
      or (v_row->>'sourceUrl') !~ '^https?://[^[:space:]]+$'
      or jsonb_typeof(v_row->'price') is distinct from 'number'
      or (v_row->>'price')::numeric <= 0
      or jsonb_typeof(v_row->'currency') is distinct from 'string'
      or (v_row->>'currency') !~ '^[A-Z]{3}$'
      or v_row->>'kind' is distinct from 'sold-comparable'
      or v_row->>'priceDisclosure' is distinct from 'displayed-sold-price'
      or (
        v_row ? 'title'
        and (
          jsonb_typeof(v_row->'title') is distinct from 'string'
          or char_length(v_row->>'title') not between 1 and 500
        )
      )
      or (
        v_row ? 'condition'
        and (
          jsonb_typeof(v_row->'condition') is distinct from 'string'
          or char_length(v_row->>'condition') not between 1 and 120
        )
      )
      or (
        v_row ? 'soldAt'
        and (
          jsonb_typeof(v_row->'soldAt') is distinct from 'number'
          or (v_row->>'soldAt')::numeric < 0
        )
      ) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

revoke all on function private.pricing_evidence_rows_valid(jsonb)
  from public, anon, authenticated, service_role;

create unique index if not exists pipeline_runs_id_item_user_id_idx
  on public.pipeline_runs (id, item_id, user_id);
create unique index if not exists prediction_logs_id_run_item_user_id_idx
  on public.prediction_logs (id, run_id, item_id, user_id);
create unique index if not exists listings_id_item_user_id_idx
  on public.listings (id, item_id, user_id);

create table public.pricing_evidence_snapshots (
  run_id uuid primary key,
  user_id text not null,
  item_id uuid not null,
  prediction_id uuid not null,
  listing_id uuid not null,
  schema_version smallint not null,
  item jsonb not null,
  price_result jsonb not null,
  evidence jsonb not null,
  evidence_as_of timestamptz not null,

  constraint pricing_evidence_snapshots_schema_version_check
    check (schema_version = 1),
  constraint pricing_evidence_snapshots_item_check check (
    jsonb_typeof(item) = 'object'
    and jsonb_typeof(item->'title') = 'string'
    and char_length(item->>'title') between 1 and 500
    and (
      not (item ? 'condition')
      or (
        jsonb_typeof(item->'condition') = 'string'
        and char_length(item->>'condition') between 1 and 120
      )
    )
    and octet_length(item::text) <= 4096
  ),
  constraint pricing_evidence_snapshots_price_result_check check (
    jsonb_typeof(price_result) = 'object'
    and octet_length(price_result::text) <= 65536
  ),
  constraint pricing_evidence_snapshots_evidence_check
    check (private.pricing_evidence_rows_valid(evidence)),
  constraint pricing_evidence_snapshots_run_fkey
    foreign key (run_id, item_id, user_id)
    references public.pipeline_runs (id, item_id, user_id)
    on delete cascade,
  constraint pricing_evidence_snapshots_prediction_fkey
    foreign key (prediction_id, run_id, item_id, user_id)
    references public.prediction_logs (id, run_id, item_id, user_id)
    on delete cascade,
  -- The listing identity stays tenant/item-bound, while #173 guided correction
  -- may legitimately rebind that editable listing to a newer correction run.
  -- Historical snapshot/run coherence remains anchored by pipeline_runs and
  -- prediction_logs and by the immutable listing_id recorded at completion.
  constraint pricing_evidence_snapshots_listing_fkey
    foreign key (listing_id, item_id, user_id)
    references public.listings (id, item_id, user_id)
    on delete cascade
);

comment on table public.pricing_evidence_snapshots is
  'Immutable tenant-owned pricing recommendation and accepted sold evidence for one coherent durable pipeline run.';
comment on column public.pricing_evidence_snapshots.evidence_as_of is
  'One server timestamp applied to every accepted evidence row in this immutable snapshot.';

create index pricing_evidence_snapshots_user_item_as_of_idx
  on public.pricing_evidence_snapshots (user_id, item_id, evidence_as_of desc, run_id desc);

alter table public.pricing_evidence_snapshots enable row level security;

revoke all on table public.pricing_evidence_snapshots
  from public, anon, authenticated, service_role;
grant select on table public.pricing_evidence_snapshots to authenticated;

create policy pricing_evidence_snapshots_select_own
  on public.pricing_evidence_snapshots
  for select
  to authenticated
  using ((select public.clerk_user_id()) = user_id);

create or replace function private.prevent_pricing_evidence_snapshot_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'Pricing evidence snapshots are immutable';
end;
$$;

revoke all on function private.prevent_pricing_evidence_snapshot_update()
  from public, anon, authenticated, service_role;

create trigger prevent_pricing_evidence_snapshot_update
before update on public.pricing_evidence_snapshots
for each row execute function private.prevent_pricing_evidence_snapshot_update();

create or replace function public.complete_pipeline_run(
  p_run_id uuid,
  p_lease_token uuid,
  p_persistence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.pipeline_runs%rowtype;
  v_listing_id uuid;
  v_prediction_id uuid;
  v_listing_status text;
  v_autopilot_enabled boolean;
  v_snapshot jsonb;
  v_evidence jsonb;
  v_evidence_as_of timestamptz := statement_timestamp();
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Pipeline worker authorization is required';
  end if;
  if jsonb_typeof(p_persistence) is distinct from 'object'
    or jsonb_typeof(p_persistence->'item') is distinct from 'object'
    or jsonb_typeof(p_persistence->'listing') is distinct from 'object'
    or jsonb_typeof(p_persistence->'prediction') is distinct from 'object'
    or jsonb_typeof(p_persistence->'pricing_snapshot') is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Invalid pipeline persistence payload';
  end if;
  v_snapshot := p_persistence->'pricing_snapshot';
  if (v_snapshot->>'schema_version')::integer is distinct from 1
    or jsonb_typeof(v_snapshot->'item') is distinct from 'object'
    or jsonb_typeof(v_snapshot->'price_result') is distinct from 'object'
    or not private.pricing_evidence_rows_valid(v_snapshot->'evidence') then
    raise exception using errcode = '22023', message = 'Invalid pricing evidence snapshot';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_snapshot->'evidence') evidence_row
    where not exists (
      select 1
      from jsonb_array_elements(v_snapshot #> '{price_result,sources}') source_row
      where source_row->>'url' = evidence_row->>'sourceUrl'
    )
  ) then
    raise exception using errcode = '22023', message = 'Pricing evidence is not grounded in cited sources';
  end if;
  select coalesce(
    jsonb_agg(
      evidence_row.value
      || jsonb_build_object('evidenceAsOf', v_evidence_as_of)
      order by evidence_row.ordinality
    ),
    '[]'::jsonb
  )
  into v_evidence
  from jsonb_array_elements(v_snapshot->'evidence') with ordinality evidence_row;

  v_listing_status := p_persistence #>> '{listing,status}';
  if v_listing_status not in ('draft', 'queued') then
    raise exception using errcode = '22023', message = 'Pipeline worker may create drafts only';
  end if;

  select * into v_run
  from public.pipeline_runs
  where id = p_run_id
    and status = 'running'
    and lease_token = p_lease_token
    and lease_expires_at > now()
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'Pipeline worker lease is stale';
  end if;
  v_autopilot_enabled := coalesce(
    (to_jsonb(v_run) #>> '{capture_input,autopilot_enabled}')::boolean,
    v_run.autopilot_enabled
  );
  if (p_persistence #>> '{prediction,autopilot_enabled}')::boolean
    is distinct from v_autopilot_enabled then
    raise exception using errcode = '22023', message = 'Pipeline run configuration mismatch';
  end if;
  if not (v_run.checkpoint ? 'identified')
    or not (v_run.checkpoint ? 'priced')
    or not (v_run.checkpoint ? 'generated') then
    raise exception using errcode = '55000', message = 'Pipeline worker checkpoints are incomplete';
  end if;

  update public.pipeline_runs set stage = 'persisting' where id = p_run_id;

  update public.items
  set attributes = p_persistence #> '{item,attributes}',
      condition = p_persistence #>> '{item,condition}',
      identification = nullif(p_persistence #> '{item,identification}', 'null'::jsonb)
  where id = v_run.item_id and user_id = v_run.user_id;
  if not found then
    raise exception using errcode = '23503', message = 'Pipeline run item ownership changed';
  end if;

  insert into public.prediction_logs (
    user_id, item_id, run_id, extracted_attrs, price, price_range, confidence,
    tier_fired, model, listing_model, pricing_model, sources,
    autopilot_enabled, autopilot_eligible
  ) values (
    v_run.user_id, v_run.item_id, v_run.id,
    p_persistence #> '{prediction,extracted_attrs}',
    (p_persistence #>> '{prediction,price}')::numeric,
    p_persistence #> '{prediction,price_range}',
    (p_persistence #>> '{prediction,confidence}')::numeric,
    p_persistence #>> '{prediction,tier_fired}',
    p_persistence #>> '{prediction,model}',
    p_persistence #>> '{prediction,listing_model}',
    p_persistence #>> '{prediction,pricing_model}',
    p_persistence #> '{prediction,sources}',
    (p_persistence #>> '{prediction,autopilot_enabled}')::boolean,
    (p_persistence #>> '{prediction,autopilot_eligible}')::boolean
  )
  on conflict (run_id) where run_id is not null do update
  set extracted_attrs = excluded.extracted_attrs,
      price = excluded.price,
      price_range = excluded.price_range,
      confidence = excluded.confidence,
      tier_fired = excluded.tier_fired,
      model = excluded.model,
      listing_model = excluded.listing_model,
      pricing_model = excluded.pricing_model,
      sources = excluded.sources,
      autopilot_enabled = excluded.autopilot_enabled,
      autopilot_eligible = excluded.autopilot_eligible
  where prediction_logs.user_id = v_run.user_id
    and prediction_logs.item_id = v_run.item_id
  returning id into v_prediction_id;
  if v_prediction_id is null then
    raise exception using errcode = '23505', message = 'Pipeline prediction identity conflict';
  end if;

  insert into public.listings (
    user_id, item_id, platform, title, description, copy, status, run_id
  ) values (
    v_run.user_id, v_run.item_id,
    p_persistence #>> '{listing,platform}',
    p_persistence #>> '{listing,title}',
    p_persistence #>> '{listing,description}',
    p_persistence #> '{listing,copy}',
    v_listing_status,
    v_run.id
  )
  on conflict (run_id) where run_id is not null do update
  set platform = excluded.platform,
      title = excluded.title,
      description = excluded.description,
      copy = excluded.copy,
      status = excluded.status
  where listings.user_id = v_run.user_id
    and listings.item_id = v_run.item_id
    and listings.status in ('draft', 'queued')
    and listings.ebay_listing_id is null
    and listings.ebay_status is distinct from 'publishing'
    and listings.ebay_status is distinct from 'published'
  returning id into v_listing_id;
  if v_listing_id is null then
    raise exception using errcode = '23505', message = 'Pipeline listing identity conflict';
  end if;

  insert into public.pricing_evidence_snapshots (
    run_id, user_id, item_id, prediction_id, listing_id, schema_version,
    item, price_result, evidence, evidence_as_of
  ) values (
    v_run.id, v_run.user_id, v_run.item_id, v_prediction_id, v_listing_id,
    1, v_snapshot->'item', v_snapshot->'price_result', v_evidence,
    v_evidence_as_of
  );

  update public.pipeline_runs
  set listing_id = v_listing_id,
      status = 'succeeded',
      stage = 'completed',
      completed_at = v_evidence_as_of,
      failure_code = null,
      safe_failure_message = null,
      next_attempt_at = null,
      lease_token = null,
      lease_expires_at = null
  where id = p_run_id;

  return jsonb_build_object('listingId', v_listing_id);
end;
$$;

revoke all on function public.complete_pipeline_run(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_pipeline_run(uuid, uuid, jsonb)
  to service_role;
