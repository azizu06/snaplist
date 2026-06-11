-- Clerk as identity provider (issue #41) — re-key tenancy from Supabase Auth
-- uuids to Clerk user ids.
--
-- WHY THE TYPE CHANGE: Clerk user ids are text ("user_2ab..."), not uuids, and
-- Clerk users have no auth.users row. auth.uid() casts the JWT `sub` to uuid,
-- so it can NEVER resolve a Clerk token. The supported pattern (Clerk + Supabase
-- third-party auth docs) is: user_id columns as TEXT, policies comparing the
-- raw `sub` claim. This migration is therefore NOT additive — it rewrites the
-- tenancy seam in one transaction:
--
--   1. a stable helper `public.clerk_user_id()` = the requesting JWT's sub
--   2. drop every user-keyed policy (they'd block the type change)
--   3. drop the auth.users FKs (Clerk users don't exist in auth.users)
--   4. user_id: uuid -> text on all six tables (existing uuids survive as text;
--      rows owned by old Supabase-auth users become orphaned identities — this
--      is pre-launch demo data, documented in the PR)
--   5. restore the messages tenant-aware composite FK (PR #35 hardening)
--   6. recreate every policy keyed on clerk_user_id() = user_id
--   7. same swap for the storage.objects photo policies
--
-- SECURITY INVARIANTS PRESERVED: per-operation policies with explicit WITH
-- CHECK pinning ownership; the composite (reply_to, user_id) FK that prevents
-- cross-tenant reply reservation; storage prefix isolation. Only the identity
-- *comparison* changes.

-- ---------------------------------------------------------------------
-- 1. Identity helper: the requesting user's Clerk id (JWT sub), '' when anon.
--    STABLE so the planner evaluates it once per statement (initplan), same
--    performance shape as the old (select auth.uid()) form.
-- ---------------------------------------------------------------------
create or replace function public.clerk_user_id()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(auth.jwt()->>'sub', '')
$$;

comment on function public.clerk_user_id() is
  'Requesting user''s Clerk id (JWT sub claim); empty string when unauthenticated. The tenancy comparison key after the Clerk migration (issue #41).';

-- ---------------------------------------------------------------------
-- 2. Drop user-keyed policies (block ALTER COLUMN TYPE).
-- ---------------------------------------------------------------------
do $$
declare
  t text;
  op text;
begin
  foreach t in array array['items','listings','messages','embeddings','prediction_logs','user_settings'] loop
    foreach op in array array['select','insert','update','delete'] loop
      execute format('drop policy if exists %I on public.%I', t || '_' || op || '_own', t);
    end loop;
  end loop;
end
$$;

-- ---------------------------------------------------------------------
-- 3. Drop auth.users FKs + the messages composite constraints.
-- ---------------------------------------------------------------------
alter table public.items            drop constraint if exists items_user_id_fkey;
alter table public.listings         drop constraint if exists listings_user_id_fkey;
alter table public.messages         drop constraint if exists messages_user_id_fkey;
alter table public.embeddings       drop constraint if exists embeddings_user_id_fkey;
alter table public.prediction_logs  drop constraint if exists prediction_logs_user_id_fkey;
alter table public.user_settings    drop constraint if exists user_settings_user_id_fkey;

alter table public.messages drop constraint if exists messages_reply_to_user_fkey;
alter table public.messages drop constraint if exists messages_id_user_id_key;

-- ---------------------------------------------------------------------
-- 4. user_id: uuid -> text (existing uuids survive verbatim as text).
-- ---------------------------------------------------------------------
alter table public.items            alter column user_id type text using user_id::text;
alter table public.listings         alter column user_id type text using user_id::text;
alter table public.messages         alter column user_id type text using user_id::text;
alter table public.embeddings       alter column user_id type text using user_id::text;
alter table public.prediction_logs  alter column user_id type text using user_id::text;
alter table public.user_settings    alter column user_id type text using user_id::text;

comment on column public.items.user_id is
  'Owning user''s Clerk id (text; was a Supabase auth.users uuid before issue #41). No FK — identities live in Clerk, not in this database.';

-- ---------------------------------------------------------------------
-- 5. Restore the tenant-aware reply FK (semantics identical to
--    20260611012000_messages_reply_to_tenant.sql, now over text user_id).
-- ---------------------------------------------------------------------
alter table public.messages
  add constraint messages_id_user_id_key unique (id, user_id);

alter table public.messages
  add constraint messages_reply_to_user_fkey
  foreign key (reply_to, user_id)
  references public.messages (id, user_id)
  on delete set null (reply_to);

-- ---------------------------------------------------------------------
-- 6. Recreate the per-operation tenancy policies keyed on the Clerk id.
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['items','listings','messages','embeddings','prediction_logs','user_settings'] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.clerk_user_id() = user_id)',
      t || '_select_own', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.clerk_user_id() = user_id)',
      t || '_insert_own', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.clerk_user_id() = user_id) with check (public.clerk_user_id() = user_id)',
      t || '_update_own', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.clerk_user_id() = user_id)',
      t || '_delete_own', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------
-- 7. Storage: photo prefix isolation now compares the Clerk id.
-- ---------------------------------------------------------------------
drop policy if exists "photos_select_own" on storage.objects;
create policy "photos_select_own"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = public.clerk_user_id()
  );

drop policy if exists "photos_insert_own" on storage.objects;
create policy "photos_insert_own"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = public.clerk_user_id()
  );

drop policy if exists "photos_update_own" on storage.objects;
create policy "photos_update_own"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = public.clerk_user_id()
  )
  with check (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = public.clerk_user_id()
  );

drop policy if exists "photos_delete_own" on storage.objects;
create policy "photos_delete_own"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = public.clerk_user_id()
  );
