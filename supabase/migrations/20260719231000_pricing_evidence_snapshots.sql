-- Issue #240: preserve the exact accepted sold evidence for one durable run and
-- expose it through tenant RLS without ever reconstructing facts from citations.

create or replace function private.pricing_evidence_rows_coarse(p_evidence jsonb)
returns boolean
language plpgsql
immutable
security definer
set search_path = ''
as $$
begin
  if jsonb_typeof(p_evidence) is distinct from 'array'
    or jsonb_array_length(p_evidence) > 60
    or octet_length(p_evidence::text) > 131072 then
    return false;
  end if;
  return not exists (
    select 1 from jsonb_array_elements(p_evidence) row_value
    where jsonb_typeof(row_value) is distinct from 'object'
  );
end;
$$;

revoke all on function private.pricing_evidence_rows_coarse(jsonb)
  from public, anon, authenticated, service_role;

create unique index if not exists pipeline_runs_id_item_user_id_idx
  on public.pipeline_runs (id, item_id, user_id);
create unique index if not exists prediction_logs_id_run_item_user_id_idx
  on public.prediction_logs (id, run_id, item_id, user_id);
create unique index if not exists listings_id_item_user_id_idx
  on public.listings (id, item_id, user_id);

create table public.pricing_evidence_snapshots (
  run_id uuid primary key,
  pipeline_run_id uuid,
  run_kind text not null,
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
  constraint pricing_evidence_snapshots_run_kind_check check (
    (run_kind = 'pipeline' and pipeline_run_id = run_id)
    or (run_kind = 'review-correction' and pipeline_run_id is null)
  ),
  constraint pricing_evidence_snapshots_item_check check (
    jsonb_typeof(item) = 'object'
    and octet_length(item::text) <= 4096
  ),
  constraint pricing_evidence_snapshots_price_result_check check (
    jsonb_typeof(price_result) = 'object'
    and not (price_result ? 'evidence')
    and octet_length(price_result::text) <= 65536
  ),
  constraint pricing_evidence_snapshots_evidence_check
    check (private.pricing_evidence_rows_coarse(evidence)),
  constraint pricing_evidence_snapshots_run_fkey
    foreign key (pipeline_run_id, item_id, user_id)
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
  'Immutable tenant-owned pricing recommendation and accepted sold evidence for one coherent pipeline or guided-correction run.';
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

-- The authenticated browser never receives a raw persistence seam. It may only
-- mint one short-lived opaque capability after the existing settled-credit and
-- unchanged-photo correction authority succeeds. Only a SHA-256 digest is kept.
create unique index if not exists ai_item_credit_reservations_id_user_item_idx
  on public.ai_item_credit_reservations (id, user_id, item_id);

create table private.guided_correction_completion_capabilities (
  reservation_id uuid primary key,
  token_hash text not null unique,
  user_id text not null,
  item_id uuid not null,
  listing_id uuid not null,
  completion_run_id uuid not null unique,
  expected_run_id uuid,
  expected_review_revision uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint guided_correction_capability_reservation_fkey
    foreign key (reservation_id, user_id, item_id)
    references public.ai_item_credit_reservations (id, user_id, item_id)
    on delete cascade,
  constraint guided_correction_capability_listing_fkey
    foreign key (listing_id, item_id, user_id)
    references public.listings (id, item_id, user_id)
    on delete cascade,
  constraint guided_correction_capability_hash_check
    check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint guided_correction_capability_expiry_check check (
    expires_at > created_at and expires_at <= created_at + interval '5 minutes'
  ),
  constraint guided_correction_capability_consumed_check check (
    consumed_at is null or consumed_at >= created_at
  )
);

revoke all on table private.guided_correction_completion_capabilities
  from public, anon, authenticated, service_role;

-- Retire every authenticated writer that accepted a pricing snapshot directly.
revoke execute on function public.regenerate_review_listing(
  uuid, uuid, uuid, uuid, uuid, jsonb, text, jsonb, text, text, jsonb, numeric,
  jsonb, numeric, text, text, text, text, jsonb, boolean, boolean
) from authenticated;
revoke execute on function public.regenerate_review_listing_with_credit(
  uuid, uuid, uuid, uuid, uuid, jsonb, text, jsonb, text, text, jsonb, numeric,
  jsonb, numeric, text, text, text, text, jsonb, boolean, boolean
) from authenticated;

drop function if exists public.authorize_ai_item_guided_correction(uuid, uuid);

create or replace function public.authorize_ai_item_guided_correction(
  p_item_id uuid,
  p_listing_id uuid,
  p_completion_run_id uuid,
  p_expected_run_id uuid,
  p_expected_review_revision uuid,
  p_completion_token text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_photo_paths text[];
  v_photo_set_fingerprint text;
  v_reservation public.ai_item_credit_reservations%rowtype;
  v_now timestamptz := statement_timestamp();
begin
  if coalesce(v_user_id, '') = '' then
    raise exception using errcode = '42501', message = 'Authentication required.';
  end if;
  if p_item_id is null or p_listing_id is null or p_completion_run_id is null
    or p_expected_review_revision is null
    or p_completion_run_id is not distinct from p_expected_run_id
    or p_completion_token !~ '^[A-Za-z0-9_-]{43}$'
    or p_expires_at <= v_now
    or p_expires_at > v_now + interval '5 minutes' then
    raise exception using errcode = '22023', message = 'Guided correction capability request is invalid.';
  end if;

  select item.photos into v_photo_paths
  from public.items item
  where item.id = p_item_id
    and item.user_id = v_user_id
    and item.review_revision is not distinct from p_expected_review_revision
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Review changed. Reload and try again.';
  end if;

  perform 1 from public.listings listing
  where listing.id = p_listing_id
    and listing.item_id = p_item_id
    and listing.user_id = v_user_id
    and listing.platform = 'ebay'
    and listing.run_id is not distinct from p_expected_run_id
    and listing.status is distinct from 'published'
    and listing.ebay_listing_id is null
    and listing.ebay_status is distinct from 'publishing'
    and listing.ebay_status is distinct from 'published'
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Editable eBay listing not found.';
  end if;

  v_photo_set_fingerprint := encode(
    sha256(convert_to(array_to_json(v_photo_paths)::text, 'UTF8')), 'hex'
  );
  select * into v_reservation
  from public.ai_item_credit_reservations reservation
  where reservation.user_id = v_user_id
    and reservation.item_id = p_item_id
    and reservation.state = 'settled'
    and reservation.photo_set_fingerprint = v_photo_set_fingerprint
  order by reservation.settled_at desc
  limit 1
  for update;
  if not found or v_reservation.guided_correction_completed_at is not null then
    raise exception using errcode = 'P0001', message = 'The included guided correction is unavailable.';
  end if;

  update public.ai_item_credit_reservations
  set guided_correction_revision = p_expected_review_revision,
      guided_correction_started_at = v_now,
      updated_at = v_now
  where id = v_reservation.id
    and guided_correction_completed_at is null;

  insert into private.guided_correction_completion_capabilities (
    reservation_id, token_hash, user_id, item_id, listing_id,
    completion_run_id, expected_run_id, expected_review_revision,
    created_at, expires_at, consumed_at
  ) values (
    v_reservation.id,
    encode(sha256(convert_to(p_completion_token, 'UTF8')), 'hex'),
    v_user_id, p_item_id, p_listing_id, p_completion_run_id,
    p_expected_run_id, p_expected_review_revision, v_now, p_expires_at, null
  )
  on conflict (reservation_id) do update
  set token_hash = excluded.token_hash,
      listing_id = excluded.listing_id,
      completion_run_id = excluded.completion_run_id,
      expected_run_id = excluded.expected_run_id,
      expected_review_revision = excluded.expected_review_revision,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at,
      consumed_at = null;

  return jsonb_build_object('expiresAt', p_expires_at);
end;
$$;

revoke all on function public.authorize_ai_item_guided_correction(
  uuid, uuid, uuid, uuid, uuid, text, timestamptz
) from public, anon, service_role;
grant execute on function public.authorize_ai_item_guided_correction(
  uuid, uuid, uuid, uuid, uuid, text, timestamptz
) to authenticated;

create or replace function public.complete_guided_review_correction(
  p_completion_token text,
  p_commit jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cap private.guided_correction_completion_capabilities%rowtype;
  v_reservation public.ai_item_credit_reservations%rowtype;
  v_item public.items%rowtype;
  v_listing public.listings%rowtype;
  v_item_payload jsonb;
  v_listing_payload jsonb;
  v_prediction jsonb;
  v_snapshot jsonb;
  v_prediction_id uuid;
  v_evidence jsonb;
  v_now timestamptz := statement_timestamp();
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Guided correction completion authorization is required';
  end if;
  if p_completion_token !~ '^[A-Za-z0-9_-]{43}$'
    or jsonb_typeof(p_commit) is distinct from 'object'
    or octet_length(p_commit::text) > 524288 then
    raise exception using errcode = '22023', message = 'Invalid guided correction completion';
  end if;

  select * into v_cap
  from private.guided_correction_completion_capabilities capability
  where capability.token_hash = encode(
    sha256(convert_to(p_completion_token, 'UTF8')), 'hex'
  )
  for update;
  if not found or v_cap.consumed_at is not null or v_cap.expires_at <= v_now then
    raise exception using errcode = 'P0001', message = 'Guided correction capability is unavailable';
  end if;
  if p_commit->>'item_id' is distinct from v_cap.item_id::text
    or p_commit->>'listing_id' is distinct from v_cap.listing_id::text
    or p_commit->>'run_id' is distinct from v_cap.completion_run_id::text
    or p_commit->>'expected_run_id' is distinct from v_cap.expected_run_id::text
    or p_commit->>'expected_review_revision'
      is distinct from v_cap.expected_review_revision::text then
    raise exception using errcode = '42501', message = 'Guided correction capability binding mismatch';
  end if;

  v_item_payload := p_commit->'item';
  v_listing_payload := p_commit->'listing';
  v_prediction := p_commit->'prediction';
  v_snapshot := p_commit->'pricing_snapshot';
  if jsonb_typeof(v_item_payload) is distinct from 'object'
    or jsonb_typeof(v_item_payload->'attributes') is distinct from 'object'
    or jsonb_typeof(v_item_payload->'identification') is distinct from 'object'
    or octet_length(v_item_payload::text) > 131072
    or jsonb_typeof(v_listing_payload) is distinct from 'object'
    or octet_length(v_listing_payload::text) > 131072
    or v_listing_payload->>'platform' is distinct from 'ebay'
    or nullif(btrim(v_listing_payload->>'title'), '') is null
    or char_length(v_listing_payload->>'title') > 80
    or nullif(btrim(v_listing_payload->>'description'), '') is null
    or jsonb_typeof(v_listing_payload->'copy') is distinct from 'object'
    or jsonb_typeof(v_prediction) is distinct from 'object'
    or octet_length(v_prediction::text) > 131072
    or jsonb_typeof(v_prediction->'extracted_attrs') is distinct from 'object'
    or jsonb_typeof(v_prediction->'price_range') is distinct from 'object'
    or jsonb_typeof(v_prediction->'sources') is distinct from 'array'
    or (v_prediction->>'price')::numeric <= 0
    or (v_prediction->>'confidence')::numeric not between 0 and 1
    or (v_prediction->>'autopilot_enabled')::boolean is distinct from false
    or (v_prediction->>'autopilot_eligible')::boolean is distinct from false
    or jsonb_typeof(v_snapshot) is distinct from 'object'
    or (v_snapshot->>'schema_version')::integer is distinct from 1
    or jsonb_typeof(v_snapshot->'item') is distinct from 'object'
    or jsonb_typeof(v_snapshot->'price_result') is distinct from 'object'
    or v_snapshot->'price_result' ? 'evidence'
    or not private.pricing_evidence_rows_coarse(v_snapshot->'evidence')
    or octet_length(v_snapshot::text) > 262144 then
    raise exception using errcode = '22023', message = 'Invalid guided correction completion';
  end if;

  perform 1
  from public.ai_item_credit_reservations reservation
  join public.items item
    on item.id = reservation.item_id and item.user_id = reservation.user_id
  join public.listings listing
    on listing.id = v_cap.listing_id
   and listing.item_id = item.id and listing.user_id = item.user_id
  where reservation.id = v_cap.reservation_id
    and reservation.user_id = v_cap.user_id
    and reservation.item_id = v_cap.item_id
    and reservation.state = 'settled'
    and reservation.guided_correction_revision
      is not distinct from v_cap.expected_review_revision
    and reservation.guided_correction_completed_at is null
    and reservation.photo_set_fingerprint = encode(
      sha256(convert_to(array_to_json(item.photos)::text, 'UTF8')), 'hex'
    )
    and item.review_revision is not distinct from v_cap.expected_review_revision
    and listing.platform = 'ebay'
    and listing.run_id is not distinct from v_cap.expected_run_id
    and listing.status is distinct from 'published'
    and listing.ebay_listing_id is null
    and listing.ebay_status is distinct from 'publishing'
    and listing.ebay_status is distinct from 'published'
  for update of reservation, item, listing;
  if not found then
    raise exception using errcode = 'P0002', message = 'Guided correction authority changed';
  end if;

  if v_prediction->'extracted_attrs' is distinct from v_item_payload->'attributes'
    or v_snapshot #> '{price_result,suggested}' is distinct from v_prediction->'price'
    or v_snapshot #> '{price_result,range,min}' is distinct from v_prediction #> '{price_range,low}'
    or v_snapshot #> '{price_result,range,max}' is distinct from v_prediction #> '{price_range,high}'
    or v_snapshot #>> '{price_result,tier}' is distinct from v_prediction->>'tier_fired'
    or v_snapshot #> '{price_result,sources}' is distinct from v_prediction->'sources' then
    raise exception using errcode = '22023', message = 'Guided correction persistence is incoherent';
  end if;

  update public.items
  set attributes = v_item_payload->'attributes',
      condition = v_item_payload->>'condition',
      identification = v_item_payload->'identification',
      review_revision = v_cap.completion_run_id,
      review_content_revision = v_cap.completion_run_id
  where id = v_cap.item_id and user_id = v_cap.user_id;

  update public.listings
  set title = v_listing_payload->>'title',
      description = v_listing_payload->>'description',
      copy = v_listing_payload->'copy',
      status = 'draft',
      run_id = v_cap.completion_run_id,
      source_review_revision = v_cap.completion_run_id,
      ebay_publish_claim_id = null,
      ebay_publish_claimed_at = null
  where id = v_cap.listing_id
    and item_id = v_cap.item_id and user_id = v_cap.user_id
    and run_id is not distinct from v_cap.expected_run_id
    and status is distinct from 'published'
    and ebay_listing_id is null
    and ebay_status is distinct from 'publishing'
    and ebay_status is distinct from 'published';
  if not found then
    raise exception using errcode = 'P0002', message = 'Editable eBay listing not found.';
  end if;

  insert into public.prediction_logs (
    user_id, item_id, run_id, extracted_attrs, price, price_range, confidence,
    tier_fired, model, listing_model, pricing_model, sources,
    autopilot_enabled, autopilot_eligible
  ) values (
    v_cap.user_id, v_cap.item_id, v_cap.completion_run_id,
    v_prediction->'extracted_attrs', (v_prediction->>'price')::numeric,
    v_prediction->'price_range', (v_prediction->>'confidence')::numeric,
    v_prediction->>'tier_fired', v_prediction->>'model',
    v_prediction->>'listing_model', v_prediction->>'pricing_model',
    v_prediction->'sources', false, false
  ) returning id into v_prediction_id;

  delete from public.listings
  where item_id = v_cap.item_id and user_id = v_cap.user_id
    and platform in ('facebook', 'mercari');

  select coalesce(
    jsonb_agg(
      evidence_row.value || jsonb_build_object('evidenceAsOf', v_now)
      order by evidence_row.ordinality
    ), '[]'::jsonb
  ) into v_evidence
  from jsonb_array_elements(v_snapshot->'evidence') with ordinality evidence_row;

  insert into public.pricing_evidence_snapshots (
    run_id, pipeline_run_id, run_kind, user_id, item_id,
    prediction_id, listing_id, schema_version,
    item, price_result, evidence, evidence_as_of
  ) values (
    v_cap.completion_run_id, null, 'review-correction', v_cap.user_id,
    v_cap.item_id, v_prediction_id, v_cap.listing_id, 1,
    v_snapshot->'item', v_snapshot->'price_result', v_evidence, v_now
  );

  update public.ai_item_credit_reservations
  set guided_correction_completed_at = v_now, updated_at = v_now
  where id = v_cap.reservation_id and guided_correction_completed_at is null;
  if not found then
    raise exception using errcode = '55000', message = 'Guided correction completion was already recorded.';
  end if;

  update private.guided_correction_completion_capabilities
  set consumed_at = v_now
  where reservation_id = v_cap.reservation_id and consumed_at is null;
  if not found then
    raise exception using errcode = '55000', message = 'Guided correction capability was already consumed.';
  end if;
  return true;
end;
$$;

revoke all on function public.complete_guided_review_correction(text, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_guided_review_correction(text, jsonb)
  to service_role;

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
  v_evidence_as_of timestamptz;
  v_completed_at timestamptz := statement_timestamp();
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
    or v_snapshot->'price_result' ? 'evidence'
    or not private.pricing_evidence_rows_coarse(v_snapshot->'evidence')
    or octet_length(v_snapshot::text) > 262144 then
    raise exception using errcode = '22023', message = 'Invalid pricing evidence snapshot';
  end if;
  if v_snapshot #> '{price_result,suggested}'
      is distinct from p_persistence #> '{prediction,price}'
    or v_snapshot #> '{price_result,range,min}'
      is distinct from p_persistence #> '{prediction,price_range,low}'
    or v_snapshot #> '{price_result,range,max}'
      is distinct from p_persistence #> '{prediction,price_range,high}'
    or v_snapshot #>> '{price_result,tier}'
      is distinct from p_persistence #>> '{prediction,tier_fired}'
    or v_snapshot #> '{price_result,sources}'
      is distinct from p_persistence #> '{prediction,sources}' then
    raise exception using errcode = '22023', message = 'Pipeline persistence is incoherent';
  end if;
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
  if jsonb_typeof(v_run.checkpoint #> '{priced,evidenceAsOf}') is distinct from 'string' then
    raise exception using errcode = '22023', message = 'Pipeline pricing checkpoint is invalid';
  end if;
  v_evidence_as_of := (v_run.checkpoint #>> '{priced,evidenceAsOf}')::timestamptz;

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
    run_id, pipeline_run_id, run_kind, user_id, item_id,
    prediction_id, listing_id, schema_version,
    item, price_result, evidence, evidence_as_of
  ) values (
    v_run.id, v_run.id, 'pipeline', v_run.user_id, v_run.item_id,
    v_prediction_id, v_listing_id,
    1, v_snapshot->'item', v_snapshot->'price_result', v_evidence,
    v_evidence_as_of
  );

  update public.pipeline_runs
  set listing_id = v_listing_id,
      status = 'succeeded',
      stage = 'completed',
      completed_at = v_completed_at,
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
