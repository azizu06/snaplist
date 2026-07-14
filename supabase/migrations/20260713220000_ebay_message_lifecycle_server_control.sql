drop policy if exists messages_insert_own on public.messages;
drop policy if exists messages_update_own on public.messages;
drop policy if exists messages_delete_own on public.messages;

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
