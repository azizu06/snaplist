-- Add listing_model provenance to prediction_logs (#32 review).
--
-- A pipeline run now invokes TWO models: the vision/identification model and the
-- listing-generation model, which may differ via LISTING_MODEL. The existing `model`
-- column records the vision/run model; this column records the model that produced the
-- listing copy so listing evaluations and experiments stay attributable to the model
-- that generated them. Nullable + backfilled NULL for pre-existing rows; new rows fall
-- back to `model` when a single model served the whole run.
alter table public.prediction_logs
  add column if not exists listing_model text;
