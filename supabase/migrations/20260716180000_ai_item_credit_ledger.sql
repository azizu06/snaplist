-- Issue #168: monthly AI-item credit ledger.
--
-- The ledger is deliberately separate from request-rate and daily abuse guards.
-- A reservation belongs to one logical durable pipeline run, survives retries,
-- redelivery and checkpoint recovery, and becomes terminal exactly once when the
-- run either produces a coherent editable draft or ends before producing value.

create schema if not exists private;

create table public.ai_item_allowance_periods (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  source text not null,
  period_key text not null,
  original_transaction_id text,
  period_start timestamptz not null,
  expires_date timestamptz not null,
  grace_expires_date timestamptz,
  state text not null,
  allowance integer not null,
  last_event_id text,
  last_event_created_at timestamptz,
  verified_at timestamptz not null default statement_timestamp(),
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint ai_item_allowance_periods_identity_key
    unique (user_id, source, period_key),
  constraint ai_item_allowance_periods_source_check check (
    source in ('included', 'storekit')
  ),
  constraint ai_item_allowance_periods_state_check check (
    state in (
      'active', 'grace', 'billing_retry', 'expired', 'revoked', 'refunded',
      'ambiguous'
    )
  ),
  constraint ai_item_allowance_periods_allowance_check check (
    allowance between 1 and 10000
  ),
  constraint ai_item_allowance_periods_bounds_check check (
    period_start < expires_date
  ),
  constraint ai_item_allowance_periods_grace_check check (
    (
      state = 'grace'
      and grace_expires_date is not null
      and grace_expires_date > expires_date
    )
    or (state <> 'grace' and grace_expires_date is null)
  ),
  constraint ai_item_allowance_periods_source_identity_check check (
    (
      source = 'included'
      and period_key = 'included-first-run'
      and original_transaction_id is null
      and state = 'active'
      and allowance = 1
    )
    or (
      source = 'storekit'
      and coalesce(char_length(period_key), 0) between 1 and 255
      and coalesce(char_length(original_transaction_id), 0) between 1 and 255
    )
  ),
  constraint ai_item_allowance_periods_event_check check (
    (last_event_id is null and last_event_created_at is null and source = 'included')
    or (
      coalesce(char_length(last_event_id), 0) between 1 and 255
      and last_event_created_at is not null
      and source = 'storekit'
    )
  )
);

comment on table public.ai_item_allowance_periods is
  'Tenant-owned AI-item allowance windows. StoreKit rows accept already server-verified period facts; verification and client bridging remain issue #173.';
comment on column public.ai_item_allowance_periods.period_key is
  'Stable server-verified period identity. Callbacks for the same period update state without resetting usage.';
comment on column public.ai_item_allowance_periods.allowance is
  'Server-configured internal allowance. It is not a public launch pricing promise.';

create unique index ai_item_allowance_periods_id_user_id_idx
  on public.ai_item_allowance_periods (id, user_id);
create index ai_item_allowance_periods_user_period_idx
  on public.ai_item_allowance_periods (
    user_id, source, period_start desc, expires_date desc
  );
create unique index ai_item_allowance_periods_storekit_window_idx
  on public.ai_item_allowance_periods (
    user_id, original_transaction_id, period_start
  )
  where source = 'storekit';

alter table public.ai_item_allowance_periods enable row level security;
revoke all on table public.ai_item_allowance_periods
  from public, anon, authenticated, service_role;
grant select on table public.ai_item_allowance_periods to authenticated;
grant delete on table public.ai_item_allowance_periods to service_role;

create policy ai_item_allowance_periods_select_own
  on public.ai_item_allowance_periods
  for select
  to authenticated
  using ((select public.clerk_user_id()) = user_id);

