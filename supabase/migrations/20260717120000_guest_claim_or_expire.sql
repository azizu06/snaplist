-- Issue #175: one authoritative guest claim-or-expire seam.
--
-- The durable pipeline's server completion timestamp is the only clock that
-- starts the fixed recovery period. Storage copy/verification stays outside the
-- database transaction, while this migration owns the lease, ownership remap,
-- exact settled-credit remap, terminal predicate, and bounded source cleanup.

alter table private.pipeline_storage_cleanup_jobs
  drop constraint pipeline_storage_cleanup_source_check;
alter table private.pipeline_storage_cleanup_jobs
  add constraint pipeline_storage_cleanup_source_check check (
    source_type in (
      'staging', 'abandoned_item', 'guest_recovery', 'guest_claim_copy'
    )
  );
alter table private.pipeline_storage_cleanup_jobs
  add column guest_copy_writer_quiesced boolean not null default true,
  add column resweep_requested boolean not null default false,
  add column guest_copy_final_sweep_armed boolean not null default false,
  add constraint pipeline_storage_cleanup_guest_copy_fence_check check (
    source_type = 'guest_claim_copy'
    or (
      guest_copy_writer_quiesced
      and not resweep_requested
      and not guest_copy_final_sweep_armed
    )
  );

comment on column private.pipeline_storage_cleanup_jobs.guest_copy_writer_quiesced is
  'False keeps obsolete guest-copy cleanup sweeping until its writer exits or the bounded job dead-letters.';
comment on column private.pipeline_storage_cleanup_jobs.resweep_requested is
  'A late writer marker that prevents a running cleanup from deleting its durable intent.';
comment on column private.pipeline_storage_cleanup_jobs.guest_copy_final_sweep_armed is
  'One-shot fence reserving the final post-writer cleanup without resetting the bounded retry cycle.';

-- Claim moves a tenant key across a coherent graph in one transaction. These
-- foreign keys remain immediate everywhere else and are deferred only by the
-- fixed service-role completion function below.
alter table public.listings
  alter constraint listings_item_user_fkey deferrable initially immediate;
alter table public.pipeline_runs
  alter constraint pipeline_runs_item_user_fkey deferrable initially immediate;
alter table public.pipeline_runs
  alter constraint pipeline_runs_listing_item_user_fkey deferrable initially immediate;
alter table public.notifications
  alter constraint notifications_source_pipeline_run_user_fkey
  deferrable initially immediate;
alter table public.ai_item_credit_reservations
  alter constraint ai_item_credit_reservations_period_fkey
  deferrable initially immediate;
alter table public.ai_item_credit_reservations
  alter constraint ai_item_credit_reservations_pipeline_run_fkey
  deferrable initially immediate;

create table private.guest_draft_recoveries (
  id uuid primary key,
  guest_user_id text not null,
  pipeline_run_id uuid not null unique,
  item_id uuid not null,
  draft_id uuid not null,
  reservation_id uuid not null unique,
  allowance_period_id uuid not null,
  recovery_token_hash text not null,
  encrypted_artifact jsonb,
  storage_manifest jsonb,
  storage_object_count integer not null,
  usable_draft_at timestamptz not null,
  expires_at timestamptz not null,
  state text not null default 'claimable',
  claim_idempotency_user_id text,
  claim_idempotency_key uuid,
  claim_target_user_id text,
  claim_lease_token uuid,
  claim_lease_expires_at timestamptz,
  claimed_lease_token uuid,
  claimed_storage_manifest jsonb,
  claimed_at timestamptz,
  expired_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint guest_draft_recoveries_user_check check (
    char_length(guest_user_id) between 1 and 255
    and guest_user_id ~ '^[A-Za-z0-9_-]+$'
    and (
      claim_target_user_id is null
      or (
        char_length(claim_target_user_id) between 1 and 255
        and claim_target_user_id ~ '^[A-Za-z0-9_-]+$'
        and claim_target_user_id <> guest_user_id
      )
    )
  ),
  constraint guest_draft_recoveries_token_check check (
    recovery_token_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint guest_draft_recoveries_idempotency_check check (
    (
      claim_idempotency_user_id is null
      and claim_idempotency_key is null
    )
    or (
      claim_idempotency_user_id is not null
      and claim_idempotency_key is not null
      and char_length(claim_idempotency_user_id) between 1 and 255
      and claim_idempotency_user_id ~ '^[A-Za-z0-9_-]+$'
      and claim_idempotency_user_id <> guest_user_id
    )
  ),
  constraint guest_draft_recoveries_deadline_check check (
    expires_at = usable_draft_at + interval '24 hours'
  ),
  constraint guest_draft_recoveries_state_check check (
    state in ('claimable', 'copying', 'claimed', 'expired')
  ),
  constraint guest_draft_recoveries_object_count_check check (
    storage_object_count between 1 and 4
  ),
  constraint guest_draft_recoveries_material_check check (
    (
      state in ('claimable', 'copying')
      and encrypted_artifact is not null
      and storage_manifest is not null
    )
    or (
      state = 'claimed'
      and encrypted_artifact is not null
      and storage_manifest is null
    )
    or (
      state = 'expired'
      and encrypted_artifact is null
      and storage_manifest is null
    )
  ),
  constraint guest_draft_recoveries_claim_check check (
    (
      state = 'claimable'
      and claim_target_user_id is null
      and claim_lease_token is null
      and claim_lease_expires_at is null
      and claimed_lease_token is null
      and claimed_storage_manifest is null
      and claimed_at is null
      and expired_at is null
    )
    or (
      state = 'copying'
      and claim_target_user_id is not null
      and claim_lease_token is not null
      and claim_lease_expires_at is not null
      and claimed_lease_token is null
      and claimed_storage_manifest is null
      and claimed_at is null
      and expired_at is null
    )
    or (
      state = 'claimed'
      and claim_target_user_id is not null
      and claim_lease_token is null
      and claim_lease_expires_at is null
      and claimed_lease_token is not null
      and claimed_storage_manifest is not null
      and claimed_at is not null
      and expired_at is null
    )
    or (
      state = 'expired'
      and claim_target_user_id is null
      and claim_lease_token is null
      and claim_lease_expires_at is null
      and claimed_lease_token is null
      and claimed_storage_manifest is null
      and claimed_at is null
      and expired_at is not null
    )
  )
);

create index guest_draft_recoveries_expiry_idx
  on private.guest_draft_recoveries (expires_at, id)
  where state in ('claimable', 'copying');
create index guest_draft_recoveries_copy_lease_idx
  on private.guest_draft_recoveries (claim_lease_expires_at, id)
  where state = 'copying';
create unique index guest_draft_recoveries_idempotency_idx
  on private.guest_draft_recoveries (
    claim_idempotency_user_id,
    claim_idempotency_key
  )
  where claim_idempotency_key is not null;

comment on table private.guest_draft_recoveries is
  'Opaque encrypted recovery plus one server-time claim-or-expire predicate. Claimed rows retain the account recovery envelope; expired rows retain identifiers only.';
comment on column private.guest_draft_recoveries.usable_draft_at is
  'Exact durable pipeline completed_at timestamp; capture and device clocks never participate.';
comment on column private.guest_draft_recoveries.recovery_token_hash is
  'SHA-256 of the #174-verified opaque recovery capability. The raw capability is never stored.';
comment on column private.guest_draft_recoveries.storage_object_count is
  'Non-secret bounded count retained after manifest purge so only an exact stale lease namespace can be requeued.';
comment on column private.guest_draft_recoveries.claimed_lease_token is
  'Winning Storage-copy fence retained so cleanup can never target claimed account objects.';
comment on column private.guest_draft_recoveries.claim_idempotency_key is
  'Principal-bound logical mutation key retained so retries replay one recovery outcome.';

revoke all on table private.guest_draft_recoveries
  from public, anon, authenticated, service_role;

create or replace function private.guest_claim_service_role_required()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Guest recovery service authorization is required';
  end if;
end;
$$;

revoke all on function private.guest_claim_service_role_required()
  from public, anon, authenticated, service_role;

create or replace function private.valid_guest_base64(
  p_value text,
  p_exact_bytes integer default null,
  p_min_bytes integer default 1,
  p_max_bytes integer default 2097152
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_decoded bytea;
begin
  if p_value is null
    or p_min_bytes is null
    or p_max_bytes is null
    or p_min_bytes < 0
    or p_max_bytes < p_min_bytes
    or (p_exact_bytes is not null and p_exact_bytes < 0)
    or p_value !~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
    or char_length(p_value) % 4 <> 0 then
    return false;
  end if;

  v_decoded := decode(p_value, 'base64');
  if replace(encode(v_decoded, 'base64'), E'\n', '') <> p_value
    or octet_length(v_decoded) < p_min_bytes
    or octet_length(v_decoded) > p_max_bytes
    or (
      p_exact_bytes is not null
      and octet_length(v_decoded) <> p_exact_bytes
    ) then
    return false;
  end if;
  return true;
exception when others then
  return false;
end;
$$;

revoke all on function private.valid_guest_base64(text, integer, integer, integer)
  from public, anon, authenticated, service_role;

create or replace function private.guest_terminal_outcome(
  p_recovery private.guest_draft_recoveries
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'outcome', p_recovery.state,
    'itemId', p_recovery.item_id,
    'runId', p_recovery.pipeline_run_id,
    'draftId', p_recovery.draft_id,
    'purgeLocalRecovery', true
  )
$$;

revoke all on function private.guest_terminal_outcome(
  private.guest_draft_recoveries
) from public, anon, authenticated, service_role;

create or replace function private.guest_terminal_outcome_for_target(
  p_recovery private.guest_draft_recoveries,
  p_target_user_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_recovery.state = 'claimed'
    and p_recovery.claim_target_user_id is distinct from p_target_user_id then
    raise exception using errcode = 'P0002', message = 'Guest recovery not found';
  end if;
  return private.guest_terminal_outcome(p_recovery)
    || case
      when p_recovery.state = 'claimed' then jsonb_build_object(
        'accountRecovery', jsonb_build_object(
          'encryptedArtifact', p_recovery.encrypted_artifact,
          'storageManifest', p_recovery.claimed_storage_manifest
        )
      )
      else '{}'::jsonb
    end;
end;
$$;

revoke all on function private.guest_terminal_outcome_for_target(
  private.guest_draft_recoveries, text
) from public, anon, authenticated, service_role;

create or replace function private.guest_manifest_source_paths(
  p_manifest jsonb
)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    array_agg(entry.value->>'sourcePath' order by entry.ordinality),
    '{}'::text[]
  )
  from jsonb_array_elements(p_manifest) with ordinality entry(value, ordinality)
$$;

create or replace function private.guest_manifest_destination_paths(
  p_manifest jsonb,
  p_recovery_id uuid,
  p_target_user_id text,
  p_claim_lease_token uuid
)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    array_agg(
      p_target_user_id || '/guest-claims/' || p_recovery_id::text || '/'
        || p_claim_lease_token::text || '/' || entry.ordinality::text
      order by entry.ordinality
    ),
    '{}'::text[]
  )
  from jsonb_array_elements(p_manifest) with ordinality entry(value, ordinality)
$$;

create or replace function private.guest_claim_destination_paths(
  p_recovery_id uuid,
  p_target_user_id text,
  p_claim_lease_token uuid,
  p_object_count integer
)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    array_agg(
      p_target_user_id || '/guest-claims/' || p_recovery_id::text || '/'
        || p_claim_lease_token::text || '/' || entry.ordinality::text
      order by entry.ordinality
    ),
    '{}'::text[]
  )
  from generate_series(1, p_object_count) entry(ordinality)
