-- eBay publish persistence (issue #14).
--
-- The eBay adapter publishes a generated listing to the Sell API
-- (inventory item -> offer -> publish) and SnapList persists the outcome on the
-- existing `listings` row. Additive + idempotent only: `add column if not exists`
-- so re-running is safe and nothing existing changes shape.
--
--  - ebay_offer_id:   the Sell Inventory offer id (needed to retry/republish or
--                     withdraw later without re-creating the offer).
--  - ebay_listing_id: the live eBay listing id returned by the publish call —
--                     the proof an external listing exists.
--  - ebay_status:     adapter-side lifecycle for the eBay leg specifically
--                     ('published' | 'failed'; app-validated, free-text like the
--                     sibling `status` column so values can evolve without a
--                     migration). Distinct from `status` (the SnapList listing
--                     lifecycle) so a failed publish can be shown without
--                     destroying the local draft state semantics.
--
-- RLS: no policy changes needed — these are plain columns on `listings`, which
-- already has per-user policies (20260610180100_rls_policies.sql).

alter table public.listings add column if not exists ebay_offer_id   text;
alter table public.listings add column if not exists ebay_listing_id text;
alter table public.listings add column if not exists ebay_status     text;

comment on column public.listings.ebay_offer_id is
  'eBay Sell Inventory offer id created for this listing (kept for retry/withdraw).';
comment on column public.listings.ebay_listing_id is
  'Live eBay listing id returned by the offer publish call.';
comment on column public.listings.ebay_status is
  'eBay publish lifecycle: published | failed (app-validated).';