-- Notification ids and normalized payload fingerprints are internal replay
-- protection. Raw signed StoreKit payloads do not belong in the credit ledger.
create table private.storekit_ai_item_period_events (
  event_id text primary key,
  user_id text not null,
  period_key text not null,
  payload_fingerprint text not null,
  event_created_at timestamptz not null,
  applied boolean not null default false,
  received_at timestamptz not null default statement_timestamp(),
  constraint storekit_ai_item_period_events_text_check check (
    char_length(event_id) between 1 and 255
    and char_length(period_key) between 1 and 255
    and payload_fingerprint ~ '^[0-9a-f]{32}$'
  )
);

create index storekit_ai_item_period_events_user_created_idx
  on private.storekit_ai_item_period_events (user_id, event_created_at desc);
revoke all on table private.storekit_ai_item_period_events
  from public, anon, authenticated, service_role;

create or replace function private.delete_storekit_credit_events_with_period()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.source = 'storekit' then
    delete from private.storekit_ai_item_period_events event
    where event.user_id = old.user_id
      and event.period_key = old.period_key;
  end if;
  return old;
end;
$$;

revoke all on function private.delete_storekit_credit_events_with_period()
  from public, anon, authenticated, service_role;

create trigger delete_storekit_credit_events_with_period
before delete on public.ai_item_allowance_periods
for each row execute function private.delete_storekit_credit_events_with_period();

