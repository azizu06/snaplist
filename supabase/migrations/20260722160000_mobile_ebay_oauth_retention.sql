create index ebay_oauth_sessions_tenant_retention_idx
  on public.ebay_oauth_sessions (
    user_id,
    least(expires_at, coalesce(finished_at, expires_at)),
    id
  );

create function public.cleanup_mobile_ebay_oauth_sessions(
  p_user_id text,
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_count integer;
  v_remaining_eligible_count integer;
begin
  if nullif(btrim(p_user_id), '') is null then
    raise exception using errcode = '22023', message = 'OAuth cleanup tenant is required';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception using errcode = '22023', message = 'OAuth cleanup batch size must be between 1 and 100';
  end if;

  with eligible as materialized (
    select candidate.id
    from public.ebay_oauth_sessions candidate
    where candidate.user_id = p_user_id
      and least(
        candidate.expires_at,
        coalesce(candidate.finished_at, candidate.expires_at)
      ) <= statement_timestamp() - interval '24 hours'
    order by
      least(
        candidate.expires_at,
        coalesce(candidate.finished_at, candidate.expires_at)
      ),
      candidate.id
    for update of candidate skip locked
    limit p_limit
  ), deleted as (
    delete from public.ebay_oauth_sessions session
    using eligible
    where session.id = eligible.id
      and session.user_id = p_user_id
    returning session.id
  )
  select count(*)::integer
  into v_deleted_count
  from deleted;

  select count(*)::integer
  into v_remaining_eligible_count
  from public.ebay_oauth_sessions session
  where session.user_id = p_user_id
    and least(
      session.expires_at,
      coalesce(session.finished_at, session.expires_at)
    ) <= statement_timestamp() - interval '24 hours';

  return jsonb_build_object(
    'deleted_count', v_deleted_count,
    'remaining_eligible_count', v_remaining_eligible_count,
    'complete', v_remaining_eligible_count = 0
  );
end;
$$;

comment on function public.cleanup_mobile_ebay_oauth_sessions(text, integer) is
  'Issue #395 tenant-scoped retention cleanup. Active unexpired rows are ineligible; completion requires durable absence of every eligible row.';

revoke all on function public.cleanup_mobile_ebay_oauth_sessions(text, integer)
  from public, anon, authenticated;
revoke all on function public.cleanup_mobile_ebay_oauth_sessions(text, integer)
  from service_role;
grant execute on function public.cleanup_mobile_ebay_oauth_sessions(text, integer)
  to service_role;

create function public.delete_mobile_ebay_oauth_sessions_for_account_erasure(
  p_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_count integer;
  v_remaining_count integer;
begin
  if nullif(btrim(p_user_id), '') is null then
    raise exception using errcode = '22023', message = 'Account erasure tenant is required';
  end if;

  with deleted as (
    delete from public.ebay_oauth_sessions session
    where session.user_id = p_user_id
    returning session.id
  )
  select count(*)::integer
  into v_deleted_count
  from deleted;

  select count(*)::integer
  into v_remaining_count
  from public.ebay_oauth_sessions session
  where session.user_id = p_user_id;

  return jsonb_build_object(
    'deleted_count', v_deleted_count,
    'remaining_count', v_remaining_count,
    'complete', v_remaining_count = 0
  );
end;
$$;

comment on function public.delete_mobile_ebay_oauth_sessions_for_account_erasure(text) is
  'Issue #384 leaf capability: account erasure deletes every mobile eBay OAuth session row owned by the tenant regardless of status.';

revoke all on function public.delete_mobile_ebay_oauth_sessions_for_account_erasure(text)
  from public, anon, authenticated;
revoke all on function public.delete_mobile_ebay_oauth_sessions_for_account_erasure(text)
  from service_role;
grant execute on function public.delete_mobile_ebay_oauth_sessions_for_account_erasure(text)
  to service_role;
