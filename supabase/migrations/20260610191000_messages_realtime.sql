-- SnapList — buyer inbox: Realtime publication + reply-lifecycle columns (issue #13).
--
-- Additive + idempotent only (this migration is also piped straight at the running
-- local DB). Three concerns:
--
--   1. `messages` joins the `supabase_realtime` publication so Postgres changes are
--      streamed to subscribed clients — the live inbox ("appears without refresh").
--      RLS still gates delivery: Realtime authorizes each event against the
--      subscriber's JWT and the messages select policy, so a user only ever
--      receives their OWN rows.
--   2. `sent_at` — when the (stubbed) delivery happened. Nullable: only rows whose
--      reply has actually been "sent" carry it. Real delivery lands with the eBay
--      adapter (issue #14); the column is the audit point either way.
--   3. `reply_to` — threads an outbound reply row to the inbound buyer question it
--      answers. Nullable: inbound rows (and legacy rows) have none.
--   4. `draft_model` — model provenance for the agent-drafted reply, mirroring the
--      repo-wide "log which model produced what" rule (#32). Nullable: only rows
--      that received an agent draft carry it.

alter table public.messages
  add column if not exists sent_at timestamptz;

alter table public.messages
  add column if not exists reply_to uuid references public.messages (id) on delete set null;

alter table public.messages
  add column if not exists draft_model text;

-- Lookup of the reply thread for an inbound message.
create index if not exists messages_reply_to_idx on public.messages (reply_to);

-- Publication membership is not IF NOT EXISTS-able, so guard it explicitly.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end
$$;
