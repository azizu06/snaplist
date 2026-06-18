-- SnapList — in-app notifications feed (top-bar bell).
--
-- A per-user activity feed: listing went live / failed to publish, a buyer
-- asked a question, etc. One row per event. The bell reads the recent rows on
-- load and then rides Supabase Realtime for new ones (no refresh), exactly like
-- the live inbox (#13).
--
-- Tenancy follows the post-#41 pattern (clerk_identity_text): text user_id =
-- Clerk id, RLS keyed on public.clerk_user_id(). item_id / listing_id stay uuid
-- FKs so a deleted item/listing cascades its notifications away.

create table public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null,
  -- 'listing_published' | 'listing_failed' | 'buyer_message' | 'system'
  kind        text not null,
  title       text not null,
  body        text,
  -- where clicking the notification takes the seller (e.g. /listings/<id>)
  href        text,
  item_id     uuid references public.items (id) on delete cascade,
  listing_id  uuid references public.listings (id) on delete cascade,
  -- null until read; the bell's unread count is `where read_at is null`.
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);

comment on table public.notifications is
  'Per-user in-app activity feed (top-bar bell). RLS-scoped to clerk_user_id(); streamed via supabase_realtime.';

-- The feed query: a user''s rows, newest first.
create index notifications_user_created_idx
  on public.notifications (user_id, created_at desc);

alter table public.notifications enable row level security;

create policy notifications_select_own on public.notifications
  for select to authenticated using (public.clerk_user_id() = user_id);
create policy notifications_insert_own on public.notifications
  for insert to authenticated with check (public.clerk_user_id() = user_id);
create policy notifications_update_own on public.notifications
  for update to authenticated using (public.clerk_user_id() = user_id)
  with check (public.clerk_user_id() = user_id);
create policy notifications_delete_own on public.notifications
  for delete to authenticated using (public.clerk_user_id() = user_id);

-- Stream INSERT/UPDATE to subscribed clients. Realtime authorizes every event
-- against the subscriber's JWT and the select policy above, so a user only ever
-- receives their OWN notifications. Publication membership is not
-- IF NOT EXISTS-able, so guard it explicitly (mirrors the messages migration).
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end
$$;
