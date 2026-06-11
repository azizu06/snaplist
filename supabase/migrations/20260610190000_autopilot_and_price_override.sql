-- SnapList — confidence-gated autopilot + seller price override (issue #12).
--
-- Two additive, idempotent schema changes:
--
-- 1. `user_settings` — per-user preferences, starting with the master autopilot
--    switch (User Story 24: "autopilot can be turned off entirely"). One row per
--    user, keyed by the auth user id. `autopilot_enabled` defaults TRUE and a
--    MISSING row also means enabled (the app treats the table as an override
--    store), so existing users need no backfill. RLS mirrors the per-user
--    policies on the other domain tables: each user can only touch their own row.
--
-- 2. `items.price_override` — the seller's price, overriding the pipeline's
--    suggestion. NULLABLE: null means "no override; use the suggested price from
--    the latest prediction log". Lives on `items` (the root entity) because the
--    suggested price is logged per-run in `prediction_logs` while the override is
--    a per-ITEM seller decision that must survive re-runs and flow into every
--    downstream consumer (review display, future publish). RLS on `items`
--    already gates the column by owner; no new policy needed.

-- ---------------------------------------------------------------------
-- user_settings
-- ---------------------------------------------------------------------
create table if not exists public.user_settings (
  user_id           uuid primary key references auth.users (id) on delete cascade,
  -- Master autopilot switch. TRUE = high-confidence items may auto-post;
  -- FALSE = everything queues for manual review regardless of confidence.
  autopilot_enabled boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.user_settings is
  'Per-user preferences. autopilot_enabled is the master switch for confidence-gated auto-posting (issue #12); a missing row means autopilot is enabled (the default).';

-- keep updated_at honest on mutation (reuses the shared trigger function from
-- the init migration; drop/create keeps this re-runnable).
drop trigger if exists user_settings_set_updated_at on public.user_settings;
create trigger user_settings_set_updated_at
  before update on public.user_settings
  for each row execute function public.set_updated_at();

alter table public.user_settings enable row level security;

-- Per-operation policies mirroring 20260610180100_rls_policies.sql (explicit
-- select/insert/update/delete with WITH CHECK pinning ownership). drop-if-exists
-- before create keeps the migration idempotent.
drop policy if exists "user_settings_select_own" on public.user_settings;
create policy "user_settings_select_own"
  on public.user_settings for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "user_settings_insert_own" on public.user_settings;
create policy "user_settings_insert_own"
  on public.user_settings for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "user_settings_update_own" on public.user_settings;
create policy "user_settings_update_own"
  on public.user_settings for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "user_settings_delete_own" on public.user_settings;
create policy "user_settings_delete_own"
  on public.user_settings for delete
  to authenticated
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- items.price_override
-- ---------------------------------------------------------------------
alter table public.items
  add column if not exists price_override numeric;

comment on column public.items.price_override is
  'Seller''s price override (issue #12). Null = no override (use the suggested price from the latest prediction log). When set, every downstream consumer (listing display, publish) must use this value. App-validated as a finite positive number.';
