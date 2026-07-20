-- Issue #333: version the canonical photo-set identity without pretending that
-- historical ordered Storage-path digests are content hashes.

create or replace function private.legacy_path_v0_fingerprint(p_photo_paths text[])
returns text
language sql
immutable
strict
security definer
set search_path = ''
as $$
  select encode(
    sha256(convert_to(array_to_json(p_photo_paths)::text, 'UTF8')),
    'hex'
  )
$$;

revoke all on function private.legacy_path_v0_fingerprint(text[])
  from public, anon, authenticated, service_role;

alter table public.items
  add column photo_identity_kind text,
  add column photo_identity_fingerprint text;

alter table public.pipeline_runs
  add column photo_identity_kind text,
  add column photo_identity_fingerprint text;

alter table public.ai_item_credit_reservations
  add column photo_identity_kind text,
  add column photo_identity_fingerprint text;

-- Every pre-#333 identity was derived from ordered Storage paths. Preserve the
-- exact durable value when the #168 reservation still has it; otherwise derive
-- the same legacy value from the row's current ordered paths. Never label these
-- rows as content hashes.
update public.items item
set photo_identity_kind = 'legacy_path_v0',
    photo_identity_fingerprint = coalesce(
      (
        select reservation.photo_set_fingerprint
        from public.ai_item_credit_reservations reservation
        where reservation.item_id = item.id
          and reservation.user_id = item.user_id
        order by reservation.reserved_at, reservation.id
        limit 1
      ),
      private.legacy_path_v0_fingerprint(item.photos)
    );

update public.pipeline_runs run
set photo_identity_kind = 'legacy_path_v0',
    photo_identity_fingerprint = coalesce(
      (
        select reservation.photo_set_fingerprint
        from public.ai_item_credit_reservations reservation
        where reservation.pipeline_run_id = run.id
        limit 1
      ),
      (
        select item.photo_identity_fingerprint
        from public.items item
        where item.id = run.item_id
          and item.user_id = run.user_id
      )
    );

update public.ai_item_credit_reservations reservation
set photo_identity_kind = 'legacy_path_v0',
    photo_identity_fingerprint = reservation.photo_set_fingerprint;

alter table public.items
  alter column photo_identity_kind set not null,
  alter column photo_identity_fingerprint set not null,
  add constraint items_photo_identity_kind_check check (
    photo_identity_kind in ('legacy_path_v0', 'content_sha256_set_v1')
  ),
  add constraint items_photo_identity_fingerprint_check check (
    photo_identity_fingerprint ~ '^[0-9a-f]{64}$'
  );

alter table public.pipeline_runs
  alter column photo_identity_kind set not null,
  alter column photo_identity_fingerprint set not null,
  add constraint pipeline_runs_photo_identity_kind_check check (
    photo_identity_kind in ('legacy_path_v0', 'content_sha256_set_v1')
  ),
  add constraint pipeline_runs_photo_identity_fingerprint_check check (
    photo_identity_fingerprint ~ '^[0-9a-f]{64}$'
  );

alter table public.ai_item_credit_reservations
  alter column photo_identity_kind set not null,
  alter column photo_identity_fingerprint set not null,
  add constraint ai_item_credit_reservations_photo_identity_kind_check check (
    photo_identity_kind in ('legacy_path_v0', 'content_sha256_set_v1')
  ),
  add constraint ai_item_credit_reservations_photo_identity_fingerprint_check check (
    photo_identity_fingerprint ~ '^[0-9a-f]{64}$'
  );

comment on column public.items.photo_identity_kind is
  'Version of the immutable logical photo-set identity. legacy_path_v0 is path-derived; content_sha256_set_v1 is verified-content-derived.';
comment on column public.items.photo_identity_fingerprint is
  'Immutable logical photo-set fingerprint interpreted only with photo_identity_kind.';
comment on column public.pipeline_runs.photo_identity_kind is
  'Immutable copy of the owning item photo identity kind for this logical run.';
comment on column public.pipeline_runs.photo_identity_fingerprint is
  'Immutable copy of the owning item logical photo-set fingerprint for this run.';
comment on column public.ai_item_credit_reservations.photo_identity_kind is
  'Immutable copy of the logical run photo identity kind used for credit and correction eligibility.';
comment on column public.ai_item_credit_reservations.photo_set_fingerprint is
  'Legacy ordered Storage-path digest retained for pre-#333 accounting compatibility. It is not a canonical content identity.';
