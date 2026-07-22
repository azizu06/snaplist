create table public.ebay_oauth_sessions (
  id uuid primary key,
  user_id text not null,
  idempotency_key uuid not null,
  status text not null default 'pending'
    check (status in (
      'pending',
      'completing',
      'connected',
      'declined',
      'cancelled',
      'expired',
      'failed'
    )),
  expires_at timestamptz not null,
  completion_lease_token uuid,
  completion_started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  unique (user_id, idempotency_key),
  check (
    (status = 'completing') =
      (completion_lease_token is not null and completion_started_at is not null)
  ),
  check (
    (status in ('connected', 'declined', 'cancelled', 'expired', 'failed')) =
      (finished_at is not null)
  )
);

comment on table public.ebay_oauth_sessions is
  'Short-lived, tenant-bound, one-time mobile eBay OAuth state. Provider grants are never stored here.';

create index ebay_oauth_sessions_expiry_idx
  on public.ebay_oauth_sessions (expires_at);

alter table public.ebay_oauth_sessions enable row level security;
revoke all on table public.ebay_oauth_sessions from public, anon, authenticated;
grant select, delete on table public.ebay_oauth_sessions to service_role;

create function public.create_mobile_ebay_oauth_session(
  p_proposed_session_id uuid,
  p_idempotency_key uuid,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id text := public.clerk_user_id();
  v_api_key text := coalesce(
    (nullif(current_setting('request.headers', true), '')::jsonb)->>'apikey',
    ''
  );
  v_session public.ebay_oauth_sessions%rowtype;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'authenticated'
    or nullif(btrim(v_user_id), '') is null then
    raise exception using errcode = '42501', message = 'Seller authorization is required';
  end if;
  if v_api_key not like 'sb_secret_%' then
    raise exception using errcode = '42501', message = 'Server API authorization is required';
  end if;
  if p_expires_at <= statement_timestamp()
    or p_expires_at > statement_timestamp() + interval '10 minutes' then
    raise exception using errcode = '22023', message = 'OAuth session expiry is invalid';
  end if;

  insert into public.ebay_oauth_sessions (
    id,
    user_id,
    idempotency_key,
    expires_at
  ) values (
    p_proposed_session_id,
    v_user_id,
    p_idempotency_key,
    p_expires_at
  )
  on conflict (user_id, idempotency_key) do update
  set idempotency_key = excluded.idempotency_key
  returning * into v_session;

  return jsonb_build_object(
    'session_id', v_session.id,
    'user_id', v_session.user_id,
    'expires_at', v_session.expires_at,
    'kind', case when v_session.id = p_proposed_session_id then 'created' else 'replayed' end
  );
end;
$$;

revoke all on function public.create_mobile_ebay_oauth_session(
  uuid, uuid, timestamptz
) from public, anon, service_role;
grant execute on function public.create_mobile_ebay_oauth_session(
  uuid, uuid, timestamptz
) to authenticated;

create function public.read_mobile_ebay_oauth_session(
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.ebay_oauth_sessions%rowtype;
begin
  select session.*
  into v_session
  from public.ebay_oauth_sessions session
  where session.id = p_session_id;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'session_id', v_session.id,
    'user_id', v_session.user_id,
    'expires_at', v_session.expires_at,
    'status', v_session.status
  );
end;
$$;

revoke all on function public.read_mobile_ebay_oauth_session(uuid)
  from public, anon, authenticated;
grant execute on function public.read_mobile_ebay_oauth_session(uuid)
  to service_role;

create function public.finish_mobile_ebay_oauth_session(
  p_session_id uuid,
  p_expected_user_id text,
  p_outcome text,
  p_finished_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.ebay_oauth_sessions%rowtype;
  v_outcome text;
begin
  if p_outcome not in ('declined', 'cancelled', 'expired', 'failed') then
    raise exception using errcode = '22023', message = 'OAuth terminal outcome is invalid';
  end if;
  if p_finished_at is null then
    raise exception using errcode = '22023', message = 'OAuth finish time is required';
  end if;

  select session.*
  into v_session
  from public.ebay_oauth_sessions session
  where session.id = p_session_id
  for update;
  if not found then
    return jsonb_build_object('kind', 'replayed', 'outcome', 'failed');
  end if;
  if v_session.user_id is distinct from p_expected_user_id then
    return jsonb_build_object('kind', 'wrong_tenant');
  end if;
  if v_session.status in ('connected', 'declined', 'cancelled', 'expired', 'failed') then
    return jsonb_build_object('kind', 'replayed', 'outcome', v_session.status);
  end if;
  if v_session.status = 'completing' then
    return jsonb_build_object('kind', 'replayed', 'outcome', 'failed');
  end if;

  v_outcome := case
    when v_session.expires_at <= statement_timestamp() then 'expired'
    else p_outcome
  end;
  update public.ebay_oauth_sessions session
  set status = v_outcome,
      completion_lease_token = null,
      completion_started_at = null,
      finished_at = statement_timestamp()
  where session.id = p_session_id;
  return jsonb_build_object('kind', 'finished', 'outcome', v_outcome);
end;
$$;

revoke all on function public.finish_mobile_ebay_oauth_session(
  uuid, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.finish_mobile_ebay_oauth_session(
  uuid, text, text, timestamptz
) to service_role;

create function public.begin_mobile_ebay_oauth_session(
  p_session_id uuid,
  p_expected_user_id text,
  p_started_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.ebay_oauth_sessions%rowtype;
  v_lease_token uuid;
begin
  if p_started_at is null then
    raise exception using errcode = '22023', message = 'OAuth callback start time is required';
  end if;
  select session.*
  into v_session
  from public.ebay_oauth_sessions session
  where session.id = p_session_id
  for update;
  if not found then
    return jsonb_build_object('kind', 'replayed', 'outcome', 'failed');
  end if;
  if v_session.user_id is distinct from p_expected_user_id then
    return jsonb_build_object('kind', 'wrong_tenant');
  end if;
  if v_session.status in ('connected', 'declined', 'cancelled', 'expired', 'failed') then
    return jsonb_build_object('kind', 'replayed', 'outcome', v_session.status);
  end if;
  if v_session.status = 'completing' then
    return jsonb_build_object('kind', 'replayed', 'outcome', 'failed');
  end if;
  if v_session.expires_at <= statement_timestamp() then
    update public.ebay_oauth_sessions session
    set status = 'expired',
        finished_at = statement_timestamp()
    where session.id = p_session_id;
    return jsonb_build_object('kind', 'expired');
  end if;

  v_lease_token := gen_random_uuid();
  update public.ebay_oauth_sessions session
  set status = 'completing',
      completion_lease_token = v_lease_token,
      completion_started_at = statement_timestamp()
  where session.id = p_session_id;
  return jsonb_build_object('kind', 'claimed', 'lease_token', v_lease_token);
end;
$$;

revoke all on function public.begin_mobile_ebay_oauth_session(
  uuid, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.begin_mobile_ebay_oauth_session(
  uuid, text, timestamptz
) to service_role;

create function public.complete_mobile_ebay_oauth_session(
  p_session_id uuid,
  p_expected_user_id text,
  p_lease_token uuid,
  p_ebay_user_id text,
  p_ebay_username text,
  p_refresh_token_enc text,
  p_access_token_enc text,
  p_access_token_expires_at timestamptz,
  p_scopes text[],
  p_completed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.ebay_oauth_sessions%rowtype;
begin
  if p_completed_at is null then
    raise exception using errcode = '22023', message = 'OAuth completion time is required';
  end if;
  select session.*
  into v_session
  from public.ebay_oauth_sessions session
  where session.id = p_session_id
  for update;
  if not found then
    return jsonb_build_object('kind', 'replayed');
  end if;
  if v_session.user_id is distinct from p_expected_user_id then
    return jsonb_build_object('kind', 'wrong_tenant');
  end if;
  if v_session.status = 'connected' then
    return jsonb_build_object('kind', 'replayed');
  end if;
  if v_session.status <> 'completing'
    or v_session.completion_lease_token is distinct from p_lease_token then
    raise exception using errcode = '40001', message = 'OAuth callback lease expired';
  end if;

  perform private.save_ebay_connection_for_tenant(
    v_session.user_id,
    p_ebay_user_id,
    p_ebay_username,
    p_refresh_token_enc,
    p_access_token_enc,
    p_access_token_expires_at,
    p_scopes
  );

  update public.ebay_oauth_sessions session
  set status = 'connected',
      completion_lease_token = null,
      completion_started_at = null,
      finished_at = statement_timestamp()
  where session.id = p_session_id;
  return jsonb_build_object('kind', 'connected');
end;
$$;

revoke all on function public.complete_mobile_ebay_oauth_session(
  uuid, text, uuid, text, text, text, text, timestamptz, text[], timestamptz
) from public, anon, authenticated;
grant execute on function public.complete_mobile_ebay_oauth_session(
  uuid, text, uuid, text, text, text, text, timestamptz, text[], timestamptz
) to service_role;

create function public.fail_mobile_ebay_oauth_session(
  p_session_id uuid,
  p_expected_user_id text,
  p_lease_token uuid,
  p_failed_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_failed_at is null then
    raise exception using errcode = '22023', message = 'OAuth failure time is required';
  end if;
  update public.ebay_oauth_sessions session
  set status = 'failed',
      completion_lease_token = null,
      completion_started_at = null,
      finished_at = statement_timestamp()
  where session.id = p_session_id
    and session.user_id = p_expected_user_id
    and session.status = 'completing'
    and session.completion_lease_token = p_lease_token;
end;
$$;

revoke all on function public.fail_mobile_ebay_oauth_session(
  uuid, text, uuid, timestamptz
) from public, anon, authenticated;
grant execute on function public.fail_mobile_ebay_oauth_session(
  uuid, text, uuid, timestamptz
) to service_role;
