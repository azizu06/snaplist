-- Add pricing_model provenance to prediction_logs (#10 review, P1).
--
-- The web-search pricing tiers resolve their own extraction model (PRICING_MODEL),
-- which may differ from both the vision model (`model`) and the listing model
-- (`listing_model`); without this column that provenance was discarded. NULLABLE ON
-- PURPOSE and deliberately NOT backfilled: null means no LLM was involved in pricing
-- (e.g. the deterministic ISBN lookup tier), so the read contract stays
-- `string | null` and the column agrees with it.
alter table public.prediction_logs
  add column if not exists pricing_model text;