$$;

revoke all on function private.guest_manifest_source_paths(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.guest_manifest_destination_paths(
  jsonb, uuid, text, uuid
)
  from public, anon, authenticated, service_role;
revoke all on function private.guest_claim_destination_paths(
  uuid, text, uuid, integer
) from public, anon, authenticated, service_role;

create or replace function private.guest_claim_photo_remap_allowed(
  p_old public.items,
  p_new public.items
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_recovery_id text := current_setting(
    'snaplist.guest_claim_recovery_id', true
  );
  v_lease_token text := current_setting(
    'snaplist.guest_claim_lease_token', true
  );
begin
  if coalesce(v_recovery_id, '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(v_lease_token, '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return false;
  end if;

  return exists (
    select 1
    from private.guest_draft_recoveries recovery
    where recovery.id = v_recovery_id::uuid
      and recovery.state = 'copying'
      and recovery.claim_lease_token = v_lease_token::uuid
      and recovery.item_id = p_old.id
      and recovery.guest_user_id = p_old.user_id
      and recovery.claim_target_user_id = p_new.user_id
      and private.guest_manifest_source_paths(recovery.storage_manifest)
        is not distinct from p_old.photos
      and private.guest_manifest_destination_paths(
        recovery.storage_manifest,
        recovery.id,
        recovery.claim_target_user_id,
        recovery.claim_lease_token
      ) is not distinct from p_new.photos
  );
end;
$$;

revoke all on function private.guest_claim_photo_remap_allowed(
  public.items, public.items
) from public, anon, authenticated, service_role;

-- Retention's existing exception remains exact. The only added exception is a
-- namespace-only remap tied to this transaction's locked recovery + lease and
-- to the manifest that the Storage phase must verify byte-for-byte.
create or replace function private.enforce_credited_item_photo_set_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_photo_set_fingerprint text;
begin
  if new.photos is not distinct from old.photos then
    return new;
  end if;

  perform reservation.id
  from public.ai_item_credit_reservations reservation
  where reservation.item_id = old.id
    and reservation.user_id = old.user_id
  order by reservation.pipeline_run_id
  for update of reservation;

  if not found then
    return new;
  end if;

  if private.guest_claim_photo_remap_allowed(old, new) then
    return new;
  end if;

  v_photo_set_fingerprint := encode(
    sha256(convert_to(array_to_json(old.photos)::text, 'UTF8')),
    'hex'
  );

  if new.photos = '{}'::text[]
    and not exists (
      select 1
      from public.ai_item_credit_reservations reservation
      where reservation.item_id = old.id
        and reservation.user_id = old.user_id
        and (
          reservation.state = 'reserved'
          or reservation.photo_set_fingerprint
            is distinct from v_photo_set_fingerprint
        )
    )
    and exists (
      select 1
      from private.pipeline_storage_cleanup_jobs cleanup_job
      where cleanup_job.source_type in ('abandoned_item', 'guest_recovery')
        and (
          (cleanup_job.source_type = 'abandoned_item'
            and cleanup_job.source_id = old.id)
          or (
            cleanup_job.source_type = 'guest_recovery'
            and exists (
              select 1
              from private.guest_draft_recoveries recovery
              where recovery.id = cleanup_job.source_id
                and recovery.item_id = old.id
                and recovery.guest_user_id = old.user_id
            )
          )
        )
        and (
          (cleanup_job.source_type = 'abandoned_item'
            and cleanup_job.photo_paths is not distinct from old.photos)
          or (
            cleanup_job.source_type = 'guest_recovery'
            and cleanup_job.photo_paths @> old.photos
          )
        )
        and cleanup_job.xmin = pg_current_xact_id()::xid
    ) then
    return new;
  end if;

  raise exception using
    errcode = '23514',
    message = 'A credited item photo set is immutable; start a new AI-item run';
end;
$$;

revoke all on function private.enforce_credited_item_photo_set_immutable()
  from public, anon, authenticated, service_role;

create or replace function private.guest_claim_run_remap_allowed(
  p_old public.pipeline_runs,
  p_new public.pipeline_runs
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_recovery_id text := current_setting(
    'snaplist.guest_claim_recovery_id', true
  );
  v_lease_token text := current_setting(
    'snaplist.guest_claim_lease_token', true
  );
begin
  if coalesce(v_recovery_id, '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(v_lease_token, '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return false;
  end if;

  return exists (
    select 1
    from private.guest_draft_recoveries recovery
    where recovery.id = v_recovery_id::uuid
      and recovery.state = 'copying'
      and recovery.claim_lease_token = v_lease_token::uuid
      and recovery.pipeline_run_id = p_old.id
      and recovery.item_id = p_old.item_id
      and recovery.guest_user_id = p_old.user_id
      and recovery.claim_target_user_id = p_new.user_id
  );
end;
$$;

revoke all on function private.guest_claim_run_remap_allowed(
  public.pipeline_runs, public.pipeline_runs
) from public, anon, authenticated, service_role;

create or replace function public.enforce_pipeline_run_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_allowed boolean := false;
  v_old_stage integer;
  v_new_stage integer;
begin
  if (new.item_id, new.idempotency_key, new.schema_version)
      is distinct from
      (old.item_id, old.idempotency_key, old.schema_version)
    or (
      new.user_id is distinct from old.user_id
      and not private.guest_claim_run_remap_allowed(old, new)
    ) then
    raise exception using
      errcode = '23514',
      message = 'Pipeline run identity is immutable';
  end if;

  v_allowed := new.status = old.status
    or (old.status = 'queued' and new.status in ('running', 'failed', 'canceled'))
    or (old.status = 'running' and new.status in ('retrying', 'succeeded', 'failed', 'canceled'))
    or (old.status = 'retrying' and new.status in ('running', 'failed', 'canceled'))
    or (old.status in ('failed', 'canceled') and new.status = 'queued');

  if not v_allowed then
    raise exception using
      errcode = '23514',
      message = format(
        'Illegal pipeline run status transition: %s -> %s',
        old.status,
        new.status
      );
  end if;

  if new.attempt_count < old.attempt_count
    or new.attempt_count > old.attempt_count + 1 then
    raise exception using
      errcode = '23514',
      message = 'Pipeline run attempts must advance monotonically by at most one';
  end if;

  if new.status = 'running'
    and old.status in ('queued', 'retrying')
    and new.attempt_count <> old.attempt_count + 1 then
    raise exception using
      errcode = '23514',
      message = 'A claimed pipeline run must increment its attempt count exactly once';
  end if;

  if not (
    new.status = 'running'
    and old.status in ('queued', 'retrying')
  ) and new.attempt_count <> old.attempt_count then
    raise exception using
      errcode = '23514',
      message = 'Only a claimed pipeline run may increment its attempt count';
  end if;

  v_old_stage := array_position(
    array['queued', 'identifying', 'pricing', 'generating', 'persisting', 'completed'],
    old.stage
  );
  v_new_stage := array_position(
    array['queued', 'identifying', 'pricing', 'generating', 'persisting', 'completed'],
    new.stage
  );
  if new.status <> 'queued' and v_new_stage < v_old_stage then
    raise exception using
      errcode = '23514',
      message = format(
        'Pipeline run stage cannot regress: %s -> %s',
        old.stage,
        new.stage
      );
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.enforce_pipeline_run_transition()
  from public, anon, authenticated, service_role;

create or replace function private.guest_claim_credit_remap_allowed(
  p_old public.ai_item_credit_reservations,
  p_new public.ai_item_credit_reservations
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_recovery_id text := current_setting(
    'snaplist.guest_claim_recovery_id', true
  );
  v_lease_token text := current_setting(
    'snaplist.guest_claim_lease_token', true
  );
begin
  if coalesce(v_recovery_id, '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(v_lease_token, '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return false;
  end if;

  return (
    p_old.state = 'settled'
    and p_new.state = 'settled'
    and (
      p_new.pipeline_run_id,
      p_new.item_id,
      p_new.logical_run_key,
      p_new.reserved_at
    ) is not distinct from (
      p_old.pipeline_run_id,
      p_old.item_id,
      p_old.logical_run_key,
      p_old.reserved_at
    )
    and exists (
      select 1
      from private.guest_draft_recoveries recovery
      join public.ai_item_allowance_periods new_period
        on new_period.id = p_new.allowance_period_id
       and new_period.user_id = p_new.user_id
       and new_period.source = 'included'
       and new_period.period_key = 'included-first-run'
      where recovery.id = v_recovery_id::uuid
        and recovery.state = 'copying'
        and recovery.claim_lease_token = v_lease_token::uuid
        and recovery.reservation_id = p_old.id
        and recovery.allowance_period_id = p_old.allowance_period_id
        and recovery.pipeline_run_id = p_old.pipeline_run_id
        and recovery.item_id = p_old.item_id
        and recovery.guest_user_id = p_old.user_id
        and recovery.claim_target_user_id = p_new.user_id
        and p_new.photo_set_fingerprint = encode(
          sha256(convert_to(array_to_json(
            private.guest_manifest_destination_paths(
              recovery.storage_manifest,
              recovery.id,
              recovery.claim_target_user_id,
              recovery.claim_lease_token
            )
          )::text, 'UTF8')),
          'hex'
        )
    )
  );
end;
$$;

revoke all on function private.guest_claim_credit_remap_allowed(
  public.ai_item_credit_reservations,
  public.ai_item_credit_reservations
) from public, anon, authenticated, service_role;

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
  ) and not private.guest_claim_credit_remap_allowed(old, new) then
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

  if old.guided_correction_completed_at is not null
    and new.guided_correction_revision is distinct from old.guided_correction_revision then
    raise exception using
      errcode = '23514',
      message = 'Completed guided correction identity is immutable';
  end if;
  if old.guided_correction_completed_at is not null
    and new.guided_correction_started_at is distinct from old.guided_correction_started_at then
    raise exception using
      errcode = '23514',
      message = 'Completed guided correction start is immutable';
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

create or replace function private.queue_guest_recovery_storage_cleanup(
  p_recovery private.guest_draft_recoveries
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_paths text[];
begin
  v_paths := private.guest_manifest_source_paths(p_recovery.storage_manifest);
  if cardinality(v_paths) not between 1 and 4 then
    raise exception using
      errcode = '23514',
      message = 'Guest recovery has no bounded Storage cleanup manifest';
  end if;

  insert into private.pipeline_storage_cleanup_jobs (
    source_type,
    source_id,
    photo_paths
  ) values (
    'guest_recovery',
    p_recovery.id,
    v_paths
  )
  on conflict (source_type, source_id) do nothing;
end;
$$;

revoke all on function private.queue_guest_recovery_storage_cleanup(
  private.guest_draft_recoveries
) from public, anon, authenticated, service_role;

create or replace function private.queue_guest_claim_copy_cleanup(
  p_recovery private.guest_draft_recoveries,
  p_target_user_id text,
  p_claim_lease_token uuid,
  p_writer_quiesced boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_paths text[];
  v_available_at timestamptz := statement_timestamp() + interval '5 minutes';
begin
  if coalesce(char_length(p_target_user_id), 0) not between 1 and 255
    or p_target_user_id !~ '^[A-Za-z0-9_-]+$'
    or p_target_user_id = p_recovery.guest_user_id
    or p_claim_lease_token is null
    or p_recovery.storage_object_count not between 1 and 4 then
    raise exception using
      errcode = '23514',
      message = 'Guest claim copy cleanup requires an exact bounded lease';
  end if;

  if p_recovery.state = 'claimed'
    and p_recovery.claim_target_user_id = p_target_user_id
    and p_recovery.claimed_lease_token = p_claim_lease_token then
    return false;
  end if;

  v_paths := private.guest_claim_destination_paths(
    p_recovery.id,
    p_target_user_id,
    p_claim_lease_token,
    p_recovery.storage_object_count
  );
  if cardinality(v_paths) not between 1 and 4 then
    raise exception using
      errcode = '23514',
      message = 'Guest claim copy cleanup is not bounded';
  end if;

  if p_recovery.state = 'copying'
    and p_recovery.claim_target_user_id = p_target_user_id
    and p_recovery.claim_lease_token = p_claim_lease_token then
    v_available_at := greatest(
      v_available_at,
      p_recovery.claim_lease_expires_at + interval '5 minutes'
    );
  end if;

  insert into private.pipeline_storage_cleanup_jobs as cleanup_job (
    source_type,
    source_id,
    photo_paths,
    available_at,
    guest_copy_writer_quiesced,
    resweep_requested,
    guest_copy_final_sweep_armed
  ) values (
    'guest_claim_copy',
    p_claim_lease_token,
    v_paths,
    v_available_at,
    p_writer_quiesced,
    p_writer_quiesced,
    false
  )
  on conflict (source_type, source_id) do update
  set state = case
        when cleanup_job.state = 'dead'
          and excluded.guest_copy_writer_quiesced
          and not cleanup_job.guest_copy_final_sweep_armed
        then 'pending'
        else cleanup_job.state
      end,
      attempt_count = case
        when cleanup_job.state = 'dead'
          and excluded.guest_copy_writer_quiesced
          and not cleanup_job.guest_copy_final_sweep_armed
        then greatest(0, cleanup_job.max_attempts - 1)
        else cleanup_job.attempt_count
      end,
      available_at = case
        when cleanup_job.state = 'dead'
          and excluded.guest_copy_writer_quiesced
          and not cleanup_job.guest_copy_final_sweep_armed
        then statement_timestamp() + interval '5 minutes'
        else cleanup_job.available_at
      end,
      safe_error = case
        when cleanup_job.state = 'dead'
          and excluded.guest_copy_writer_quiesced
          and not cleanup_job.guest_copy_final_sweep_armed
        then null
        else cleanup_job.safe_error
      end,
      guest_copy_writer_quiesced =
        cleanup_job.guest_copy_writer_quiesced
        or excluded.guest_copy_writer_quiesced,
      resweep_requested = case
        when cleanup_job.state = 'dead'
          and excluded.guest_copy_writer_quiesced
          and not cleanup_job.guest_copy_final_sweep_armed
        then false
        else cleanup_job.resweep_requested
          or (
            excluded.resweep_requested
            and not cleanup_job.guest_copy_final_sweep_armed
          )
      end,
      guest_copy_final_sweep_armed =
        cleanup_job.guest_copy_final_sweep_armed
        or (
          cleanup_job.state = 'dead'
          and excluded.guest_copy_writer_quiesced
          and not cleanup_job.guest_copy_final_sweep_armed
        ),
      updated_at = statement_timestamp()
  where cleanup_job.source_type = 'guest_claim_copy';
  return true;
end;
$$;

revoke all on function private.queue_guest_claim_copy_cleanup(
  private.guest_draft_recoveries, text, uuid, boolean
) from public, anon, authenticated, service_role;

create or replace function public.complete_pipeline_storage_cleanup(
  p_job_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job private.pipeline_storage_cleanup_jobs%rowtype;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'Pipeline operations authorization is required';
  end if;

  select * into v_job
  from private.pipeline_storage_cleanup_jobs job
  where job.job_id = p_job_id
    and job.state = 'running'
    and job.lease_token = p_lease_token
    and job.lease_expires_at > statement_timestamp()
  for update;
  if not found then return false; end if;

  if v_job.source_type = 'guest_claim_copy'
    and v_job.resweep_requested
    and not v_job.guest_copy_final_sweep_armed then
    -- A quiescence signal that races the ordinary final attempt always earns
    -- one, and only one, post-writer sweep. Reusing the last attempt number
    -- keeps the existing bounded failure/dead-letter policy intact.
    update private.pipeline_storage_cleanup_jobs job
    set state = 'pending',
        attempt_count = greatest(0, v_job.max_attempts - 1),
        available_at = statement_timestamp() + interval '5 minutes',
        lease_token = null,
        lease_expires_at = null,
        resweep_requested = false,
        guest_copy_final_sweep_armed = true,
        safe_error = null,
        updated_at = statement_timestamp()
    where job.job_id = v_job.job_id;
    return true;
  end if;

  if v_job.source_type = 'guest_claim_copy'
    and not v_job.guest_copy_writer_quiesced then
    if v_job.attempt_count >= v_job.max_attempts then
      update private.pipeline_storage_cleanup_jobs job
      set state = 'dead',
          lease_token = null,
          lease_expires_at = null,
          safe_error = 'Guest claim copy cleanup requires reconciliation.',
          updated_at = statement_timestamp()
      where job.job_id = v_job.job_id;
    else
      update private.pipeline_storage_cleanup_jobs job
      set state = 'pending',
          available_at = statement_timestamp() + interval '5 minutes',
          lease_token = null,
          lease_expires_at = null,
          resweep_requested = false,
          safe_error = null,
          updated_at = statement_timestamp()
      where job.job_id = v_job.job_id;
    end if;
    return true;
  end if;

  delete from private.pipeline_storage_cleanup_jobs job
  where job.job_id = v_job.job_id;
  return found;
end;
$$;

revoke all on function public.complete_pipeline_storage_cleanup(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.complete_pipeline_storage_cleanup(uuid, uuid)
  to service_role;

create or replace function private.expire_guest_recovery_locked(
  p_recovery_id uuid
)
returns private.guest_draft_recoveries
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recovery private.guest_draft_recoveries%rowtype;
begin
  select * into v_recovery
  from private.guest_draft_recoveries recovery
  where recovery.id = p_recovery_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Guest recovery not found';
  end if;
  if v_recovery.state in ('claimed', 'expired')
    or statement_timestamp() < v_recovery.expires_at then
    return v_recovery;
  end if;

  delete from public.listings draft
  where draft.id = v_recovery.draft_id
    and draft.item_id = v_recovery.item_id
    and draft.user_id = v_recovery.guest_user_id
    and draft.status in ('draft', 'queued')
    and draft.ebay_listing_id is null
    and draft.ebay_status is distinct from 'publishing'
    and draft.ebay_status is distinct from 'published';

  if not found and exists (
    select 1
    from public.listings listing
    where listing.id = v_recovery.draft_id
  ) then
    raise exception using
      errcode = '55000',
      message = 'Guest expiry requires unclaimed draft evidence';
  end if;

  perform private.queue_guest_recovery_storage_cleanup(v_recovery);
  if v_recovery.state = 'copying' then
    perform private.queue_guest_claim_copy_cleanup(
      v_recovery,
      v_recovery.claim_target_user_id,
      v_recovery.claim_lease_token
    );
  end if;

  update public.pipeline_runs run
  set checkpoint = '{}'::jsonb,
      retention_cleaned_at = coalesce(
        run.retention_cleaned_at,
        statement_timestamp()
      )
  where run.id = v_recovery.pipeline_run_id
    and run.item_id = v_recovery.item_id
    and run.user_id = v_recovery.guest_user_id;

  update public.items item
  set attributes = '{}'::jsonb,
      condition = null,
      photos = '{}'::text[],
      identification = null,
      price_override = null,
      cost_basis = null,
      price_floor = null
  where item.id = v_recovery.item_id
    and item.user_id = v_recovery.guest_user_id;

  delete from public.notifications notification
  where notification.source_pipeline_run_id = v_recovery.pipeline_run_id
    and notification.user_id = v_recovery.guest_user_id;

  update private.guest_draft_recoveries recovery
  set state = 'expired',
      claim_target_user_id = null,
      claim_lease_token = null,
      claim_lease_expires_at = null,
      encrypted_artifact = null,
      storage_manifest = null,
      expired_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where recovery.id = v_recovery.id
    and recovery.state in ('claimable', 'copying')
  returning * into v_recovery;

  return v_recovery;
end;
$$;

revoke all on function private.expire_guest_recovery_locked(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.register_guest_draft_recovery(
  p_recovery_id uuid,
  p_guest_user_id text,
  p_pipeline_run_id uuid,
  p_recovery_token_hash text,
  p_encrypted_artifact jsonb,
  p_storage_manifest jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.pipeline_runs%rowtype;
  v_recovery private.guest_draft_recoveries%rowtype;
  v_reservation public.ai_item_credit_reservations%rowtype;
  v_object jsonb;
  v_source_paths text[];
  v_distinct_paths integer;
  v_distinct_nonces integer;
begin
  perform private.guest_claim_service_role_required();

  if p_recovery_id is null
    or p_pipeline_run_id is null
    or coalesce(char_length(p_guest_user_id), 0) not between 1 and 255
    or p_guest_user_id !~ '^[A-Za-z0-9_-]+$'
    or coalesce(p_recovery_token_hash, '') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_encrypted_artifact) is distinct from 'object'
    or p_encrypted_artifact - array[
      'version', 'algorithm', 'keyId', 'keyEnvelope', 'nonce', 'tag', 'ciphertext'
    ]::text[] <> '{}'::jsonb
    or not p_encrypted_artifact ?& array[
      'version', 'algorithm', 'keyId', 'keyEnvelope', 'nonce', 'tag', 'ciphertext'
    ]
    or p_encrypted_artifact->>'version' <> '1'
    or p_encrypted_artifact->>'algorithm' <> 'aes-256-gcm'
    or coalesce(p_encrypted_artifact->>'keyId', '') !~ '^[A-Za-z0-9_-]{1,128}$'
    or not coalesce(private.valid_guest_base64(
      p_encrypted_artifact->>'keyEnvelope',
      p_min_bytes => 1,
      p_max_bytes => 65536
    ), false)
    or not coalesce(private.valid_guest_base64(
      p_encrypted_artifact->>'nonce',
      p_exact_bytes => 12
    ), false)
    or not coalesce(private.valid_guest_base64(
      p_encrypted_artifact->>'tag',
      p_exact_bytes => 16
    ), false)
    or not coalesce(private.valid_guest_base64(
      p_encrypted_artifact->>'ciphertext',
      p_min_bytes => 1,
      p_max_bytes => 2097152
    ), false)
    or pg_column_size(p_encrypted_artifact) > 2 * 1024 * 1024
    or jsonb_typeof(p_storage_manifest) is distinct from 'array'
    or jsonb_array_length(p_storage_manifest) not between 1 and 4 then
    raise exception using
      errcode = '22023',
      message = 'Invalid encrypted guest recovery artifact';
  end if;

  for v_object in
    select entry.value
    from jsonb_array_elements(p_storage_manifest) entry(value)
  loop
    if jsonb_typeof(v_object) is distinct from 'object'
      or v_object - array[
        'sourcePath', 'sha256', 'byteLength', 'encryption'
      ]::text[]
        <> '{}'::jsonb
      or not v_object ?& array[
        'sourcePath', 'sha256', 'byteLength', 'encryption'
      ]
      or jsonb_typeof(v_object->'sourcePath') is distinct from 'string'
      or jsonb_typeof(v_object->'sha256') is distinct from 'string'
      or jsonb_typeof(v_object->'byteLength') is distinct from 'number'
      or jsonb_typeof(v_object->'encryption') is distinct from 'object'
      or (v_object->'encryption') - array[
        'algorithm', 'keyId', 'nonce', 'tag'
      ]::text[] <> '{}'::jsonb
      or not (v_object->'encryption') ?& array[
        'algorithm', 'keyId', 'nonce', 'tag'
      ]
      or v_object->'encryption'->>'algorithm' <> 'aes-256-gcm'
      or v_object->'encryption'->>'keyId' <> p_encrypted_artifact->>'keyId'
      or not coalesce(private.valid_guest_base64(
        v_object->'encryption'->>'nonce',
        p_exact_bytes => 12
      ), false)
      or not coalesce(private.valid_guest_base64(
        v_object->'encryption'->>'tag',
        p_exact_bytes => 16
      ), false)
      or left(
        v_object->>'sourcePath', char_length(p_guest_user_id) + 1
      ) <> p_guest_user_id || '/'
      or char_length(v_object->>'sourcePath') <= char_length(p_guest_user_id) + 1
      or v_object->>'sourcePath' like '%://%'
      or v_object->>'sourcePath' ~ '[?#]'
      or v_object->>'sourcePath' ~ '(^|/)\.\.?(/|$)'
      or char_length(v_object->>'sourcePath') > 1024
      or coalesce(v_object->>'sha256', '') !~ '^[0-9a-f]{64}$'
      or coalesce(v_object->>'byteLength', '') !~ '^[0-9]+$'
      or (v_object->>'byteLength')::bigint not between 1 and 52428800 then
      raise exception using
        errcode = '22023',
        message = 'Invalid private Storage recovery manifest';
    end if;
  end loop;

  v_source_paths := private.guest_manifest_source_paths(p_storage_manifest);
  select count(distinct entry.value->>'sourcePath')
  into v_distinct_paths
  from jsonb_array_elements(p_storage_manifest) entry(value);
  if v_distinct_paths <> cardinality(v_source_paths) then
    raise exception using
      errcode = '22023',
      message = 'Guest recovery Storage paths must be unique';
  end if;
  select count(distinct entry.value->'encryption'->>'nonce')
  into v_distinct_nonces
  from jsonb_array_elements(p_storage_manifest) entry(value);
  if v_distinct_nonces <> jsonb_array_length(p_storage_manifest)
    or exists (
      select 1
      from jsonb_array_elements(p_storage_manifest) entry(value)
      where entry.value->'encryption'->>'nonce' = p_encrypted_artifact->>'nonce'
    ) then
    raise exception using
      errcode = '22023',
      message = 'Guest recovery AES-GCM nonces must be unique';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('guest-recovery:' || p_recovery_id::text, 0)
  );

  select * into v_recovery
  from private.guest_draft_recoveries recovery
  where recovery.id = p_recovery_id
  for update;
  if found then
    if v_recovery.pipeline_run_id is distinct from p_pipeline_run_id
      or v_recovery.guest_user_id is distinct from p_guest_user_id
      or v_recovery.recovery_token_hash is distinct from p_recovery_token_hash
      or (
        v_recovery.state in ('claimable', 'copying')
        and (
          v_recovery.encrypted_artifact is distinct from p_encrypted_artifact
          or v_recovery.storage_manifest is distinct from p_storage_manifest
        )
      ) then
      raise exception using
        errcode = '23514',
        message = 'Guest recovery registration identity conflicts';
    end if;
    if v_recovery.state in ('claimed', 'expired') then
      return private.guest_terminal_outcome(v_recovery);
    end if;
    if statement_timestamp() >= v_recovery.expires_at then
      v_recovery := private.expire_guest_recovery_locked(v_recovery.id);
      return private.guest_terminal_outcome(v_recovery);
    end if;
    return jsonb_build_object(
      'outcome', 'recoverable',
      'recoveryId', v_recovery.id,
      'itemId', v_recovery.item_id,
      'runId', v_recovery.pipeline_run_id,
      'draftId', v_recovery.draft_id,
      'usableDraftAt', v_recovery.usable_draft_at,
      'expiresAt', v_recovery.expires_at,
      'encryptedArtifact', v_recovery.encrypted_artifact,
      'purgeLocalRecovery', false
    );
  end if;

  select * into v_recovery
  from private.guest_draft_recoveries recovery
  where recovery.pipeline_run_id = p_pipeline_run_id
  for update;
  if found then
    raise exception using
      errcode = '23514',
      message = 'Guest recovery run is already registered';
  end if;

  select * into v_run
  from public.pipeline_runs run
  where run.id = p_pipeline_run_id
    and run.user_id = p_guest_user_id
    and run.status = 'succeeded'
    and run.stage = 'completed'
    and run.completed_at is not null
    and run.listing_id is not null
  for update;
  if not found then
    raise exception using
      errcode = '55000',
      message = 'Guest recovery requires a durable usable draft';
  end if;

  select * into v_reservation
  from public.ai_item_credit_reservations reservation
  where reservation.pipeline_run_id = v_run.id
    and reservation.user_id = v_run.user_id
    and reservation.item_id = v_run.item_id
    and reservation.state = 'settled'
    and reservation.listing_id = v_run.listing_id
  for update;
  if not found
    or not exists (
      select 1
      from public.items item
      join public.listings draft
        on draft.id = v_run.listing_id
       and draft.item_id = item.id
       and draft.user_id = item.user_id
      join public.prediction_logs prediction
        on prediction.id = v_reservation.prediction_log_id
       and prediction.run_id = v_run.id
       and prediction.item_id = item.id
       and prediction.user_id = item.user_id
      where item.id = v_run.item_id
        and item.user_id = v_run.user_id
        and item.photos is not distinct from v_source_paths
        and draft.status in ('draft', 'queued')
        and draft.ebay_listing_id is null
        and draft.ebay_status is distinct from 'publishing'
        and draft.ebay_status is distinct from 'published'
    ) then
    raise exception using
      errcode = '55000',
      message = 'Guest recovery requires the exact settled draft evidence';
  end if;

  insert into private.guest_draft_recoveries (
    id,
    guest_user_id,
    pipeline_run_id,
    item_id,
    draft_id,
    reservation_id,
    allowance_period_id,
    recovery_token_hash,
    encrypted_artifact,
    storage_manifest,
    storage_object_count,
    usable_draft_at,
    expires_at
  ) values (
    p_recovery_id,
    p_guest_user_id,
    v_run.id,
    v_run.item_id,
    v_run.listing_id,
    v_reservation.id,
    v_reservation.allowance_period_id,
    p_recovery_token_hash,
    p_encrypted_artifact,
    p_storage_manifest,
    jsonb_array_length(p_storage_manifest),
    v_run.completed_at,
    v_run.completed_at + interval '24 hours'
  )
  returning * into v_recovery;

  if statement_timestamp() >= v_recovery.expires_at then
    v_recovery := private.expire_guest_recovery_locked(v_recovery.id);
    return private.guest_terminal_outcome(v_recovery);
  end if;

  return jsonb_build_object(
    'outcome', 'recoverable',
    'recoveryId', v_recovery.id,
    'itemId', v_recovery.item_id,
    'runId', v_recovery.pipeline_run_id,
    'draftId', v_recovery.draft_id,
    'usableDraftAt', v_recovery.usable_draft_at,
    'expiresAt', v_recovery.expires_at,
    'encryptedArtifact', v_recovery.encrypted_artifact,
    'purgeLocalRecovery', false
  );
end;
$$;

revoke all on function public.register_guest_draft_recovery(
  uuid, text, uuid, text, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.register_guest_draft_recovery(
  uuid, text, uuid, text, jsonb, jsonb
) to service_role;

create or replace function public.recover_guest_draft(
  p_recovery_id uuid,
  p_guest_user_id text,
  p_recovery_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recovery private.guest_draft_recoveries%rowtype;
begin
  perform private.guest_claim_service_role_required();
  perform pg_advisory_xact_lock(
    hashtextextended('guest-recovery:' || p_recovery_id::text, 0)
  );
  select * into v_recovery
  from private.guest_draft_recoveries recovery
  where recovery.id = p_recovery_id
    and recovery.guest_user_id = p_guest_user_id
    and recovery.recovery_token_hash = p_recovery_token_hash
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Guest recovery not found';
  end if;

  if v_recovery.state not in ('claimed', 'expired')
    and statement_timestamp() >= v_recovery.expires_at then
    v_recovery := private.expire_guest_recovery_locked(v_recovery.id);
  end if;
  if v_recovery.state in ('claimed', 'expired') then
    return private.guest_terminal_outcome(v_recovery);
  end if;

  return jsonb_build_object(
    'outcome', 'recoverable',
    'recoveryId', v_recovery.id,
    'itemId', v_recovery.item_id,
    'runId', v_recovery.pipeline_run_id,
    'draftId', v_recovery.draft_id,
    'usableDraftAt', v_recovery.usable_draft_at,
    'expiresAt', v_recovery.expires_at,
    'encryptedArtifact', v_recovery.encrypted_artifact,
    'purgeLocalRecovery', false
  );
end;
$$;

revoke all on function public.recover_guest_draft(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.recover_guest_draft(uuid, text, text)
  to service_role;

create or replace function public.begin_guest_draft_claim(
  p_recovery_id uuid,
  p_guest_user_id text,
  p_recovery_token_hash text,
  p_target_user_id text,
  p_idempotency_key uuid,
  p_claim_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recovery private.guest_draft_recoveries%rowtype;
  v_objects jsonb;
  v_retry_after integer;
  v_bound_recovery_id uuid;
begin
  perform private.guest_claim_service_role_required();
  if coalesce(char_length(p_target_user_id), 0) not between 1 and 255
    or p_target_user_id !~ '^[A-Za-z0-9_-]+$'
    or p_target_user_id = p_guest_user_id
    or p_idempotency_key is null
    or p_claim_lease_seconds not between 30 and 3600 then
    raise exception using errcode = '22023', message = 'Invalid guest claim request';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'guest-claim-idempotency:' || p_target_user_id || ':'
        || p_idempotency_key::text,
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended('guest-recovery:' || p_recovery_id::text, 0)
  );
  select * into v_recovery
  from private.guest_draft_recoveries recovery
  where recovery.id = p_recovery_id
    and recovery.guest_user_id = p_guest_user_id
    and recovery.recovery_token_hash = p_recovery_token_hash
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Guest recovery not found';
  end if;

  if v_recovery.claim_idempotency_user_id is not null then
    if v_recovery.claim_idempotency_user_id is distinct from p_target_user_id then
      raise exception using errcode = 'P0002', message = 'Guest recovery not found';
    end if;
    if v_recovery.claim_idempotency_key is distinct from p_idempotency_key then
      raise exception using
        errcode = '23505',
        message = 'Guest claim Idempotency-Key is already bound';
    end if;
  end if;

  select recovery.id into v_bound_recovery_id
  from private.guest_draft_recoveries recovery
  where recovery.claim_idempotency_user_id = p_target_user_id
    and recovery.claim_idempotency_key = p_idempotency_key;
  if found and v_bound_recovery_id <> v_recovery.id then
    raise exception using
      errcode = '23505',
      message = 'Guest claim Idempotency-Key is already bound';
  end if;

  if v_recovery.claim_idempotency_key is null then
    update private.guest_draft_recoveries recovery
    set claim_idempotency_user_id = p_target_user_id,
        claim_idempotency_key = p_idempotency_key,
        updated_at = statement_timestamp()
    where recovery.id = v_recovery.id
    returning * into v_recovery;
  end if;

  if v_recovery.state not in ('claimed', 'expired')
    and statement_timestamp() >= v_recovery.expires_at then
    v_recovery := private.expire_guest_recovery_locked(v_recovery.id);
  end if;
  if v_recovery.state in ('claimed', 'expired') then
    return private.guest_terminal_outcome_for_target(
      v_recovery, p_target_user_id
    );
  end if;

  if v_recovery.state = 'copying'
    and v_recovery.claim_lease_expires_at > statement_timestamp() then
    v_retry_after := greatest(
      1,
      ceil(extract(epoch from (
        v_recovery.claim_lease_expires_at - statement_timestamp()
      )))::integer
    );
    return jsonb_build_object(
      'outcome', 'in_progress',
      'retryAfterSeconds', v_retry_after
    );
  end if;

  if v_recovery.state = 'copying' then
    -- A new lease always receives a new destination namespace. Persist cleanup
    -- for the obsolete lease before replacing its only durable authority.
    perform private.queue_guest_claim_copy_cleanup(
      v_recovery,
      v_recovery.claim_target_user_id,
      v_recovery.claim_lease_token
    );
  end if;

  update private.guest_draft_recoveries recovery
  set state = 'copying',
      claim_target_user_id = p_target_user_id,
      claim_lease_token = gen_random_uuid(),
      claim_lease_expires_at = statement_timestamp()
        + make_interval(secs => p_claim_lease_seconds),
      updated_at = statement_timestamp()
  where recovery.id = v_recovery.id
  returning * into v_recovery;

  select jsonb_agg(
    jsonb_build_object(
      'sourcePath', entry.value->>'sourcePath',
      'destinationPath', p_target_user_id || '/guest-claims/'
        || v_recovery.id::text || '/' || v_recovery.claim_lease_token::text
        || '/' || entry.ordinality::text,
      'sha256', entry.value->>'sha256',
      'byteLength', (entry.value->>'byteLength')::bigint,
      'encryption', entry.value->'encryption'
    ) order by entry.ordinality
  ) into v_objects
  from jsonb_array_elements(v_recovery.storage_manifest)
    with ordinality entry(value, ordinality);

  return jsonb_build_object(
    'outcome', 'copy_required',
    'claimLeaseToken', v_recovery.claim_lease_token,
    'expiresAt', v_recovery.expires_at,
    'itemId', v_recovery.item_id,
    'runId', v_recovery.pipeline_run_id,
    'draftId', v_recovery.draft_id,
    'objects', v_objects
  );
end;
$$;

revoke all on function public.begin_guest_draft_claim(
  uuid, text, text, text, uuid, integer
) from public, anon, authenticated;
grant execute on function public.begin_guest_draft_claim(
  uuid, text, text, text, uuid, integer
) to service_role;

create or replace function public.queue_guest_claim_copy_cleanup(
  p_recovery_id uuid,
  p_recovery_token_hash text,
  p_target_user_id text,
  p_idempotency_key uuid,
  p_claim_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recovery private.guest_draft_recoveries%rowtype;
begin
  perform private.guest_claim_service_role_required();
  if coalesce(char_length(p_target_user_id), 0) not between 1 and 255
    or p_target_user_id !~ '^[A-Za-z0-9_-]+$'
    or p_idempotency_key is null
    or p_claim_lease_token is null then
    raise exception using errcode = '22023', message = 'Invalid guest cleanup request';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('guest-recovery:' || p_recovery_id::text, 0)
  );
  select * into v_recovery
  from private.guest_draft_recoveries recovery
  where recovery.id = p_recovery_id
    and recovery.recovery_token_hash = p_recovery_token_hash
    and recovery.claim_idempotency_user_id = p_target_user_id
    and recovery.claim_idempotency_key = p_idempotency_key
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Guest recovery not found';
  end if;

  return private.queue_guest_claim_copy_cleanup(
    v_recovery,
    p_target_user_id,
    p_claim_lease_token,
    true
  );
end;
$$;

revoke all on function public.queue_guest_claim_copy_cleanup(
  uuid, text, text, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.queue_guest_claim_copy_cleanup(
  uuid, text, text, uuid, uuid
) to service_role;

create or replace function public.release_guest_draft_claim(
  p_recovery_id uuid,
  p_recovery_token_hash text,
  p_target_user_id text,
  p_claim_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recovery private.guest_draft_recoveries%rowtype;
begin
  perform private.guest_claim_service_role_required();
  if coalesce(char_length(p_target_user_id), 0) not between 1 and 255
    or p_target_user_id !~ '^[A-Za-z0-9_-]+$' then
    raise exception using errcode = '22023', message = 'Invalid guest claim request';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('guest-recovery:' || p_recovery_id::text, 0)
  );
  select * into v_recovery
  from private.guest_draft_recoveries recovery
  where recovery.id = p_recovery_id
    and recovery.recovery_token_hash = p_recovery_token_hash
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Guest recovery not found';
  end if;

  if v_recovery.state not in ('claimed', 'expired')
    and statement_timestamp() >= v_recovery.expires_at then
    v_recovery := private.expire_guest_recovery_locked(v_recovery.id);
  end if;
  if v_recovery.state in ('claimed', 'expired') then
    return private.guest_terminal_outcome_for_target(
      v_recovery, p_target_user_id
    );
  end if;

  if v_recovery.state = 'copying'
    and v_recovery.claim_target_user_id = p_target_user_id
    and v_recovery.claim_lease_token = p_claim_lease_token then
    -- The cleanup job and lease release commit together. Paths are unique to
    -- this lease, so a later successful retry can never be deleted by it.
    perform private.queue_guest_claim_copy_cleanup(
      v_recovery,
      p_target_user_id,
      p_claim_lease_token,
      true
    );
  end if;

  update private.guest_draft_recoveries recovery
  set state = 'claimable',
      claim_target_user_id = null,
      claim_lease_token = null,
      claim_lease_expires_at = null,
      updated_at = statement_timestamp()
  where recovery.id = v_recovery.id
    and recovery.state = 'copying'
    and recovery.claim_target_user_id = p_target_user_id
    and recovery.claim_lease_token = p_claim_lease_token;

  if found then
    return jsonb_build_object('outcome', 'released');
  end if;
  return jsonb_build_object('outcome', 'claimable');
end;
$$;

revoke all on function public.release_guest_draft_claim(uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.release_guest_draft_claim(uuid, text, text, uuid)
  to service_role;

create or replace function public.resolve_guest_recovery_outcome(
  p_recovery_id uuid,
  p_recovery_token_hash text,
  p_target_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recovery private.guest_draft_recoveries%rowtype;
begin
  perform private.guest_claim_service_role_required();
  if coalesce(char_length(p_target_user_id), 0) not between 1 and 255
    or p_target_user_id !~ '^[A-Za-z0-9_-]+$' then
    raise exception using errcode = '22023', message = 'Invalid guest claim request';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('guest-recovery:' || p_recovery_id::text, 0)
  );
  select * into v_recovery
  from private.guest_draft_recoveries recovery
  where recovery.id = p_recovery_id
    and recovery.recovery_token_hash = p_recovery_token_hash
    and (
      recovery.state in ('claimable', 'expired')
      or recovery.claim_target_user_id = p_target_user_id
    )
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Guest recovery not found';
  end if;

  if v_recovery.state not in ('claimed', 'expired')
    and statement_timestamp() >= v_recovery.expires_at then
    v_recovery := private.expire_guest_recovery_locked(v_recovery.id);
  end if;
  if v_recovery.state in ('claimed', 'expired') then
    return private.guest_terminal_outcome_for_target(
      v_recovery, p_target_user_id
    );
  end if;
  return jsonb_build_object('outcome', 'claimable');
end;
$$;

revoke all on function public.resolve_guest_recovery_outcome(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.resolve_guest_recovery_outcome(uuid, text, text)
  to service_role;

create or replace function public.complete_guest_draft_claim(
  p_recovery_id uuid,
  p_recovery_token_hash text,
  p_target_user_id text,
  p_claim_lease_token uuid,
  p_verified_objects jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recovery private.guest_draft_recoveries%rowtype;
  v_reservation public.ai_item_credit_reservations%rowtype;
  v_guest_period public.ai_item_allowance_periods%rowtype;
  v_target_period public.ai_item_allowance_periods%rowtype;
  v_expected_objects jsonb;
  v_destination_paths text[];
  v_new_fingerprint text;
  v_lock_user text;
  v_target_used integer;
begin
  perform private.guest_claim_service_role_required();
  if coalesce(char_length(p_target_user_id), 0) not between 1 and 255
    or p_target_user_id !~ '^[A-Za-z0-9_-]+$' then
    raise exception using errcode = '22023', message = 'Invalid guest claim request';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('guest-recovery:' || p_recovery_id::text, 0)
  );
  select * into v_recovery
  from private.guest_draft_recoveries recovery
  where recovery.id = p_recovery_id
    and recovery.recovery_token_hash = p_recovery_token_hash
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Guest recovery not found';
  end if;

  if v_recovery.state not in ('claimed', 'expired')
    and statement_timestamp() >= v_recovery.expires_at then
    v_recovery := private.expire_guest_recovery_locked(v_recovery.id);
  end if;
  if v_recovery.state in ('claimed', 'expired') then
    return private.guest_terminal_outcome_for_target(
      v_recovery, p_target_user_id
    );
  end if;
  if v_recovery.state <> 'copying'
    or v_recovery.claim_target_user_id is distinct from p_target_user_id
    or v_recovery.claim_lease_token is distinct from p_claim_lease_token
    or v_recovery.claim_lease_expires_at <= statement_timestamp() then
    raise exception using errcode = '55000', message = 'Guest claim lease is stale';
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'destinationPath', p_target_user_id || '/guest-claims/'
        || v_recovery.id::text || '/' || p_claim_lease_token::text
        || '/' || entry.ordinality::text,
      'sha256', entry.value->>'sha256',
      'byteLength', (entry.value->>'byteLength')::bigint,
      'encryption', entry.value->'encryption'
    ) order by entry.ordinality
  ) into v_expected_objects
  from jsonb_array_elements(v_recovery.storage_manifest)
    with ordinality entry(value, ordinality);
  if jsonb_typeof(p_verified_objects) is distinct from 'array'
    or p_verified_objects is distinct from v_expected_objects then
    raise exception using
      errcode = '23514',
      message = 'Every account Storage object must be copied and verified';
  end if;

  -- Retention takes this scheduler-neutral lock before item/run/reservation.
  -- Claim follows that order; retention's try-lock simply skips while claim wins.
  perform pg_advisory_xact_lock(
    hashtextextended('snaplist:pipeline-retention', 0)
  );
  for v_lock_user in
    select value
    from unnest(array[v_recovery.guest_user_id, p_target_user_id]) value
    order by value
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('ai-item-credit:' || v_lock_user, 0)
    );
  end loop;

  perform item.id
  from public.items item
  where item.id = v_recovery.item_id
    and item.user_id = v_recovery.guest_user_id
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'Guest item ownership changed';
  end if;

  perform run.id
  from public.pipeline_runs run
  where run.id = v_recovery.pipeline_run_id
    and run.item_id = v_recovery.item_id
    and run.user_id = v_recovery.guest_user_id
    and run.status = 'succeeded'
  order by run.id
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'Guest run ownership changed';
  end if;

  select * into v_reservation
  from public.ai_item_credit_reservations reservation
  where reservation.id = v_recovery.reservation_id
    and reservation.pipeline_run_id = v_recovery.pipeline_run_id
    and reservation.item_id = v_recovery.item_id
    and reservation.user_id = v_recovery.guest_user_id
    and reservation.state = 'settled'
    and reservation.listing_id = v_recovery.draft_id
    and (
      reservation.guided_correction_started_at is null
      or reservation.guided_correction_completed_at is not null
    )
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'Settled guest credit changed';
  end if;

  if exists (
    select 1 from public.messages message
    where message.item_id = v_recovery.item_id
      and message.user_id = v_recovery.guest_user_id
  ) or exists (
    select 1 from public.embeddings embedding
    where embedding.item_id = v_recovery.item_id
      and embedding.user_id = v_recovery.guest_user_id
  ) or exists (
    select 1 from public.reprice_suggestions suggestion
    where suggestion.item_id = v_recovery.item_id
      and suggestion.user_id = v_recovery.guest_user_id
  ) or exists (
    select 1 from public.message_policy_decisions decision
    where decision.listing_id = v_recovery.draft_id
      and decision.user_id = v_recovery.guest_user_id
  ) then
    raise exception using
      errcode = '55000',
      message = 'Guest claim contains unsupported post-draft records';
  end if;

  perform draft.id
    from public.listings draft
    join public.items item
      on item.id = draft.item_id
     and item.user_id = draft.user_id
    join public.prediction_logs prediction
      on prediction.run_id = draft.run_id
     and prediction.item_id = v_recovery.item_id
     and prediction.user_id = v_recovery.guest_user_id
    where draft.id = v_recovery.draft_id
      and draft.item_id = v_recovery.item_id
      and draft.user_id = v_recovery.guest_user_id
      and draft.status in ('draft', 'queued')
      and draft.ebay_listing_id is null
      and draft.ebay_status is distinct from 'publishing'
      and draft.ebay_status is distinct from 'published'
      and jsonb_typeof(item.attributes) = 'object'
      and item.attributes <> '{}'::jsonb
      and jsonb_typeof(item.identification) = 'object'
      and item.review_revision is not distinct from item.review_content_revision
      and draft.source_review_revision is not distinct from item.review_revision
      and prediction.price > 0
      and jsonb_typeof(prediction.price_range) = 'object'
      and prediction.confidence between 0 and 1
      and coalesce(btrim(prediction.tier_fired), '') <> ''
      and jsonb_typeof(prediction.sources) = 'array'
      and (
        jsonb_array_length(prediction.sources) > 0
        or prediction.tier_fired = 'llm-only'
      )
      and draft.platform = 'ebay'
      and coalesce(btrim(draft.title), '') <> ''
      and char_length(draft.title) <= 80
      and coalesce(btrim(draft.description), '') <> ''
      and exists (
        select 1
        from public.prediction_logs settled_prediction
        where settled_prediction.id = v_reservation.prediction_log_id
          and settled_prediction.run_id = v_recovery.pipeline_run_id
          and settled_prediction.item_id = v_recovery.item_id
          and settled_prediction.user_id = v_recovery.guest_user_id
      )
  for update of draft, prediction;
  if not found then
    raise exception using errcode = '55000', message = 'Guest draft is no longer claimable';
  end if;

  set constraints
    public.listings_item_user_fkey,
    public.pipeline_runs_item_user_fkey,
    public.pipeline_runs_listing_item_user_fkey,
    public.notifications_source_pipeline_run_user_fkey,
    public.ai_item_credit_reservations_period_fkey,
    public.ai_item_credit_reservations_pipeline_run_fkey
  deferred;

  select * into v_guest_period
  from public.ai_item_allowance_periods period
  where period.id = v_reservation.allowance_period_id
    and period.user_id = v_recovery.guest_user_id
    and period.source = 'included'
    and period.period_key = 'included-first-run'
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'Guest included allowance changed';
  end if;

  select * into v_target_period
  from public.ai_item_allowance_periods period
  where period.user_id = p_target_user_id
    and period.source = 'included'
    and period.period_key = 'included-first-run'
  for update;
  if found then
    select count(*) into v_target_used
    from public.ai_item_credit_reservations reservation
    where reservation.allowance_period_id = v_target_period.id
      and reservation.state in ('reserved', 'settled');
    if v_target_used > 0 then
      raise exception using
        errcode = '23505',
        message = 'Account included credit is already bound to another run';
    end if;
  else
    if exists (
      select 1
      from public.ai_item_credit_reservations reservation
      where reservation.allowance_period_id = v_guest_period.id
        and reservation.id <> v_reservation.id
    ) then
      -- Preserve restored guest attempts on their original accounting period.
      -- This creates only the canonical account period container; the exact
      -- settled reservation below immediately consumes it. No reservation or
      -- spendable credit event is created.
      insert into public.ai_item_allowance_periods (
        user_id,
        source,
        period_key,
        period_start,
        expires_date,
        state,
        allowance
      ) values (
        p_target_user_id,
        'included',
        'included-first-run',
        '-infinity'::timestamptz,
        'infinity'::timestamptz,
        'active',
        1
      )
      on conflict (user_id, source, period_key) do nothing;

      select * into v_target_period
      from public.ai_item_allowance_periods period
      where period.user_id = p_target_user_id
        and period.source = 'included'
        and period.period_key = 'included-first-run'
      for update;
      if not found then
        raise exception using
          errcode = '55000',
          message = 'Account included allowance could not be bound';
      end if;
    else
      update public.ai_item_allowance_periods period
      set user_id = p_target_user_id,
          updated_at = statement_timestamp()
      where period.id = v_guest_period.id
      returning * into v_target_period;
    end if;
  end if;

  perform set_config(
    'snaplist.guest_claim_recovery_id', v_recovery.id::text, true
  );
  perform set_config(
    'snaplist.guest_claim_lease_token', p_claim_lease_token::text, true
  );

  v_destination_paths := private.guest_manifest_destination_paths(
    v_recovery.storage_manifest,
    v_recovery.id,
    p_target_user_id,
    p_claim_lease_token
  );
  v_new_fingerprint := encode(
    sha256(convert_to(array_to_json(v_destination_paths)::text, 'UTF8')),
    'hex'
  );

  update public.items item
  set user_id = p_target_user_id,
      photos = v_destination_paths
  where item.id = v_recovery.item_id
    and item.user_id = v_recovery.guest_user_id;

  update public.pipeline_runs run
  set user_id = p_target_user_id
  where run.id = v_recovery.pipeline_run_id
    and run.user_id = v_recovery.guest_user_id;

  update public.listings draft
  set user_id = p_target_user_id
  where draft.id = v_recovery.draft_id
    and draft.user_id = v_recovery.guest_user_id;

  update public.prediction_logs prediction
  set user_id = p_target_user_id
  where prediction.item_id = v_recovery.item_id
    and prediction.user_id = v_recovery.guest_user_id;

  update public.notifications notification
  set user_id = p_target_user_id
  where notification.source_pipeline_run_id = v_recovery.pipeline_run_id
    and notification.user_id = v_recovery.guest_user_id;

  update private.pipeline_run_usage_reservations usage
  set user_id = p_target_user_id
  where usage.run_id = v_recovery.pipeline_run_id
    and usage.user_id = v_recovery.guest_user_id;

  update public.ai_item_credit_reservations reservation
  set user_id = p_target_user_id,
      allowance_period_id = v_target_period.id,
      photo_set_fingerprint = v_new_fingerprint,
      updated_at = statement_timestamp()
  where reservation.id = v_recovery.reservation_id
    and reservation.state = 'settled';

  if v_target_period.id <> v_guest_period.id then
    delete from public.ai_item_allowance_periods period
    where period.id = v_guest_period.id
      and not exists (
        select 1
        from public.ai_item_credit_reservations reservation
        where reservation.allowance_period_id = period.id
      );
  end if;

  perform private.queue_guest_recovery_storage_cleanup(v_recovery);

  update private.guest_draft_recoveries recovery
  set state = 'claimed',
      claimed_lease_token = p_claim_lease_token,
      claim_lease_token = null,
      claim_lease_expires_at = null,
      storage_manifest = null,
      claimed_storage_manifest = p_verified_objects,
      claimed_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where recovery.id = v_recovery.id
    and recovery.state = 'copying'
    and recovery.claim_lease_token = p_claim_lease_token
  returning * into v_recovery;
  if not found then
    raise exception using errcode = '55000', message = 'Guest claim lost its lease';
  end if;

  return private.guest_terminal_outcome_for_target(
    v_recovery, p_target_user_id
  );
end;
$$;

revoke all on function public.complete_guest_draft_claim(
  uuid, text, text, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.complete_guest_draft_claim(
  uuid, text, text, uuid, jsonb
) to service_role;

create or replace function public.expire_guest_draft_recoveries(
  p_batch_size integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recovery record;
  v_expired integer := 0;
begin
  perform private.guest_claim_service_role_required();
  if p_batch_size not between 1 and 100 then
    raise exception using
      errcode = '22023',
      message = 'Guest recovery expiry batch must be between 1 and 100';
  end if;

  if not pg_try_advisory_xact_lock(
    hashtextextended('snaplist:guest-recovery-expiry', 0)
  ) then
    return jsonb_build_object('expiredCount', 0, 'skippedForLock', true);
  end if;

  for v_recovery in
    select recovery.id
    from private.guest_draft_recoveries recovery
    where recovery.state in ('claimable', 'copying')
      and recovery.expires_at <= statement_timestamp()
    order by recovery.expires_at, recovery.id
    for update of recovery skip locked
    limit p_batch_size
  loop
    perform private.expire_guest_recovery_locked(v_recovery.id);
    v_expired := v_expired + 1;
  end loop;

  return jsonb_build_object(
    'expiredCount', v_expired,
    'skippedForLock', false
  );
end;
$$;

revoke all on function public.expire_guest_draft_recoveries(integer)
  from public, anon, authenticated;
grant execute on function public.expire_guest_draft_recoveries(integer)
  to service_role;
