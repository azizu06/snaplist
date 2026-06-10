-- Backfill + enforce listing_model on prediction_logs (#32 review follow-on).
--
-- The prior migration added `listing_model` as nullable, so rows written before it
-- existed retain NULL. `readPredictionLogs` casts every row to PredictionLogRow, where
-- `listing_model` is a non-null string, so a historical NULL would violate the read
-- contract and surprise eval code that groups/filters by listing model.
--
-- Backfill those rows from `model` (a single model served the whole run pre-split), then
-- set NOT NULL so the contract is honest. Every new insert already provides the value
-- (buildPredictionLogRow: result.listingModel ?? result.model), so NOT NULL holds going
-- forward. Idempotent: the UPDATE only touches NULLs; SET NOT NULL is a no-op if already set.
update public.prediction_logs
  set listing_model = model
  where listing_model is null;

alter table public.prediction_logs
  alter column listing_model set not null;
