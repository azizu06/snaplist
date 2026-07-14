create schema if not exists private;
revoke all on schema private from public;

drop policy if exists messages_insert_own on public.messages;
drop policy if exists messages_update_own on public.messages;
drop policy if exists messages_delete_own on public.messages;

create or replace function private.enforce_message_reply_marketplace_coherence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent_marketplace text;
begin
  if new.reply_to is null then
    return new;
  end if;

  select parent.marketplace
  into v_parent_marketplace
  from public.messages parent
  where parent.id = new.reply_to
    and parent.user_id = new.user_id;

  if not found or v_parent_marketplace is distinct from new.marketplace then
    raise exception using
      errcode = '23514',
      message = 'Reply marketplace must match its parent message';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_message_reply_marketplace_coherence()
  from public, anon, authenticated, service_role;

drop trigger if exists messages_reply_marketplace_coherence on public.messages;
create trigger messages_reply_marketplace_coherence
before insert or update of reply_to, marketplace, user_id on public.messages
for each row execute function private.enforce_message_reply_marketplace_coherence();

create policy messages_insert_own
  on public.messages for insert to authenticated
  with check (
    public.clerk_user_id() = user_id
    and marketplace <> 'ebay'
  );

create policy messages_update_own
  on public.messages for update to authenticated
  using (
    public.clerk_user_id() = user_id
    and marketplace <> 'ebay'
  )
  with check (
    public.clerk_user_id() = user_id
    and marketplace <> 'ebay'
  );

create policy messages_delete_own
  on public.messages for delete to authenticated
  using (
    public.clerk_user_id() = user_id
    and marketplace <> 'ebay'
  );
