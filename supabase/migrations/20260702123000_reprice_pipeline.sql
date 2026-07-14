-- SnapList — automated stale-inventory repricing pipeline (issue #102).
--
-- Four additive, idempotent schema changes:
--
-- 1. `user_settings.auto_reprice_enabled` — the per-user auto-reprice opt-in.
--    DEFAULT FALSE (unlike the publish-eligibility switch): auto-applying a price
--    change to a LIVE listing is a bigger blast radius than queueing a new
--    one, so the seller must explicitly opt in. A missing row also means OFF.
--
-- 2. `items.price_floor` — the seller's minimum acceptable price. NULLABLE:
--    null = no floor. The repricing pipeline NEVER auto-applies a price below
--    it (app-enforced in src/lib/reprice/policy.ts; suggestions clamp to it).
--
-- 3. `listings.listed_price` + `listings.last_priced_at` — the price the live
--    eBay listing actually carries and the last price event (publish, sweep
--    check, applied reprice). Needed because `prediction_logs` records every
--    RESEARCH run (including suggest-only reprice runs that were never
--    applied), so "latest log price" stops being the live listing's price the
--    moment the sweep logs a suggestion. `last_priced_at` is the staleness
--    cursor the cron selects on.
--
-- 4. `reprice_suggestions` — one row per reprice decision worth surfacing:
--    the evidence (fresh comps via prediction_logs pairing, drift %,
--    confidence) plus lifecycle (pending → applied / auto_applied / dismissed
--    / superseded). Auto-applied runs also land here so "records the change"
--    has an auditable row.

-- ---------------------------------------------------------------------
-- 1. user_settings.auto_reprice_enabled
-- ---------------------------------------------------------------------
alter table public.user_settings
  add column if not exists auto_reprice_enabled boolean not null default false;

comment on column public.user_settings.auto_reprice_enabled is
  'Per-user opt-in for the stale-inventory repricing pipeline auto-APPLYING price changes (issue #102). Default FALSE: without it every reprice stays suggest-only, however confident the run. A missing row also means off.';

-- ---------------------------------------------------------------------
-- 2. items.price_floor
-- ---------------------------------------------------------------------
alter table public.items
  add column if not exists price_floor numeric;

comment on column public.items.price_floor is
  'Seller''s minimum acceptable price (issue #102). Null = no floor. The repricing pipeline never auto-applies below it; suggestions are clamped to it. App-validated as a finite positive number.';

-- ---------------------------------------------------------------------
-- 3. listings.listed_price + listings.last_priced_at
-- ---------------------------------------------------------------------
alter table public.listings
  add column if not exists listed_price numeric;
alter table public.listings
  add column if not exists last_priced_at timestamptz;

comment on column public.listings.listed_price is
  'The price the live eBay listing actually carries (set at publish, updated on applied reprices). Distinct from prediction_logs (which also records suggest-only research runs) and from items.price_override (a seller decision that may pre-date publish).';
comment on column public.listings.last_priced_at is
  'Last price event for this listing (publish / reprice sweep check / applied reprice). The staleness cursor the repricing cron selects on: null or older than REPRICE_STALE_DAYS = stale.';

-- Backfill for listings published BEFORE this migration: the publish flow
-- (marketplace/ebay/publish.ts) sent the newest logged price at publish time,
-- so that is the best available record of the live price; the newest log's
-- timestamp doubles as the initial price-event cursor. Suggest-only reprice
-- logs don't exist yet, so "newest log" is safe at migration time.
update public.listings l
set
  listed_price = coalesce(l.listed_price, pl.price),
  last_priced_at = coalesce(l.last_priced_at, pl.created_at)
from (
  select distinct on (p.item_id) p.item_id, p.price, p.created_at
  from public.prediction_logs p
  where p.price is not null
  order by p.item_id, p.created_at desc
) pl
where pl.item_id = l.item_id
  and l.platform = 'ebay'
  and l.ebay_status = 'published'
  and (l.listed_price is null or l.last_priced_at is null);

-- The cron's candidate scan: live eBay listings ordered by the staleness
-- cursor. Partial index keeps it cheap and exactly shaped to the query.
create index if not exists listings_reprice_scan_idx
  on public.listings (last_priced_at asc nulls first)
  where platform = 'ebay' and ebay_status = 'published';

-- ---------------------------------------------------------------------
-- 4. reprice_suggestions
-- ---------------------------------------------------------------------
-- Tenancy follows the post-#41 pattern (clerk_identity_text): text user_id =
-- Clerk id, RLS keyed on public.clerk_user_id(). item_id / listing_id are uuid
-- FKs so a deleted item/listing cascades its suggestions away.
create table if not exists public.reprice_suggestions (
  id               uuid primary key default gen_random_uuid(),
  user_id          text not null,
  item_id          uuid not null references public.items (id) on delete cascade,
  listing_id       uuid not null references public.listings (id) on delete cascade,
  -- The evidence, denormalized so the card renders without re-deriving:
  current_price    numeric not null,         -- what the live listing carried at sweep time
  suggested_price  numeric not null,         -- the fresh run's suggestion
  target_price     numeric not null,         -- suggestion clamped to the seller's floor (what apply sets)
  price_range      jsonb   not null,         -- { low, high } from the fresh run
  drift_pct        numeric not null,         -- signed % (suggested vs current)
  confidence       numeric not null,         -- composite confidence of the fresh run (0..1)
  autopilot_eligible boolean not null default false, -- the composite gate's decision for the run
  tier_fired       text    not null,         -- which pricing tier produced the suggestion
  sources          jsonb   not null default '[]'::jsonb, -- cited fresh comps
  floored_to_minimum boolean not null default false,    -- floor raised target above suggestion
  -- Lifecycle: 'pending' | 'applied' | 'auto_applied' | 'dismissed' | 'superseded'
  -- (app-validated free text, matching the sibling status columns).
  status           text    not null default 'pending',
  applied_price    numeric,                  -- set when (auto-)applied
  -- Pairs this suggestion with the prediction_logs row of the SAME reprice run.
  run_id           uuid,
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz
);

comment on table public.reprice_suggestions is
  'Stale-inventory reprice decisions (issue #102): suggest-only rows await one-tap apply/dismiss; auto_applied rows record confidence-gated automatic revisions. RLS-scoped to clerk_user_id(); run_id pairs each row with its prediction_logs run.';

-- The dashboard card query: a user's pending suggestions, newest first.
create index if not exists reprice_suggestions_user_status_idx
  on public.reprice_suggestions (user_id, status, created_at desc);

-- At most ONE pending suggestion per listing: a fresh sweep supersedes the old
-- row instead of piling up duplicates.
create unique index if not exists reprice_suggestions_pending_listing_key
  on public.reprice_suggestions (listing_id)
  where status = 'pending';

alter table public.reprice_suggestions enable row level security;

-- Per-operation policies mirroring the sibling domain tables (clerk_identity_text).
-- The cron writes through the service role (bypasses RLS by design — trusted
-- server-only path, see src/lib/supabase/admin.ts); these policies gate the
-- seller's own reads plus the apply/dismiss updates.
drop policy if exists reprice_suggestions_select_own on public.reprice_suggestions;
create policy reprice_suggestions_select_own on public.reprice_suggestions
  for select to authenticated using (public.clerk_user_id() = user_id);

drop policy if exists reprice_suggestions_insert_own on public.reprice_suggestions;
create policy reprice_suggestions_insert_own on public.reprice_suggestions
  for insert to authenticated with check (public.clerk_user_id() = user_id);

drop policy if exists reprice_suggestions_update_own on public.reprice_suggestions;
create policy reprice_suggestions_update_own on public.reprice_suggestions
  for update to authenticated using (public.clerk_user_id() = user_id)
  with check (public.clerk_user_id() = user_id);

drop policy if exists reprice_suggestions_delete_own on public.reprice_suggestions;
create policy reprice_suggestions_delete_own on public.reprice_suggestions
  for delete to authenticated using (public.clerk_user_id() = user_id);
