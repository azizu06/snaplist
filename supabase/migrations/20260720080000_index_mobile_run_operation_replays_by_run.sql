-- Issue #307: bound verified-run replay receipt counts and cascade lookups.

create index mobile_run_operation_replays_run_id_idx
  on private.mobile_run_operation_replays (run_id);
