-- Tenant-ownership enforcement for reply threading (PR #35 review, round 7).
--
-- THE HOLE: referential-integrity checks BYPASS RLS, so an authenticated
-- client could insert its own messages row with reply_to set to ANOTHER
-- tenant's message uuid — the insert policy only checks the new row's
-- user_id. The global messages_reply_to_unique index would then reserve that
-- uuid, making the real owner's outbound reply fail with 23505: cross-tenant
-- denial of reply delivery.
--
-- THE FIX: replace the single-column reply_to FK with a tenant-aware
-- COMPOSITE foreign key (reply_to, user_id) -> messages (id, user_id). A
-- reply row can now only ever reference a message owned by the SAME user, so
-- a foreign uuid fails the FK and the uniqueness guarantee is effectively
-- per-tenant (a cross-tenant row can never reserve the slot).
--
-- ON DELETE SET NULL (reply_to) nulls ONLY the referencing column — the
-- column-list form — never user_id.
--
-- Additive + idempotent: every step is guarded, safe to re-run.

-- 1. The composite FK needs a unique constraint on the referenced columns.
--    (id is already the PK, so this adds no real restriction.)
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'messages_id_user_id_key'
      and conrelid = 'public.messages'::regclass
  ) then
    alter table public.messages
      add constraint messages_id_user_id_key unique (id, user_id);
  end if;
end
$$;

-- 2. Replace the single-column FK with the tenant-aware composite one.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'messages_reply_to_fkey'
      and conrelid = 'public.messages'::regclass
  ) then
    alter table public.messages drop constraint messages_reply_to_fkey;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'messages_reply_to_user_fkey'
      and conrelid = 'public.messages'::regclass
  ) then
    alter table public.messages
      add constraint messages_reply_to_user_fkey
      foreign key (reply_to, user_id)
      references public.messages (id, user_id)
      on delete set null (reply_to);
  end if;
end
$$;
