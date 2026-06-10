-- SnapList — Row-Level Security (the tenancy seam).
--
-- SECURITY-CRITICAL. This migration enables RLS on every domain table and adds
-- per-operation policies so an authenticated user can only touch their own rows
-- (matched by auth.uid() = user_id). Without these policies, RLS-enabled tables
-- deny all access to the anon/authenticated roles by default — which is the safe
-- failure mode. Never weaken these to "fix" a query; fix the query to carry the
-- correct user_id instead.
--
-- We write explicit per-command policies (select/insert/update/delete) rather than
-- a single `for all` policy so the intent of each access path is auditable, and so
-- INSERT/UPDATE are protected by an explicit WITH CHECK that pins the new row's
-- user_id to the caller (preventing a user from writing rows owned by someone else).

-- ---------------------------------------------------------------------
-- items
-- ---------------------------------------------------------------------
alter table public.items enable row level security;

create policy "items_select_own"
  on public.items for select
  to authenticated
  using (auth.uid() = user_id);

create policy "items_insert_own"
  on public.items for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "items_update_own"
  on public.items for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "items_delete_own"
  on public.items for delete
  to authenticated
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- listings
-- ---------------------------------------------------------------------
alter table public.listings enable row level security;

create policy "listings_select_own"
  on public.listings for select
  to authenticated
  using (auth.uid() = user_id);

create policy "listings_insert_own"
  on public.listings for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "listings_update_own"
  on public.listings for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "listings_delete_own"
  on public.listings for delete
  to authenticated
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------
alter table public.messages enable row level security;

create policy "messages_select_own"
  on public.messages for select
  to authenticated
  using (auth.uid() = user_id);

create policy "messages_insert_own"
  on public.messages for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "messages_update_own"
  on public.messages for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "messages_delete_own"
  on public.messages for delete
  to authenticated
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- embeddings
-- ---------------------------------------------------------------------
alter table public.embeddings enable row level security;

create policy "embeddings_select_own"
  on public.embeddings for select
  to authenticated
  using (auth.uid() = user_id);

create policy "embeddings_insert_own"
  on public.embeddings for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "embeddings_update_own"
  on public.embeddings for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "embeddings_delete_own"
  on public.embeddings for delete
  to authenticated
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- prediction_logs
-- ---------------------------------------------------------------------
alter table public.prediction_logs enable row level security;

create policy "prediction_logs_select_own"
  on public.prediction_logs for select
  to authenticated
  using (auth.uid() = user_id);

create policy "prediction_logs_insert_own"
  on public.prediction_logs for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "prediction_logs_update_own"
  on public.prediction_logs for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "prediction_logs_delete_own"
  on public.prediction_logs for delete
  to authenticated
  using (auth.uid() = user_id);
