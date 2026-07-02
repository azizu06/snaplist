-- COGS + profit tracking (#101): what the seller PAID for the item (cost of
-- goods sold). Nullable on purpose — an unknown cost is NULL, never a fake $0,
-- so margin math can honestly skip items without a recorded cost basis.
--
-- RLS unchanged: `items` policies already scope every read/write to
-- `public.clerk_user_id() = user_id`, and a new column inherits them.

alter table public.items
  add column if not exists cost_basis numeric
    constraint items_cost_basis_non_negative check (cost_basis >= 0);

comment on column public.items.cost_basis is
  'What the seller paid for the item (COGS), in dollars. NULL = unknown (never a fake 0).';
