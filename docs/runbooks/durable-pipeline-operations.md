# Durable pipeline operations runbook

This is the v1 operating contract for the logged `pipeline_jobs` queue. It is
provider-neutral, locally testable, and inactive in hosted environments by
default. Applying migrations does **not** create Cron jobs, store secrets,
invoke an HTTP route, deploy a worker, or change a provider.

## Fixed operating policy

| Concern | v1 bound | Terminal behavior |
| --- | ---: | --- |
| Worker cadence | one invocation/minute | owner-activated only |
| Worker batch | 5 messages | partial batches commit independently |
| Invocation duration | 300 seconds | platform terminates the request |
| Queue visibility / run lease | 300 seconds | expiry permits fenced redelivery |
| Concurrent scheduled worker invocations | at most 5 by cadence/duration | PGMQ visibility plus run leases fence duplicate work |
| Run attempts | 3 by default | durable `failed`, safe seller notification, queue ack |
| Retry delay | 30, 60, then bounded at 900 seconds | same message is deferred, not republished |
| Maintenance cadence | hourly at minute 17 | owner-activated only |
| Maintenance batch | 25 jobs | another invocation resumes remaining work |
| Storage cleanup attempts | 5 | private dead letter, exposed by health |

The five-minute maximum and one-minute cadence permit no more than five
overlapping worker requests, below Supabase Cron's documented recommendation of
no more than eight concurrent jobs. The database does not trust that bound:
message visibility, message/run pairing, and expiring fencing tokens remain the
authoritative concurrency controls.

## Retention policy

| Data | Retention/action |
| --- | --- |
| Unresolved staging paths | eligible after 24 hours; every path referenced by an item is protected |
| Failed/canceled abandoned capture | after 30 days, only when it has no listing and no active/successful sibling run; item/run ids remain accounting tombstones while seller metadata is pruned and photos are queued for deletion |
| Successful terminal run | after 30 days, prune checkpoint/capture input only; preserve the run, listing, item, and photos |
| Active PGMQ message paired to a terminal run | delete after 24 hours (crash-recovery sweep) |
| PGMQ archive rows | delete after 7 days |
| `cron.job_run_details` | delete after 7 days when pg_cron exists |
| `net._http_response` | delete after 24 hours when pg_net exists |
| Cleanup outcome rows | retain 90 days |

Storage deletion is two phase. `prepare_pipeline_retention` first proves
eligibility in Postgres and persists exact paths in
`private.pipeline_storage_cleanup_jobs`. The maintenance runner then removes
only those paths from the private `photos` bucket. A crash or Storage error
leaves a leased job for bounded replay. A fifth failure is a dead letter; it is
never silently discarded.

Terminal `pipeline_runs` rows are not deleted. They remain durable notification
and AI-item-credit accounting anchors, including the ledger owned by #168.
Photos referenced by a successful listing never enter cleanup work.

## Local enable, inspect, and disable

1. Reset and verify the local schema:

   ```sh
   pnpm supabase db reset --local --no-seed
   pnpm supabase test db --local supabase/tests/pipeline_operations.test.sql
   ```

2. Put a throwaway local `CRON_SECRET` in `.env.local`, start the app, and enqueue
   work through the normal upload path. Do not use a hosted credential.

3. Invoke one bounded worker cycle from a second shell:

   ```sh
   curl --fail-with-body \
     --request POST \
     --header "Authorization: Bearer ${SNAPLIST_LOCAL_CRON_SECRET}" \
     http://127.0.0.1:3000/api/internal/pipeline-worker
   ```

4. Invoke one maintenance/health cycle:

   ```sh
   curl --fail-with-body \
     --request POST \
     --header "Authorization: Bearer ${SNAPLIST_LOCAL_CRON_SECRET}" \
     http://127.0.0.1:3000/api/internal/pipeline-maintenance
   ```

   The response and structured `pipeline.maintenance` log expose queue depth,
   oldest job age, retrying runs, terminal failures, expired worker leases,
   pending/dead cleanup work, and the last cleanup outcome. No Prometheus or
   Grafana service is part of v1.

