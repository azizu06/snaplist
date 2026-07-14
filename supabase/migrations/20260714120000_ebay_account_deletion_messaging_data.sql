create or replace function public.erase_ebay_user_data(
  p_ebay_user_id text default null,
  p_ebay_username text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_ids text[];
  v_erased integer;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Account deletion authorization is required';
  end if;

  select coalesce(array_agg(connection.user_id), '{}'::text[])
  into v_user_ids
  from public.ebay_connections connection
  where (
      nullif(p_ebay_user_id, '') is not null
      and connection.ebay_user_id = p_ebay_user_id
    ) or (
      nullif(p_ebay_username, '') is not null
      and connection.ebay_username = p_ebay_username
    );

  v_erased := cardinality(v_user_ids);
  if v_erased = 0 then
    return 0;
  end if;

  with recursive ebay_message_tree as (
    select message.id, message.user_id
    from public.messages message
    where message.user_id = any(v_user_ids)
      and message.marketplace = 'ebay'
    union
    select child.id, child.user_id
    from public.messages child
    join ebay_message_tree parent
      on child.reply_to = parent.id
      and child.user_id = parent.user_id
  )
  delete from public.notifications notification
  using ebay_message_tree message
  where notification.user_id = message.user_id
    and notification.source_message_id = message.id;

  with recursive ebay_message_tree as (
    select message.id, message.user_id
    from public.messages message
    where message.user_id = any(v_user_ids)
      and message.marketplace = 'ebay'
    union
    select child.id, child.user_id
    from public.messages child
    join ebay_message_tree parent
      on child.reply_to = parent.id
      and child.user_id = parent.user_id
  )
  delete from public.messages message
  using ebay_message_tree erased
  where message.id = erased.id
    and message.user_id = erased.user_id;

  delete from public.ebay_unresolved_questions pending
  where pending.user_id = any(v_user_ids);

  delete from public.ebay_message_sync_state sync_state
  where sync_state.user_id = any(v_user_ids);

  delete from public.ebay_connections connection
  where connection.user_id = any(v_user_ids);

  return v_erased;
end;
$$;

revoke all on function public.erase_ebay_user_data(text, text)
  from public, anon, authenticated;
grant execute on function public.erase_ebay_user_data(text, text)
  to service_role;