comment on column public.ai_item_credit_reservations.photo_identity_fingerprint is
  'Immutable logical photo-set fingerprint interpreted only with photo_identity_kind.';

create or replace function private.assign_item_photo_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.photo_identity_kind is null
    and new.photo_identity_fingerprint is null then
    new.photo_identity_kind := 'legacy_path_v0';
    new.photo_identity_fingerprint :=
      private.legacy_path_v0_fingerprint(new.photos);
  elsif new.photo_identity_kind is null
    or new.photo_identity_fingerprint is null then
    raise exception using
      errcode = '23514',
      message = 'Photo identity kind and fingerprint must be established together';
  elsif session_user not in ('postgres', 'supabase_admin') then
    raise exception using
      errcode = '42501',
      message = 'Verified photo identity requires the fixed staging capability';
  end if;
  return new;
end;
$$;

revoke all on function private.assign_item_photo_identity()
  from public, anon, authenticated, service_role;

create trigger assign_item_photo_identity
before insert on public.items
for each row execute function private.assign_item_photo_identity();

create or replace function private.assign_pipeline_run_photo_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_identities_text text := current_setting(
    'snaplist.verified_photo_identities', true
  );
  v_identity jsonb;
  v_item public.items%rowtype;
begin
  select * into v_item
  from public.items item
  where item.id = new.item_id
    and item.user_id = new.user_id
  for update;
  if not found then
    raise exception using
      errcode = '23503',
      message = 'Pipeline run has no owned item photo identity';
  end if;

  if new.capture_input is not null and coalesce(v_identities_text, '') <> '' then
    select identity_row.value into v_identity
    from jsonb_array_elements(v_identities_text::jsonb) identity_row(value)
    where identity_row.value->>'idempotency_key' = new.idempotency_key;
  end if;

  if v_identity is not null then
    perform set_config(
      'snaplist.photo_identity_promotion_item_id', v_item.id::text, true
    );
    perform set_config(
      'snaplist.photo_identity_promotion_fingerprint',
      v_identity->>'photo_identity_fingerprint',
      true
    );

    update public.items item
    set photo_identity_kind = 'content_sha256_set_v1',
        photo_identity_fingerprint =
          v_identity->>'photo_identity_fingerprint'
    where item.id = v_item.id
      and item.user_id = v_item.user_id;

    perform set_config('snaplist.photo_identity_promotion_item_id', '', true);
    perform set_config('snaplist.photo_identity_promotion_fingerprint', '', true);

    new.photo_identity_kind := 'content_sha256_set_v1';
    new.photo_identity_fingerprint :=
      v_identity->>'photo_identity_fingerprint';
  else
    new.photo_identity_kind := v_item.photo_identity_kind;
    new.photo_identity_fingerprint := v_item.photo_identity_fingerprint;
  end if;

  return new;
end;
$$;

revoke all on function private.assign_pipeline_run_photo_identity()
  from public, anon, authenticated, service_role;

create trigger assign_pipeline_run_photo_identity
before insert on public.pipeline_runs
for each row execute function private.assign_pipeline_run_photo_identity();

create or replace function private.assign_credit_reservation_photo_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  select run.photo_identity_kind, run.photo_identity_fingerprint
  into new.photo_identity_kind, new.photo_identity_fingerprint
  from public.pipeline_runs run
  where run.id = new.pipeline_run_id
    and run.user_id = new.user_id
    and run.item_id = new.item_id;
  if not found then
    raise exception using
      errcode = '23503',
      message = 'AI-item credit reservation has no owned run photo identity';
  end if;
  return new;
end;
$$;

revoke all on function private.assign_credit_reservation_photo_identity()
  from public, anon, authenticated, service_role;

create trigger assign_credit_reservation_photo_identity
before insert on public.ai_item_credit_reservations
for each row execute function private.assign_credit_reservation_photo_identity();

create or replace function private.enforce_photo_identity_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_promotion_item_id text := current_setting(
    'snaplist.photo_identity_promotion_item_id', true
  );
  v_promotion_fingerprint text := current_setting(
    'snaplist.photo_identity_promotion_fingerprint', true
  );
begin
  if (new.photo_identity_kind, new.photo_identity_fingerprint)
    is not distinct from
    (old.photo_identity_kind, old.photo_identity_fingerprint) then
    return new;
  end if;

  if tg_table_name = 'items'
    and old.photo_identity_kind = 'legacy_path_v0'
    and new.photo_identity_kind = 'content_sha256_set_v1'
    and new.id::text = v_promotion_item_id
    and new.photo_identity_fingerprint = v_promotion_fingerprint
    and (new.user_id, new.photos) is not distinct from (old.user_id, old.photos)
    and not exists (
      select 1
      from public.ai_item_credit_reservations reservation
      where reservation.item_id = old.id
        and reservation.user_id = old.user_id
    ) then
    return new;
  end if;

  raise exception using
    errcode = '23514',
    message = 'Photo identity kind and fingerprint are immutable';
