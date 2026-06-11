-- Pair each listing with the exact prediction-log row from the same pipeline
-- run (issue #16). Selecting "newest listing" and "newest prediction"
-- independently can combine outputs from DIFFERENT runs (concurrent runs, or
-- a run that persisted one row but failed before the other), so the eval
-- harness would judge listing copy against another run's attributes/model.
-- Both rows now carry the run's id; NULL on legacy rows (the eval falls back
-- to newest-listing pairing for those and says so).
alter table public.prediction_logs
  add column if not exists run_id uuid;

alter table public.listings
  add column if not exists run_id uuid;

create index if not exists prediction_logs_run_id_idx
  on public.prediction_logs (run_id);

create index if not exists listings_run_id_idx
  on public.listings (run_id);
