-- SnapList — add cited sources[] to prediction_logs. ADDITIVE migration.
--
-- prediction_logs records each pipeline run's price recommendation, whose contract is
-- { suggested, range, confidence, sources[] } (PRD). The initial schema persisted the
-- price/range/confidence/tier/model but DROPPED the sources, so the cited comps behind
-- a price couldn't be rendered for user verification or used by the eval harness.
-- Add a jsonb column (default empty array) so the full contract is persisted.
alter table public.prediction_logs
  add column sources jsonb not null default '[]'::jsonb;

comment on column public.prediction_logs.sources is
  'Cited comps/lookup records behind the price recommendation: [{ url, title?, kind? }].';