end;
$$;

revoke all on function private.enforce_photo_identity_immutable()
  from public, anon, authenticated, service_role;

create trigger enforce_photo_identity_immutable
before update of photo_identity_kind, photo_identity_fingerprint on public.items
for each row execute function private.enforce_photo_identity_immutable();

create trigger enforce_photo_identity_immutable
before update of photo_identity_kind, photo_identity_fingerprint on public.pipeline_runs
for each row execute function private.enforce_photo_identity_immutable();

create trigger enforce_photo_identity_immutable
before update of photo_identity_kind, photo_identity_fingerprint
on public.ai_item_credit_reservations
for each row execute function private.enforce_photo_identity_immutable();

-- Overload the existing fixed staging capability rather than creating a second
-- accounting/enqueue path. The five-argument function keeps the ordered paths,
-- cost basis, source and other request inputs as its idempotency conflict truth.
create or replace function public.stage_pipeline_batch(
  p_user_id text,
  p_batch_id uuid,
  p_entries jsonb,
  p_daily_limit integer,
  p_per_minute_limit integer,
  p_photo_identities jsonb
)
returns table (
  batch_id uuid,
  batch_position integer,
  idempotency_key text,
  item_id uuid,
  run_id uuid,
  queue_message_id bigint,
  listing_id uuid,
  status text,
  stage text,
  attempt_count integer,
  max_attempts integer,
  safe_failure_message text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_identity jsonb;
  v_seen_keys text[] := '{}'::text[];
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Pipeline staging authorization is required';
  end if;
  if jsonb_typeof(p_entries) <> 'array'
    or jsonb_typeof(p_photo_identities) <> 'array'
    or jsonb_array_length(p_photo_identities) <> jsonb_array_length(p_entries)
    or jsonb_array_length(p_photo_identities) not between 1 and 200 then
    raise exception using
      errcode = '22023',
      message = 'Verified photo identities must match staged entries';
  end if;

  for v_identity in
    select identity_row.value
    from jsonb_array_elements(p_photo_identities) identity_row(value)
  loop
    if jsonb_typeof(v_identity) <> 'object'
      or not (v_identity ?& array[
        'idempotency_key', 'photo_identity_kind', 'photo_identity_fingerprint'
      ])
      or (select count(*) from jsonb_object_keys(v_identity)) <> 3
      or v_identity->>'photo_identity_kind'
        is distinct from 'content_sha256_set_v1'
      or v_identity->>'photo_identity_fingerprint' !~ '^[0-9a-f]{64}$'
      or coalesce(char_length(v_identity->>'idempotency_key'), 0)
        not between 1 and 128
      or v_identity->>'idempotency_key' = any(v_seen_keys)
      or not exists (
        select 1
        from jsonb_array_elements(p_entries) entry(value)
        where entry.value->>'idempotency_key'
          = v_identity->>'idempotency_key'
      ) then
      raise exception using
        errcode = '22023',
        message = 'Invalid verified photo identity';
    end if;
    v_seen_keys := array_append(
      v_seen_keys, v_identity->>'idempotency_key'
    );

    if exists (
      select 1
      from public.pipeline_runs run
      where run.user_id = p_user_id
        and run.idempotency_key = v_identity->>'idempotency_key'
        and (
          run.photo_identity_kind
            is distinct from v_identity->>'photo_identity_kind'
          or run.photo_identity_fingerprint
            is distinct from v_identity->>'photo_identity_fingerprint'
        )
    ) then
      raise exception using
        errcode = '23514',
        message = 'Pipeline idempotency key conflicts with verified photo identity';
    end if;
  end loop;

  if exists (
    select 1
    from jsonb_array_elements(p_entries) entry(value)
    where not (entry.value->>'idempotency_key' = any(v_seen_keys))
  ) then
    raise exception using
      errcode = '22023',
      message = 'Every staged entry requires one verified photo identity';
  end if;

  perform set_config(
    'snaplist.verified_photo_identities', p_photo_identities::text, true
  );

  return query
  select staged.*
  from public.stage_pipeline_batch(
    p_user_id,
    p_batch_id,
    p_entries,
    p_daily_limit,
    p_per_minute_limit
  ) staged;

  perform set_config('snaplist.verified_photo_identities', '', true);
end;
$$;

revoke all on function public.stage_pipeline_batch(
  text, uuid, jsonb, integer, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.stage_pipeline_batch(
  text, uuid, jsonb, integer, integer, jsonb
) to service_role;

-- A path-derived legacy identity can continue through its own run lifecycle,
-- but it cannot prove that a later correction still has the same photo bytes.
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
  v_item public.items%rowtype;
  v_reservation public.ai_item_credit_reservations%rowtype;
  v_now timestamptz := statement_timestamp();
  v_expires_at timestamptz;
begin
  if coalesce(v_user_id, '') = '' then
    raise exception using
      errcode = '42501',
      message = 'Authentication required.';
  end if;
  if p_item_id is null or p_listing_id is null or p_completion_run_id is null
    or p_expected_review_revision is null
    or p_completion_run_id is not distinct from p_expected_run_id
    or p_completion_token !~ '^[A-Za-z0-9_-]{43}$'
    or p_expires_at <= v_now then
    raise exception using
      errcode = '22023',
      message = 'Guided correction capability request is invalid.';
  end if;
  v_expires_at := case
    when p_expires_at is null then null
    else least(p_expires_at, v_now + interval '5 minutes')
  end;

  select * into v_item
  from public.items item
  where item.id = p_item_id
    and item.user_id = v_user_id
    and item.review_revision is not distinct from p_expected_review_revision
  for update;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Review changed. Reload and try again.';
  end if;
  if v_item.photo_identity_kind <> 'content_sha256_set_v1' then
    raise exception using
      errcode = 'P0001',
      message = 'Legacy photo identity cannot prove same-photo correction.';
  end if;

  perform 1
  from public.listings listing
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
    raise exception using
      errcode = 'P0002',
      message = 'Editable eBay listing not found.';
  end if;

  select reservation.* into v_reservation
  from public.ai_item_credit_reservations reservation
  join public.items item
    on item.id = reservation.item_id
   and item.user_id = reservation.user_id
  where reservation.user_id = v_user_id
    and reservation.item_id = p_item_id
    and reservation.state = 'settled'
    and reservation.photo_identity_kind = item.photo_identity_kind
    and reservation.photo_identity_fingerprint = item.photo_identity_fingerprint
    and reservation.photo_identity_kind = 'content_sha256_set_v1'
  order by reservation.settled_at desc
  limit 1
  for update of reservation;
  if not found or v_reservation.guided_correction_completed_at is not null then
    raise exception using
      errcode = 'P0001',
      message = 'The included guided correction is unavailable.';
  end if;

  update public.ai_item_credit_reservations
  set guided_correction_revision = p_expected_review_revision,
      guided_correction_started_at = v_now,
      updated_at = v_now
  where id = v_reservation.id
    and guided_correction_completed_at is null;

  insert into private.guided_correction_completion_capabilities (
    reservation_id,
    token_hash,
    user_id,
    item_id,
    listing_id,
    completion_run_id,
    expected_run_id,
    expected_review_revision,
    created_at,
    expires_at,
    consumed_at
  ) values (
    v_reservation.id,
    encode(sha256(convert_to(p_completion_token, 'UTF8')), 'hex'),
    v_user_id,
    p_item_id,
    p_listing_id,
    p_completion_run_id,
    p_expected_run_id,
    p_expected_review_revision,
    v_now,
    v_expires_at,
    null
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

  return jsonb_build_object('expiresAt', v_expires_at);
end;
$$;

revoke all on function public.authorize_ai_item_guided_correction(
  uuid, uuid, uuid, uuid, uuid, text, timestamptz
) from public, anon, service_role;
grant execute on function public.authorize_ai_item_guided_correction(
  uuid, uuid, uuid, uuid, uuid, text, timestamptz
) to authenticated;

create or replace function private.enforce_verified_guided_correction_completion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.guided_correction_completed_at is null
    and new.guided_correction_completed_at is not null
    and new.photo_identity_kind <> 'content_sha256_set_v1' then
    raise exception using
      errcode = 'P0001',
      message = 'Legacy photo identity cannot prove same-photo correction.';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_verified_guided_correction_completion()
  from public, anon, authenticated, service_role;

create trigger enforce_verified_guided_correction_completion
before update of guided_correction_completed_at
on public.ai_item_credit_reservations
for each row execute function private.enforce_verified_guided_correction_completion();
