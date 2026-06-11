-- Persist the per-run autopilot gate decision (PR #34 review, round 7).
--
-- The review page must explain a listing's disposition from RUN-TIME facts —
-- "autopilot was off when this ran" is unprovable from the live setting
-- (which the seller may have flipped since) or from confidence alone (a
-- high-confidence draft is exactly the switch-off case). Two nullable
-- booleans record what the gate actually saw:
--
--   autopilot_enabled  — the master switch value the run consumed.
--   autopilot_eligible — the gate's output (enabled AND score >= threshold);
--                        what routed the listing to queued vs draft.
--
-- Null on legacy rows written before the setting existed — the UI keeps its
-- neutral wording for those rather than inventing history.
--
-- Additive + idempotent: safe to re-run.
alter table public.prediction_logs
  add column if not exists autopilot_enabled boolean;

alter table public.prediction_logs
  add column if not exists autopilot_eligible boolean;
