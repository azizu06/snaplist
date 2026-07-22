create or replace function public.finish_mobile_ebay_oauth_session(
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
  if v_session.expires_at <= statement_timestamp() then
    update public.ebay_oauth_sessions session
    set status = 'expired',
        completion_lease_token = null,
        completion_started_at = null,
        finished_at = statement_timestamp()
    where session.id = p_session_id;
    return jsonb_build_object('kind', 'finished', 'outcome', 'expired');
  end if;
  if v_session.status = 'completing' then
    return jsonb_build_object('kind', 'in_progress');
  end if;

  v_outcome := p_outcome;
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

create or replace function public.begin_mobile_ebay_oauth_session(
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
  if v_session.expires_at <= statement_timestamp() then
    update public.ebay_oauth_sessions session
    set status = 'expired',
        completion_lease_token = null,
        completion_started_at = null,
        finished_at = statement_timestamp()
    where session.id = p_session_id;
    return jsonb_build_object('kind', 'expired');
  end if;
  if v_session.status = 'completing'
    and v_session.completion_started_at
      > statement_timestamp() - interval '2 minutes' then
    return jsonb_build_object('kind', 'in_progress');
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

create or replace function public.complete_mobile_ebay_oauth_session(
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
    return jsonb_build_object('kind', 'replayed', 'outcome', 'failed');
  end if;
  if v_session.user_id is distinct from p_expected_user_id then
    return jsonb_build_object('kind', 'wrong_tenant');
  end if;
  if v_session.status in ('connected', 'declined', 'cancelled', 'expired', 'failed') then
    return jsonb_build_object('kind', 'replayed', 'outcome', v_session.status);
  end if;
  if v_session.expires_at <= statement_timestamp() then
    update public.ebay_oauth_sessions session
    set status = 'expired',
        completion_lease_token = null,
        completion_started_at = null,
        finished_at = statement_timestamp()
    where session.id = p_session_id;
    return jsonb_build_object('kind', 'replayed', 'outcome', 'expired');
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

drop function public.fail_mobile_ebay_oauth_session(
  uuid, text, uuid, timestamptz
);

create function public.fail_mobile_ebay_oauth_session(
  p_session_id uuid,
  p_expected_user_id text,
  p_lease_token uuid,
  p_failed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.ebay_oauth_sessions%rowtype;
begin
  if p_failed_at is null then
    raise exception using errcode = '22023', message = 'OAuth failure time is required';
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
  if v_session.expires_at <= statement_timestamp() then
    update public.ebay_oauth_sessions session
    set status = 'expired',
        completion_lease_token = null,
        completion_started_at = null,
        finished_at = statement_timestamp()
    where session.id = p_session_id;
    return jsonb_build_object('kind', 'replayed', 'outcome', 'expired');
  end if;
  if v_session.status <> 'completing'
    or v_session.completion_lease_token is distinct from p_lease_token then
    raise exception using errcode = '40001', message = 'OAuth callback lease expired';
  end if;
  update public.ebay_oauth_sessions session
  set status = 'failed',
      completion_lease_token = null,
      completion_started_at = null,
      finished_at = statement_timestamp()
  where session.id = p_session_id;
  return jsonb_build_object('kind', 'finished', 'outcome', 'failed');
end;
$$;

revoke all on function public.fail_mobile_ebay_oauth_session(
  uuid, text, uuid, timestamptz
) from public, anon, authenticated;
grant execute on function public.fail_mobile_ebay_oauth_session(
  uuid, text, uuid, timestamptz
) to service_role;