5. Disable local execution by stopping the app or removing `CRON_SECRET`. Both
   routes fail closed when the secret is absent. Queue/run truth remains intact.

## Queue drain and replay

To drain deliberately, stop new uploads, invoke the worker in bounded cycles,
and inspect the maintenance response after each cycle. Drain is complete only
when `queueDepth` is zero and no `queued`, `running`, or `retrying` run remains.
Do not purge the queue as a shortcut: an invisible message may belong to a live
lease and a queue row is not the product-visible source of truth.

Replay is safe at these seams:

- a refresh or browser close cannot revoke a committed run/message;
- an expired worker is fenced by its run lease before redelivery;
- a transient provider error defers the same message with bounded backoff;
- duplicate delivery sees terminal run truth and does not complete again;
- partial batches persist successful entries while only failed entries retry;
- the unique `(user_id, source_pipeline_run_id, kind)` notification key makes a
  successful-completion notification exactly once.

## Safe rollback and synchronous legacy code

The legacy request-scoped `uploadAndProcess` implementation still exists as
source, but the upload page is wired to durable `enqueueUpload`. There is no
runtime flag that safely swaps the two.

The safe operational rollback is therefore to unschedule/stop the worker and
let already accepted jobs wait durably. Do not route new requests through the
legacy synchronous action while the durable consumer is also active; that
would create two processing authorities. Any temporary synchronous fallback is
a separately reviewed code change: freeze durable producers first, preserve
existing queue/run rows, and resume the queue only after the fallback is
removed. Never delete run truth to make the old path appear clean.

## Owner-only hosted activation and rollback

Hosted activation is not performed by this repository change. The owner must:

1. confirm the target deployment, spend cap, and current Supabase limits;
2. create/rotate one `CRON_SECRET` outside git and configure the app with it;
3. manually inspect and apply
   `supabase/templates/pipeline-operations-cron.sql`, replacing its origin and
   secret placeholders so Vault—not the SQL file—stores the values;
4. invoke each protected route once and inspect health before allowing cadence;
5. watch queue age, retries, terminal failures, cleanup dead letters, database
   size, Storage, egress, invocations, and compute.

Rollback is non-destructive:

```sql
select cron.unschedule('snaplist-pipeline-worker');
select cron.unschedule('snaplist-pipeline-maintenance');
```

Keep the queue, runs, Vault entries, and object cleanup jobs until the owner has
verified recovery. Secret deletion/rotation is a separate credential action.

## Supabase Free-plan accounting

Planning uses the current published allowances: 500 MB database per project,
1 GB Storage, 5 GB egress, and 500,000 Edge Function invocations. At the v1
cadence, a 31-day month produces 44,640 worker invocations plus 744 maintenance
invocations, or **45,384 scheduled HTTP requests**. The current route consumes
the chosen app host rather than Supabase Edge Functions; if the seam moves to an
Edge Function later, all 45,384 count against that allowance.

Each accepted successful run normally adds at least an item, run, prediction,
listing, and notification row; indexes and JSONB make raw row count an
insufficient database-size proxy. Storage accounts for original private photo
bytes. Pipeline image reads, retries, client downloads, and HTTP responses add
egress. Cron, pg_net, Postgres/PGMQ work, and any future Edge/Node worker use
compute even when the four listed allowances remain under their caps. Before
hosted activation, replace estimates with live database-size, Storage, egress,
invocation, and compute measurements.

Primary references:

- [Supabase billing and Free-plan allowances](https://supabase.com/docs/guides/platform/billing-on-supabase)
- [Database size and Free-plan read-only behavior](https://supabase.com/docs/guides/platform/database-size)
- [Storage pricing/accounting](https://supabase.com/docs/guides/storage/pricing)
- [Cron limits and recommendations](https://supabase.com/docs/guides/cron)
- [Scheduling HTTP invocations with Cron, pg_net, and Vault](https://supabase.com/docs/guides/functions/schedule-functions)
- [PGMQ queue metrics and retention operations](https://supabase.com/docs/guides/queues/pgmq)
- [Vault secret storage](https://supabase.com/docs/guides/database/vault)
- [pg_net response lifecycle](https://supabase.com/docs/guides/database/extensions/pg_net)
