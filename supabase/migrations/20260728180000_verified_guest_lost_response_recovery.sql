-- Issue #332 review correction: a fresh verified App Attest assertion must be
-- able to replace a capability whose successful response never reached the
-- device. The subject advisory lock keeps replacement and refresh bounded.

create or replace function public.issue_verified_guest_capability(
  p_capability_id uuid,
  p_user_id text,
  p_bearer_digest bytea,
  p_activated_at timestamptz,
  p_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
    or p_capability_id is null
    or p_user_id !~ '^guest_[0-9a-f]{48}$'
    or p_bearer_digest is null
    or octet_length(p_bearer_digest) <> 32
    or p_activated_at is null
    or p_activated_at
      not between statement_timestamp() - interval '60 seconds'
      and statement_timestamp() + interval '60 seconds'
    or p_expires_at is null
    or not (
      p_expires_at > p_activated_at
      and p_expires_at <= p_activated_at + interval '30 minutes'
    )
  then
    raise exception using
      errcode = '42501',
      message = 'Verified guest capability issuance is not authorized';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'snaplist:verified-guest-capability:' || p_user_id,
      0
    )
  );

  update private.verified_guest_capabilities capability
  set state = 'tombstoned'
  where capability.user_id = p_user_id
    and capability.state = 'active'
    and (
      capability.revoked_at is not null
      or capability.expires_at <= statement_timestamp()
    );

  -- A fresh verified assertion is new proof of the same device subject. If an
  -- earlier long-lived bearer response was unreachable, retire that digest
  -- before issuing its replacement instead of stranding the device.
  update private.verified_guest_capabilities capability
  set state = 'tombstoned'
  where capability.user_id = p_user_id
    and capability.state = 'active'
    and capability.revoked_at is null
    and capability.expires_at
      > statement_timestamp() + interval '5 minutes';

  -- Capabilities already inside the documented refresh window retain at most
  -- the existing 60-second overlap so in-flight operations can finish.
  update private.verified_guest_capabilities capability
  set expires_at = least(
    capability.expires_at,
    statement_timestamp() + interval '60 seconds'
  )
  where capability.user_id = p_user_id
    and capability.state = 'active'
    and capability.revoked_at is null
    and capability.expires_at > statement_timestamp()
    and capability.expires_at
      <= statement_timestamp() + interval '5 minutes';

  insert into private.verified_guest_capabilities (
    capability_id,
    user_id,
    bearer_digest,
    activated_at,
    expires_at
  )
  values (
    p_capability_id,
    p_user_id,
    p_bearer_digest,
    p_activated_at,
    p_expires_at
  );

  perform private.cleanup_verified_guest_capability_retention();
  return true;
end;
$$;

revoke all on function public.issue_verified_guest_capability(
  uuid, text, bytea, timestamptz, timestamptz
) from public, anon, authenticated;

grant execute on function public.issue_verified_guest_capability(
  uuid, text, bytea, timestamptz, timestamptz
) to service_role;
