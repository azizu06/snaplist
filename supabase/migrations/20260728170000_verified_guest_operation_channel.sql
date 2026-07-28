-- Issue #332: hosted Postgres cannot observe the Data API gateway's apikey
-- header. Bind verified-guest SQL authority to the trusted ES256 operation
-- signer instead, while the Supabase client continues using a publishable key.

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
  v_operation_channel text := coalesce(
    auth.jwt()->>'snaplist_operation_channel',
    ''
  );
begin
  if v_role <> 'authenticated'
    or v_actor <> 'verified_guest'
    or v_user_id = ''
    or char_length(v_user_id) > 255
    or v_capability_id_text
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or v_operation_channel <> 'verified_guest_publishable' then
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
