-- Issue #332: bind project-signed verified-guest JWTs to durable, revocable
-- authority. Store only capability metadata; GuestBearer values and signed
-- JWTs remain request-only credentials.

create table private.verified_guest_capabilities (
  capability_id uuid primary key,
  user_id text not null
    check (user_id <> '' and char_length(user_id) <= 255),
  bearer_digest bytea not null unique
    check (octet_length(bearer_digest) = 32),
  state text not null default 'active'
    check (state in ('active', 'claimed', 'tombstoned')),
  activated_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (expires_at > activated_at),
  check (revoked_at is null or revoked_at >= activated_at)
);

alter table private.verified_guest_capabilities enable row level security;

revoke all on table private.verified_guest_capabilities
  from public, anon, authenticated, service_role;

create or replace function private.cleanup_verified_guest_capability_retention()
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_deleted bigint;
begin
  delete from private.verified_guest_capabilities capability
  where capability.expires_at
      <= statement_timestamp() - interval '23 hours'
    or capability.revoked_at
      <= statement_timestamp() - interval '23 hours'
    or (
      capability.state <> 'active'
      and capability.activated_at
        <= statement_timestamp() - interval '23 hours'
    );
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function private.cleanup_verified_guest_capability_retention()
  from public, anon, authenticated, service_role;

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
    and capability.expires_at <= statement_timestamp();

  if exists (
    select 1
    from private.verified_guest_capabilities capability
    where capability.user_id = p_user_id
      and capability.state = 'active'
      and capability.revoked_at is null
      and capability.expires_at
        > statement_timestamp() + interval '5 minutes'
  ) then
    raise exception using
      errcode = '55000',
      message = 'Verified guest capability refresh is not due';
  end if;

  update private.verified_guest_capabilities capability
  set expires_at = least(
    capability.expires_at,
    statement_timestamp() + interval '60 seconds'
  )
  where capability.user_id = p_user_id
    and capability.state = 'active'
    and capability.revoked_at is null
    and capability.expires_at > statement_timestamp();

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

create or replace function public.resolve_verified_guest_capability(
  p_bearer_digest bytea
)
returns table(
  capability_id uuid,
  user_id text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
    or p_bearer_digest is null
    or octet_length(p_bearer_digest) <> 32
  then
    raise exception using
      errcode = '42501',
      message = 'Verified guest capability resolution is not authorized';
  end if;

  perform private.cleanup_verified_guest_capability_retention();

  return query
  select capability.capability_id, capability.user_id
  from private.verified_guest_capabilities capability
  where capability.bearer_digest = p_bearer_digest
    and capability.state = 'active'
    and capability.activated_at <= statement_timestamp()
    and capability.expires_at > statement_timestamp()
    and capability.revoked_at is null
  for share;
end;
$$;

revoke all on function public.issue_verified_guest_capability(
  uuid, text, bytea, timestamptz, timestamptz
) from public, anon, authenticated;
revoke all on function public.resolve_verified_guest_capability(bytea)
  from public, anon, authenticated;

grant execute on function public.issue_verified_guest_capability(
  uuid, text, bytea, timestamptz, timestamptz
) to service_role;
grant execute on function public.resolve_verified_guest_capability(bytea)
  to service_role;

select cron.schedule(
  'snaplist-verified-guest-capability-retention-hourly',
  '41 * * * *',
  'select private.cleanup_verified_guest_capability_retention();'
);

create or replace function private.assert_verified_guest_capability()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := coalesce(auth.jwt()->>'role', '');
  v_actor text := coalesce(auth.jwt()->>'actor', '');
  v_capability_id_text text := coalesce(auth.jwt()->>'cap_id', '');
  v_user_id text := coalesce(auth.jwt()->>'sub', '');
  v_capability_id uuid;
  v_api_key text := coalesce(
    (nullif(current_setting('request.headers', true), '')::jsonb)->>'apikey',
    ''
  );
begin
  if v_role <> 'authenticated'
    or v_actor <> 'verified_guest'
    or v_user_id = ''
    or char_length(v_user_id) > 255
    or v_capability_id_text
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or v_api_key not like 'sb_publishable_%' then
    raise exception using
      errcode = '42501',
      message = 'Active verified guest capability is required';
  end if;

  v_capability_id := v_capability_id_text::uuid;
  perform 1
  from private.verified_guest_capabilities capability
  where capability.capability_id = v_capability_id
    and capability.user_id = v_user_id
    and capability.state = 'active'
    and capability.activated_at <= statement_timestamp()
    and capability.expires_at > statement_timestamp()
    and capability.revoked_at is null
  for share;
  if not found then
    raise exception using
      errcode = '42501',
      message = 'Active verified guest capability is required';
  end if;

  return v_user_id;
end;
$$;

revoke all on function private.assert_verified_guest_capability()
  from public, anon, authenticated, service_role;
