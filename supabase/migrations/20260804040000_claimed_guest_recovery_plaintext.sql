-- Issue #640: a successful guest claim owns plaintext, never a copied
-- ciphertext envelope. The existing claim predicate remains authoritative;
-- this additive consumer wraps it with verified decryption receipts, transfers
-- immutable review evidence, and removes the guest envelope before commit.

do $$
begin
  if exists (
    select 1
    from private.guest_draft_recoveries recovery
    where recovery.state = 'claimed'
  ) then
    raise exception using
      errcode = '55000',
      message = 'Claimed guest recovery migration requires zero legacy claimed rows';
  end if;
end;
$$;

alter table public.pricing_evidence_snapshots
  alter constraint pricing_evidence_snapshots_run_fkey
    deferrable initially immediate,
  alter constraint pricing_evidence_snapshots_prediction_fkey
    deferrable initially immediate,
  alter constraint pricing_evidence_snapshots_listing_fkey
    deferrable initially immediate;

alter table private.guest_draft_recoveries
  add column claim_completion_token_hash text,
  add constraint guest_draft_recoveries_claim_completion_token_hash_check
    check (
      claim_completion_token_hash is null
      or claim_completion_token_hash ~ '^[0-9a-f]{64}$'
    );

comment on column private.guest_draft_recoveries.claim_completion_token_hash is
  'SHA-256 digest of the ephemeral server-only capability for the current plaintext copy lease; cleared on lease replacement or terminal state.';

create or replace function private.clear_guest_claim_completion_capability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state <> 'copying'
    or new.claim_lease_token is distinct from old.claim_lease_token then
    new.claim_completion_token_hash := null;
  end if;
  return new;
end;
$$;

revoke all on function private.clear_guest_claim_completion_capability()
  from public, anon, authenticated, service_role;

drop trigger if exists guest_draft_recoveries_clear_completion_capability
  on private.guest_draft_recoveries;
create trigger guest_draft_recoveries_clear_completion_capability
before update on private.guest_draft_recoveries
for each row execute function private.clear_guest_claim_completion_capability();

alter table private.guest_draft_recoveries
  drop constraint guest_draft_recoveries_material_check;
alter table private.guest_draft_recoveries
  add constraint guest_draft_recoveries_material_check check (
    (
      state in ('claimable', 'copying')
      and encrypted_artifact is not null
      and storage_manifest is not null
    )
    or (
      state = 'claimed'
      and storage_manifest is null
    )
    or (
      state = 'expired'
      and encrypted_artifact is null
      and storage_manifest is null
    )
  );

comment on table private.guest_draft_recoveries is
  'Opaque encrypted guest recovery until claim. Claimed rows retain only plaintext verification receipts; expired rows retain identifiers only.';
comment on column private.guest_draft_recoveries.claimed_storage_manifest is
  'Account-owned plaintext verification receipts. No ciphertext digest, encryption metadata, or key id survives claim.';

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
  return private.guest_terminal_outcome(p_recovery);
end;
$$;

revoke all on function private.guest_terminal_outcome_for_target(
  private.guest_draft_recoveries, text
) from public, anon, authenticated, service_role;