create or replace function public.record_verified_storekit_ai_item_period(
  p_user_id text,
  p_period_key text,
  p_original_transaction_id text,
  p_period_start timestamptz,
  p_expires_date timestamptz,
  p_state text,
  p_grace_expires_date timestamptz,
  p_allowance integer,
  p_event_id text,
  p_event_created_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload_fingerprint text;
  v_existing_event private.storekit_ai_item_period_events%rowtype;
  v_existing_period public.ai_item_allowance_periods%rowtype;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Verified StoreKit period authorization is required';
  end if;
  if coalesce(char_length(p_user_id), 0) not between 1 and 255
    or coalesce(char_length(p_period_key), 0) not between 1 and 255
    or coalesce(char_length(p_original_transaction_id), 0) not between 1 and 255
    or coalesce(char_length(p_event_id), 0) not between 1 and 255
    or p_period_start is null
    or p_expires_date is null
    or p_period_start >= p_expires_date
    or p_state not in (
      'active', 'grace', 'billing_retry', 'expired', 'revoked', 'refunded',
      'ambiguous'
    )
    or p_allowance not between 1 and 10000
    or p_event_created_at is null
    or (
      p_state = 'grace'
      and (p_grace_expires_date is null or p_grace_expires_date <= p_expires_date)
    )
    or (p_state <> 'grace' and p_grace_expires_date is not null) then
    raise exception using
      errcode = '22023',
      message = 'Invalid verified StoreKit allowance period';
  end if;

  v_payload_fingerprint := md5(jsonb_build_object(
    'user_id', p_user_id,
    'period_key', p_period_key,
    'original_transaction_id', p_original_transaction_id,
    'period_start', p_period_start,
    'expires_date', p_expires_date,
    'state', p_state,
    'grace_expires_date', p_grace_expires_date,
    'allowance', p_allowance,
    'event_created_at', p_event_created_at
  )::text);

  perform pg_advisory_xact_lock(
    hashtextextended('ai-item-period:' || p_user_id, 0)
  );

  select * into v_existing_event
  from private.storekit_ai_item_period_events event
  where event.event_id = p_event_id
  for update;
  if found then
    if v_existing_event.user_id is distinct from p_user_id
      or v_existing_event.period_key is distinct from p_period_key
      or v_existing_event.payload_fingerprint is distinct from v_payload_fingerprint then
      raise exception using
        errcode = '23514',
        message = 'StoreKit period event identity conflicts';
    end if;
    return false;
  end if;

  insert into private.storekit_ai_item_period_events (
    event_id, user_id, period_key, payload_fingerprint, event_created_at
  ) values (
    p_event_id, p_user_id, p_period_key, v_payload_fingerprint, p_event_created_at
  );

  select * into v_existing_period
  from public.ai_item_allowance_periods period
  where period.user_id = p_user_id
    and period.source = 'storekit'
    and period.period_key = p_period_key
  for update;

  if found then
    if v_existing_period.original_transaction_id
        is distinct from p_original_transaction_id
      or v_existing_period.period_start is distinct from p_period_start
      or v_existing_period.expires_date is distinct from p_expires_date
      or v_existing_period.allowance is distinct from p_allowance then
      raise exception using
        errcode = '23514',
        message = 'StoreKit allowance period identity conflicts';
    end if;
    if p_event_created_at <= v_existing_period.last_event_created_at then
      return false;
    end if;
    if v_existing_period.state in ('revoked', 'refunded')
      and p_state not in ('revoked', 'refunded') then
      raise exception using
        errcode = '23514',
        message = 'Terminal StoreKit period state cannot reopen';
    end if;

    update public.ai_item_allowance_periods
    set state = p_state,
        grace_expires_date = p_grace_expires_date,
        last_event_id = p_event_id,
        last_event_created_at = p_event_created_at,
        verified_at = statement_timestamp(),
        updated_at = statement_timestamp()
    where id = v_existing_period.id;
  else
    insert into public.ai_item_allowance_periods (
      user_id,
      source,
      period_key,
      original_transaction_id,
      period_start,
      expires_date,
      grace_expires_date,
      state,
      allowance,
      last_event_id,
      last_event_created_at
    ) values (
      p_user_id,
      'storekit',
      p_period_key,
      p_original_transaction_id,
      p_period_start,
      p_expires_date,
      p_grace_expires_date,
      p_state,
      p_allowance,
      p_event_id,
      p_event_created_at
    );
  end if;

  update private.storekit_ai_item_period_events
  set applied = true
  where event_id = p_event_id;
  return true;
end;
$$;

revoke all on function public.record_verified_storekit_ai_item_period(
  text, text, text, timestamptz, timestamptz, text, timestamptz, integer, text,
  timestamptz
) from public, anon, authenticated;
grant execute on function public.record_verified_storekit_ai_item_period(
  text, text, text, timestamptz, timestamptz, text, timestamptz, integer, text,
  timestamptz
) to service_role;

create unique index if not exists pipeline_runs_id_user_item_idx
  on public.pipeline_runs (id, user_id, item_id);

create table public.ai_item_credit_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  pipeline_run_id uuid not null unique,
  item_id uuid not null,
  allowance_period_id uuid not null,
  logical_run_key text not null,
  photo_set_fingerprint text not null,
  state text not null default 'reserved',
  reserved_at timestamptz not null default statement_timestamp(),
  settled_at timestamptz,
  restored_at timestamptz,
  settled_review_revision uuid,
  listing_id uuid,
  prediction_log_id uuid,
  guided_correction_revision uuid,
  guided_correction_started_at timestamptz,
  guided_correction_completed_at timestamptz,
  updated_at timestamptz not null default statement_timestamp(),
  constraint ai_item_credit_reservations_logical_run_key
    unique (user_id, logical_run_key),
  constraint ai_item_credit_reservations_period_fkey
    foreign key (allowance_period_id, user_id)
    references public.ai_item_allowance_periods (id, user_id),
  constraint ai_item_credit_reservations_pipeline_run_fkey
    foreign key (pipeline_run_id, user_id, item_id)
    references public.pipeline_runs (id, user_id, item_id)
    on delete cascade,
  constraint ai_item_credit_reservations_state_check check (
    state in ('reserved', 'settled', 'restored')
  ),
  constraint ai_item_credit_reservations_key_check check (
    char_length(logical_run_key) between 1 and 128
    and photo_set_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint ai_item_credit_reservations_terminal_check check (
    (
      state = 'reserved'
      and settled_at is null
      and restored_at is null
      and settled_review_revision is null
      and listing_id is null
      and prediction_log_id is null
    )
    or (
      state = 'settled'
      and settled_at is not null
      and restored_at is null
      and settled_review_revision is not null
      and listing_id is not null
      and prediction_log_id is not null
    )
    or (
      state = 'restored'
      and settled_at is null
      and restored_at is not null
      and settled_review_revision is null
      and listing_id is null
      and prediction_log_id is null
    )
  ),
  constraint ai_item_credit_reservations_correction_check check (
    (
      guided_correction_revision is null
      and guided_correction_started_at is null
      and guided_correction_completed_at is null
    )
    or (
      state = 'settled'
      and guided_correction_revision is not null
      and guided_correction_started_at is not null
      and (
        guided_correction_completed_at is null
        or guided_correction_completed_at >= guided_correction_started_at
      )
    )
  )
);

comment on table public.ai_item_credit_reservations is
  'One tenant-owned credit reservation per logical complete AI-item run. Retries, recovery, redelivery and checkpoints reuse pipeline_run_id.';
comment on column public.ai_item_credit_reservations.photo_set_fingerprint is
  'SHA-256 of the immutable ordered storage-path set. Any add, remove, replace or reorder requires a new logical run.';

create index ai_item_credit_reservations_user_state_idx
  on public.ai_item_credit_reservations (user_id, state, reserved_at desc);
create index ai_item_credit_reservations_period_state_idx
  on public.ai_item_credit_reservations (allowance_period_id, state);
create index ai_item_credit_reservations_item_idx
  on public.ai_item_credit_reservations (user_id, item_id, settled_at desc);

alter table public.ai_item_credit_reservations enable row level security;
revoke all on table public.ai_item_credit_reservations
  from public, anon, authenticated, service_role;
grant select on table public.ai_item_credit_reservations to authenticated;
grant delete on table public.ai_item_credit_reservations to service_role;

create policy ai_item_credit_reservations_select_own
  on public.ai_item_credit_reservations
  for select
  to authenticated
  using ((select public.clerk_user_id()) = user_id);

create or replace function private.enforce_ai_item_credit_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
    new.user_id,
    new.pipeline_run_id,
    new.item_id,
    new.allowance_period_id,
    new.logical_run_key,
    new.photo_set_fingerprint,
    new.reserved_at
  ) is distinct from (
    old.user_id,
    old.pipeline_run_id,
    old.item_id,
    old.allowance_period_id,
    old.logical_run_key,
    old.photo_set_fingerprint,
    old.reserved_at
  ) then
    raise exception using
      errcode = '23514',
      message = 'AI-item credit reservation identity is immutable';
  end if;

  if new.state is distinct from old.state
    and not (old.state = 'reserved' and new.state in ('settled', 'restored')) then
    raise exception using
      errcode = '23514',
      message = format(
        'Illegal AI-item credit transition: %s -> %s', old.state, new.state
      );
  end if;

  if new.state is not distinct from old.state and (
    new.settled_at,
    new.restored_at,
    new.settled_review_revision,
    new.listing_id,
    new.prediction_log_id
  ) is distinct from (
    old.settled_at,
    old.restored_at,
    old.settled_review_revision,
    old.listing_id,
    old.prediction_log_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'AI-item credit terminal evidence is immutable';
  end if;

  if old.guided_correction_revision is not null
    and new.guided_correction_revision is distinct from old.guided_correction_revision then
    raise exception using
      errcode = '23514',
      message = 'Guided correction identity is immutable';
  end if;
  if old.guided_correction_started_at is not null
    and new.guided_correction_started_at is distinct from old.guided_correction_started_at then
    raise exception using
      errcode = '23514',
      message = 'Guided correction start is immutable';
  end if;
  if old.guided_correction_completed_at is not null
    and new.guided_correction_completed_at
        is distinct from old.guided_correction_completed_at then
    raise exception using
      errcode = '23514',
      message = 'Guided correction completion is immutable';
  end if;
  if new.updated_at < old.updated_at then
    raise exception using
      errcode = '23514',
      message = 'AI-item credit time cannot move backward';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_ai_item_credit_transition()
  from public, anon, authenticated, service_role;

create trigger enforce_ai_item_credit_transition
before update on public.ai_item_credit_reservations
for each row execute function private.enforce_ai_item_credit_transition();

-- Once a logical run owns a photo-set fingerprint, direct item mutation cannot
-- rewrite that identity underneath the reservation. A future full-reanalysis
-- seam must reserve a new credit and create its new logical run atomically.
create or replace function private.enforce_credited_item_photo_set_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.photos is distinct from old.photos
    and exists (
      select 1
      from public.ai_item_credit_reservations reservation
      where reservation.item_id = old.id
        and reservation.user_id = old.user_id
    ) then
    raise exception using
      errcode = '23514',
      message = 'A credited item photo set is immutable; start a new AI-item run';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_credited_item_photo_set_immutable()
  from public, anon, authenticated, service_role;

create trigger enforce_credited_item_photo_set_immutable
before update of photos on public.items
for each row execute function private.enforce_credited_item_photo_set_immutable();

create or replace function private.reserve_ai_item_credit_for_pipeline_run()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_photo_paths text[];
  v_photo_set_fingerprint text;
  v_period public.ai_item_allowance_periods%rowtype;
  v_used integer;
  v_existing public.ai_item_credit_reservations%rowtype;
  v_now timestamptz := statement_timestamp();
begin
  if new.capture_input is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('ai-item-credit:' || new.user_id, 0)
  );

  select item.photos into v_photo_paths
  from public.items item
  where item.id = new.item_id
    and item.user_id = new.user_id
  for update;
  if not found or cardinality(v_photo_paths) not between 1 and 4 then
    raise exception using
      errcode = '23503',
      message = 'AI-item credit run has no owned immutable photo set';
  end if;
  v_photo_set_fingerprint := encode(
    sha256(convert_to(array_to_json(v_photo_paths)::text, 'UTF8')),
    'hex'
  );

  insert into public.ai_item_allowance_periods (
    user_id,
    source,
    period_key,
    period_start,
    expires_date,
    state,
    allowance
  ) values (
    new.user_id,
    'included',
    'included-first-run',
    '-infinity'::timestamptz,
    'infinity'::timestamptz,
    'active',
    1
  )
  on conflict (user_id, source, period_key) do nothing;

  select * into v_period
  from public.ai_item_allowance_periods period
  where period.user_id = new.user_id
    and period.source = 'included'
    and period.period_key = 'included-first-run'
  for update;

  select count(*) into v_used
  from public.ai_item_credit_reservations reservation
  where reservation.allowance_period_id = v_period.id
    and reservation.state in ('reserved', 'settled');

  if v_used >= v_period.allowance then
    select * into v_period
    from public.ai_item_allowance_periods period
    where period.user_id = new.user_id
      and period.source = 'storekit'
      and period.period_start <= v_now
    order by period.period_start desc, period.expires_date desc
    limit 1
    for update;

    if not found then
      raise exception using
        errcode = 'P0001',
        message = 'AI item credit unavailable: snaplist-pro-required';
    end if;
    if not (
      (v_period.state = 'active' and v_now < v_period.expires_date)
      or (
        v_period.state = 'grace'
        and v_period.grace_expires_date is not null
        and v_now < v_period.grace_expires_date
      )
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'AI item credit unavailable: storekit-entitlement-unavailable';
    end if;

    select count(*) into v_used
    from public.ai_item_credit_reservations reservation
    where reservation.allowance_period_id = v_period.id
      and reservation.state in ('reserved', 'settled');
    if v_used >= v_period.allowance then
      raise exception using
        errcode = 'P0001',
        message = 'AI item credit unavailable: monthly-allowance-reached';
    end if;
  end if;

  insert into public.ai_item_credit_reservations (
    user_id,
    pipeline_run_id,
    item_id,
    allowance_period_id,
    logical_run_key,
    photo_set_fingerprint
  ) values (
    new.user_id,
    new.id,
    new.item_id,
    v_period.id,
    new.idempotency_key,
    v_photo_set_fingerprint
  )
  on conflict (pipeline_run_id) do nothing;

  select * into v_existing
  from public.ai_item_credit_reservations reservation
  where reservation.pipeline_run_id = new.id;
  if not found
    or v_existing.user_id is distinct from new.user_id
    or v_existing.item_id is distinct from new.item_id
    or v_existing.logical_run_key is distinct from new.idempotency_key
    or v_existing.photo_set_fingerprint is distinct from v_photo_set_fingerprint then
    raise exception using
      errcode = '23514',
      message = 'AI-item credit reservation identity conflicts';
  end if;
  return new;
end;
$$;

revoke all on function private.reserve_ai_item_credit_for_pipeline_run()
  from public, anon, authenticated, service_role;

create trigger reserve_ai_item_credit_for_pipeline_run
after insert on public.pipeline_runs
for each row
when (new.capture_input is not null)
execute function private.reserve_ai_item_credit_for_pipeline_run();

-- Durable completion inserts the listing before changing the run to succeeded.
-- Stamp the draft with the item's current review revision so the later settlement
-- trigger can prove item, price and copy belong to one coherent revision.
create or replace function private.stamp_pipeline_listing_review_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_review_revision uuid;
  v_review_content_revision uuid;
begin
  if new.run_id is null then return new; end if;

  select item.review_revision, item.review_content_revision
  into v_review_revision, v_review_content_revision
  from public.pipeline_runs run
  join public.ai_item_credit_reservations reservation
    on reservation.pipeline_run_id = run.id
   and reservation.user_id = run.user_id
   and reservation.item_id = run.item_id
  join public.items item
    on item.id = run.item_id
   and item.user_id = run.user_id
  where run.id = new.run_id
    and run.user_id = new.user_id
    and run.item_id = new.item_id;
  if not found then return new; end if;
  if v_review_revision is distinct from v_review_content_revision then
    raise exception using
      errcode = '55000',
      message = 'Pipeline item review revision is incoherent';
  end if;
  if new.source_review_revision is null then
    new.source_review_revision := v_review_revision;
  elsif new.source_review_revision is distinct from v_review_revision then
    raise exception using
      errcode = '23514',
      message = 'Pipeline listing review revision conflicts';
  end if;
  return new;
end;
$$;

revoke all on function private.stamp_pipeline_listing_review_revision()
  from public, anon, authenticated, service_role;

create trigger stamp_pipeline_listing_review_revision
before insert or update of run_id, item_id, user_id, source_review_revision
on public.listings
for each row execute function private.stamp_pipeline_listing_review_revision();

create or replace function private.settle_ai_item_credit(p_run_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.ai_item_credit_reservations%rowtype;
  v_review_revision uuid;
  v_listing_id uuid;
  v_prediction_log_id uuid;
begin
  select * into v_reservation
  from public.ai_item_credit_reservations reservation
  where reservation.pipeline_run_id = p_run_id
  for update;
  if not found then
    if exists (
      select 1
      from public.pipeline_runs run
      where run.id = p_run_id
        and run.capture_input is not null
    ) then
      raise exception using
        errcode = '55000',
        message = 'A staged pipeline run cannot succeed without a credit reservation';
    end if;
    return false;
  end if;
  if v_reservation.state = 'settled' then return true; end if;
  if v_reservation.state = 'restored' then
    raise exception using
      errcode = '55000',
      message = 'A restored AI-item credit cannot settle';
  end if;

  select item.review_revision, listing.id, prediction.id
  into v_review_revision, v_listing_id, v_prediction_log_id
  from public.pipeline_runs run
  join public.items item
    on item.id = run.item_id
   and item.user_id = run.user_id
  join public.listings listing
    on listing.id = run.listing_id
   and listing.run_id = run.id
   and listing.item_id = run.item_id
   and listing.user_id = run.user_id
  join public.prediction_logs prediction
    on prediction.run_id = run.id
   and prediction.item_id = run.item_id
   and prediction.user_id = run.user_id
  where run.id = p_run_id
    and run.status = 'succeeded'
    and run.user_id = v_reservation.user_id
    and run.item_id = v_reservation.item_id
    and v_reservation.photo_set_fingerprint = encode(
      sha256(convert_to(array_to_json(item.photos)::text, 'UTF8')),
      'hex'
    )
    and jsonb_typeof(item.attributes) = 'object'
    and item.attributes <> '{}'::jsonb
    and jsonb_typeof(item.identification) = 'object'
    and item.review_revision is not distinct from item.review_content_revision
    and prediction.price > 0
    and jsonb_typeof(prediction.price_range) = 'object'
    and prediction.confidence between 0 and 1
    and coalesce(btrim(prediction.tier_fired), '') <> ''
    and jsonb_typeof(prediction.sources) = 'array'
    and (
      jsonb_array_length(prediction.sources) > 0
      or prediction.tier_fired = 'llm-only'
    )
    and listing.platform = 'ebay'
    and listing.status in ('draft', 'queued')
    and coalesce(btrim(listing.title), '') <> ''
    and char_length(listing.title) <= 80
    and coalesce(btrim(listing.description), '') <> ''
    and listing.source_review_revision is not distinct from item.review_revision;
  if not found then
    raise exception using
      errcode = '55000',
      message = 'AI-item credit requires one coherent editable draft revision';
  end if;

  update public.ai_item_credit_reservations
  set state = 'settled',
      settled_at = statement_timestamp(),
      settled_review_revision = v_review_revision,
      listing_id = v_listing_id,
      prediction_log_id = v_prediction_log_id,
      updated_at = statement_timestamp()
  where id = v_reservation.id
    and state = 'reserved';
  if not found then
    raise exception using
      errcode = '55000',
      message = 'AI-item credit settlement lost its reservation';
  end if;
  return true;
end;
$$;

revoke all on function private.settle_ai_item_credit(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.restore_ai_item_credit(p_run_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.ai_item_credit_reservations%rowtype;
begin
  select * into v_reservation
  from public.ai_item_credit_reservations reservation
  where reservation.pipeline_run_id = p_run_id
  for update;
  if not found or v_reservation.state in ('settled', 'restored') then
    return false;
  end if;

  update public.ai_item_credit_reservations
  set state = 'restored',
      restored_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where id = v_reservation.id
    and state = 'reserved';
  return found;
end;
$$;

revoke all on function private.restore_ai_item_credit(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.finalize_ai_item_credit_from_pipeline_run()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is not distinct from old.status then return new; end if;
  if new.status = 'succeeded' then
    perform private.settle_ai_item_credit(new.id);
  elsif new.status in ('failed', 'canceled') then
    perform private.restore_ai_item_credit(new.id);
  end if;
  return new;
end;
$$;

revoke all on function private.finalize_ai_item_credit_from_pipeline_run()
  from public, anon, authenticated, service_role;

create trigger finalize_ai_item_credit_from_pipeline_run
after update of status on public.pipeline_runs
for each row
when (old.status is distinct from new.status)
execute function private.finalize_ai_item_credit_from_pipeline_run();

-- Keep the existing terminal quota seam as the single auditable worker hook.
-- The status trigger above restores monthly credit; this helper continues to
-- release the separately labeled daily abuse guard only.
comment on function private.release_pipeline_run_quota_if_available(uuid) is
  'Terminal worker seam: daily abuse capacity releases here; issue #168 monthly credit restores through the run-status trigger.';

create or replace function public.authorize_ai_item_guided_correction(
  p_item_id uuid,
  p_expected_review_revision uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_photo_paths text[];
  v_photo_set_fingerprint text;
  v_reservation public.ai_item_credit_reservations%rowtype;
begin
  if coalesce(v_user_id, '') = '' then
    raise exception using errcode = '42501', message = 'Authentication required.';
  end if;
  if p_item_id is null or p_expected_review_revision is null then
    raise exception using errcode = '22023', message = 'Guided correction identity is required.';
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
  v_photo_set_fingerprint := encode(
    sha256(convert_to(array_to_json(v_photo_paths)::text, 'UTF8')),
    'hex'
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
  if not found
    or v_reservation.guided_correction_completed_at is not null
    or (
      v_reservation.guided_correction_revision is not null
      and v_reservation.guided_correction_revision
          is distinct from p_expected_review_revision
    ) then
    raise exception using
      errcode = 'P0001',
      message = 'The included guided correction is unavailable.';
  end if;

  if v_reservation.guided_correction_revision is null then
    update public.ai_item_credit_reservations
    set guided_correction_revision = p_expected_review_revision,
        guided_correction_started_at = statement_timestamp(),
        updated_at = statement_timestamp()
    where id = v_reservation.id;
    return true;
  end if;
  return false;
end;
$$;

revoke all on function public.authorize_ai_item_guided_correction(uuid, uuid)
  from public, anon;
grant execute on function public.authorize_ai_item_guided_correction(uuid, uuid)
  to authenticated;

create or replace function public.regenerate_review_listing_with_credit(
  p_item_id uuid,
  p_listing_id uuid,
  p_run_id uuid,
  p_expected_run_id uuid,
  p_expected_review_revision uuid,
  p_attributes jsonb,
  p_condition text,
  p_identification jsonb,
  p_listing_title text,
  p_listing_description text,
  p_listing_copy jsonb,
  p_price numeric,
  p_price_range jsonb,
  p_confidence numeric,
  p_tier_fired text,
  p_model text,
  p_listing_model text,
  p_pricing_model text,
  p_sources jsonb,
  p_autopilot_enabled boolean,
  p_autopilot_eligible boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_reservation_id uuid;
begin
  if coalesce(v_user_id, '') = '' then
    raise exception using errcode = '42501', message = 'Authentication required.';
  end if;

  select reservation.id into v_reservation_id
  from public.ai_item_credit_reservations reservation
  join public.items item
    on item.id = reservation.item_id
   and item.user_id = reservation.user_id
  where reservation.user_id = v_user_id
    and reservation.item_id = p_item_id
    and reservation.state = 'settled'
    and reservation.guided_correction_revision
        is not distinct from p_expected_review_revision
    and reservation.guided_correction_completed_at is null
    and item.review_revision is not distinct from p_expected_review_revision
    and reservation.photo_set_fingerprint = encode(
      sha256(convert_to(array_to_json(item.photos)::text, 'UTF8')),
      'hex'
    )
  order by reservation.settled_at desc
  limit 1
  for update of reservation, item;
  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'The included guided correction is unavailable.';
  end if;

  perform public.regenerate_review_listing(
    p_item_id,
    p_listing_id,
    p_run_id,
    p_expected_run_id,
    p_expected_review_revision,
    p_attributes,
    p_condition,
    p_identification,
    p_listing_title,
    p_listing_description,
    p_listing_copy,
    p_price,
    p_price_range,
    p_confidence,
    p_tier_fired,
    p_model,
    p_listing_model,
    p_pricing_model,
    p_sources,
    p_autopilot_enabled,
    p_autopilot_eligible
  );

  update public.listings
  set source_review_revision = p_run_id
  where id = p_listing_id
    and item_id = p_item_id
    and user_id = v_user_id
    and run_id = p_run_id
    and status = 'draft';
  if not found then
    raise exception using
      errcode = '55000',
      message = 'Guided correction draft revision was not persisted.';
  end if;

  update public.ai_item_credit_reservations
  set guided_correction_completed_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where id = v_reservation_id
    and guided_correction_completed_at is null;
  if not found then
    raise exception using
      errcode = '55000',
      message = 'Guided correction completion was already recorded.';
  end if;
end;
$$;

revoke all on function public.regenerate_review_listing_with_credit(
  uuid, uuid, uuid, uuid, uuid, jsonb, text, jsonb, text, text, jsonb, numeric,
  jsonb, numeric, text, text, text, text, jsonb, boolean, boolean
) from public, anon;
grant execute on function public.regenerate_review_listing_with_credit(
  uuid, uuid, uuid, uuid, uuid, jsonb, text, jsonb, text, text, jsonb, numeric,
  jsonb, numeric, text, text, text, text, jsonb, boolean, boolean
) to authenticated;