create or replace function public.begin_guest_draft_claim_with_plaintext(
  p_recovery_id uuid,
  p_guest_user_id text,
  p_recovery_token_hash text,
  p_target_user_id text,
  p_idempotency_key uuid,
  p_claim_lease_seconds integer,
  p_completion_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outcome jsonb;
  v_claim_lease_token uuid;
begin
  perform private.guest_claim_service_role_required();
  if coalesce(p_completion_token_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'Invalid guest claim completion capability';
  end if;

  v_outcome := public.begin_guest_draft_claim(
    p_recovery_id,
    p_guest_user_id,
    p_recovery_token_hash,
    p_target_user_id,
    p_idempotency_key,
    p_claim_lease_seconds
  );
  if v_outcome->>'outcome' <> 'copy_required' then
    return v_outcome;
  end if;

  v_claim_lease_token := (v_outcome->>'claimLeaseToken')::uuid;
  update private.guest_draft_recoveries recovery
  set claim_completion_token_hash = p_completion_token_hash,
      updated_at = statement_timestamp()
  where recovery.id = p_recovery_id
    and recovery.recovery_token_hash = p_recovery_token_hash
    and recovery.state = 'copying'
    and recovery.claim_target_user_id = p_target_user_id
    and recovery.claim_idempotency_user_id = p_target_user_id
    and recovery.claim_idempotency_key = p_idempotency_key
    and recovery.claim_lease_token = v_claim_lease_token;
  if not found then
    raise exception using
      errcode = '55000',
      message = 'Guest claim lost its completion capability lease';
  end if;
  return v_outcome;
end;
$$;

revoke all on function public.begin_guest_draft_claim_with_plaintext(
  uuid, text, text, text, uuid, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.begin_guest_draft_claim_with_plaintext(
  uuid, text, text, text, uuid, integer, text
) to service_role;

comment on function public.begin_guest_draft_claim_with_plaintext(
  uuid, text, text, text, uuid, integer, text
) is
  'Server-only claim start: delegates to the authoritative predicate and binds a one-use completion capability digest to the exact plaintext copy lease.';

create or replace function private.enforce_claimed_guest_envelope_purged()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recovery private.guest_draft_recoveries%rowtype;
begin
  select * into v_recovery
  from private.guest_draft_recoveries recovery
  where recovery.id = new.id;

  if found
    and v_recovery.state = 'claimed'
    and (
      v_recovery.encrypted_artifact is not null
      or v_recovery.storage_manifest is not null
      or v_recovery.claimed_storage_manifest is null
    ) then
    raise exception using
      errcode = '23514',
      message = 'Claimed guest recovery cannot retain an encrypted envelope';
  end if;
  return null;
end;
$$;

revoke all on function private.enforce_claimed_guest_envelope_purged()
  from public, anon, authenticated, service_role;

drop trigger if exists guest_draft_recoveries_claimed_envelope_purged
  on private.guest_draft_recoveries;
create constraint trigger guest_draft_recoveries_claimed_envelope_purged
after insert or update on private.guest_draft_recoveries
deferrable initially deferred
for each row execute function private.enforce_claimed_guest_envelope_purged();

create or replace function public.complete_guest_draft_claim_with_plaintext(
  p_recovery_id uuid,
  p_recovery_token_hash text,
  p_target_user_id text,
  p_claim_lease_token uuid,
  p_completion_token text,
  p_verified_objects jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authenticated_user_id text := public.clerk_user_id();
  v_request_jwt_claims text := current_setting('request.jwt.claims', true);
  v_recovery private.guest_draft_recoveries%rowtype;
  v_manifest_object jsonb;
  v_verified_object jsonb;
  v_position integer;
  v_expected_ciphertext_receipts jsonb;
  v_plaintext_receipts jsonb;
  v_outcome jsonb;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'authenticated'
    or v_authenticated_user_id = '' then
    raise exception using
      errcode = '42501',
      message = 'Authenticated guest claim completion is required';
  end if;
  if p_target_user_id is distinct from v_authenticated_user_id then
    raise exception using
      errcode = '42501',
      message = 'Guest claim target must match the authenticated seller';
  end if;
  -- Snapshot-only receipt preflight. The nested authoritative claim function
  -- owns the advisory + row locks. Locking here would keep an older outer
  -- statement snapshot across an expiry wait and hide expiry's cleanup row.
  select * into v_recovery
  from private.guest_draft_recoveries recovery
  where recovery.id = p_recovery_id
    and recovery.recovery_token_hash = p_recovery_token_hash;
  if not found then
    raise exception using errcode = 'P0002', message = 'Guest recovery not found';
  end if;
  if v_recovery.state in ('claimed', 'expired') then
    return private.guest_terminal_outcome_for_target(
      v_recovery, p_target_user_id
    );
  end if;
  if coalesce(p_completion_token, '') !~ '^[0-9a-f]{64}$'
    or v_recovery.claim_completion_token_hash is null
    or v_recovery.claim_completion_token_hash is distinct from
      encode(sha256(convert_to(p_completion_token, 'UTF8')), 'hex') then
    raise exception using
      errcode = '42501',
      message = 'Guest claim completion capability is invalid';
  end if;
  if v_recovery.state <> 'copying'
    or v_recovery.claim_target_user_id is distinct from p_target_user_id
    or v_recovery.claim_lease_token is distinct from p_claim_lease_token then
    raise exception using errcode = '55000', message = 'Guest claim lease is stale';
  end if;
  if jsonb_typeof(p_verified_objects) is distinct from 'array'
    or jsonb_array_length(p_verified_objects)
      is distinct from v_recovery.storage_object_count then
    raise exception using
      errcode = '23514',
      message = 'Every account Storage object must be decrypted and verified';
  end if;

  for v_manifest_object, v_position in
    select entry.value, entry.ordinality::integer
    from jsonb_array_elements(v_recovery.storage_manifest)
      with ordinality entry(value, ordinality)
  loop
    v_verified_object := p_verified_objects->(v_position - 1);
    if jsonb_typeof(v_verified_object) is distinct from 'object'
      or v_verified_object - array[
        'destinationPath', 'sourceSha256', 'sourceByteLength',
        'plaintextSha256', 'plaintextByteLength', 'mediaType'
      ]::text[] <> '{}'::jsonb
      or not v_verified_object ?& array[
        'destinationPath', 'sourceSha256', 'sourceByteLength',
        'plaintextSha256', 'plaintextByteLength', 'mediaType'
      ]
      or v_verified_object->>'destinationPath' is distinct from
        p_target_user_id || '/guest-claims/' || p_recovery_id::text || '/'
          || p_claim_lease_token::text || '/' || v_position::text
      or v_verified_object->>'sourceSha256'
        is distinct from v_manifest_object->>'sha256'
      or v_verified_object->>'sourceByteLength'
        is distinct from v_manifest_object->>'byteLength'
      or coalesce(v_verified_object->>'plaintextSha256', '')
        !~ '^[0-9a-f]{64}$'
      or coalesce(v_verified_object->>'plaintextByteLength', '')
        !~ '^[0-9]+$'
      or (v_verified_object->>'plaintextByteLength')::bigint
        not between 1 and 52428800
      or v_verified_object->>'mediaType'
        not in ('image/jpeg', 'image/png', 'image/webp') then
      raise exception using
        errcode = '23514',
        message = 'Every account Storage object must be decrypted and verified';
    end if;
  end loop;

  select jsonb_agg(
    entry.value - array['sourceSha256', 'sourceByteLength']::text[]
    order by entry.ordinality
  ) into v_plaintext_receipts
  from jsonb_array_elements(p_verified_objects)
    with ordinality entry(value, ordinality);

  set constraints
    public.pricing_evidence_snapshots_run_fkey,
    public.pricing_evidence_snapshots_prediction_fkey,
    public.pricing_evidence_snapshots_listing_fkey
  deferred;

  select jsonb_agg(
    jsonb_build_object(
      'destinationPath', p_target_user_id || '/guest-claims/'
        || p_recovery_id::text || '/' || p_claim_lease_token::text
        || '/' || entry.ordinality::text,
      'sha256', entry.value->>'sha256',
      'byteLength', (entry.value->>'byteLength')::bigint,
      'encryption', entry.value->'encryption'
    ) order by entry.ordinality
  ) into v_expected_ciphertext_receipts
  from jsonb_array_elements(v_recovery.storage_manifest)
    with ordinality entry(value, ordinality);

  -- The legacy transfer function is already a fixed, all-or-nothing capability,
  -- but it accepts only the service role. Elevate only this nested call after
  -- pairing the request JWT subject to the lease target, then restore the exact
  -- request claims before any subsequent work or return.
  begin
    perform set_config(
      'request.jwt.claims',
      jsonb_build_object('role', 'service_role')::text,
      true
    );
    v_outcome := public.complete_guest_draft_claim(
      p_recovery_id,
      p_recovery_token_hash,
      p_target_user_id,
      p_claim_lease_token,
      v_expected_ciphertext_receipts
    );
    perform set_config(
      'request.jwt.claims',
      coalesce(v_request_jwt_claims, ''),
      true
    );
  exception when others then
    perform set_config(
      'request.jwt.claims',
      coalesce(v_request_jwt_claims, ''),
      true
    );
    raise;
  end;
  if v_outcome->>'outcome' <> 'claimed' then
    return v_outcome;
  end if;

  -- The snapshot update trigger remains fully immutable. This fixed capability
  -- transfers the exact rows by delete-and-reinsert inside the same claim
  -- transaction, preserving every evidence byte while changing only tenant.
  with moved_snapshot as (
    delete from public.pricing_evidence_snapshots snapshot
    where snapshot.item_id = v_recovery.item_id
      and snapshot.listing_id = v_recovery.draft_id
      and snapshot.user_id = v_recovery.guest_user_id
    returning
      run_id, pipeline_run_id, run_kind, item_id, prediction_id, listing_id,
      schema_version, item, price_result, evidence, evidence_as_of
  )
  insert into public.pricing_evidence_snapshots (
    run_id, pipeline_run_id, run_kind, user_id, item_id, prediction_id,
    listing_id, schema_version, item, price_result, evidence, evidence_as_of
  )
  select
    moved.run_id, moved.pipeline_run_id, moved.run_kind, p_target_user_id,
    moved.item_id, moved.prediction_id, moved.listing_id,
    moved.schema_version, moved.item, moved.price_result, moved.evidence,
    moved.evidence_as_of
  from moved_snapshot moved;

  update private.guest_draft_recoveries recovery
  set encrypted_artifact = null,
      storage_manifest = null,
      claimed_storage_manifest = v_plaintext_receipts,
      updated_at = statement_timestamp()
  where recovery.id = v_recovery.id
    and recovery.state = 'claimed'
    and recovery.claim_target_user_id = p_target_user_id
    and recovery.claimed_lease_token = p_claim_lease_token
  returning * into v_recovery;
  if not found then
    raise exception using errcode = '55000', message = 'Guest claim lost its lease';
  end if;

  set constraints
    public.pricing_evidence_snapshots_run_fkey,
    public.pricing_evidence_snapshots_prediction_fkey,
    public.pricing_evidence_snapshots_listing_fkey
  immediate;

  return private.guest_terminal_outcome_for_target(
    v_recovery, p_target_user_id
  );
end;
$$;

revoke all on function public.complete_guest_draft_claim_with_plaintext(
  uuid, text, text, uuid, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.complete_guest_draft_claim_with_plaintext(
  uuid, text, text, uuid, text, jsonb
) to authenticated;

revoke all on function public.complete_guest_draft_claim(
  uuid, text, text, uuid, jsonb
) from service_role;

comment on function public.complete_guest_draft_claim_with_plaintext(
  uuid, text, text, uuid, text, jsonb
) is
  'Tenant- and lease-capability-paired claim consumer: verifies source-bound plaintext receipts, transfers ownership to the authenticated Clerk seller, purges the guest envelope, and returns no ciphertext carrier.';
