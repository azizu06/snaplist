# Durable pipeline operations runbook

This is the v1 operating contract for the logged `pipeline_jobs` queue. It is
provider-neutral, locally testable, and inactive in hosted environments by
default. Applying migrations does **not** create Cron jobs, store secrets,
invoke an HTTP route, deploy a worker, or change a provider.

## Fixed operating policy

| Concern | v1 bound | Terminal behavior |
| --- | ---: | --- |
| Worker cadence | one invocation/minute | owner-activated only |
| Scheduled worker claim | 1 message | every run receives the full visibility window |
| Invocation duration | 300 seconds | platform terminates the request |
| Queue visibility / run lease | 300 seconds | expiry permits fenced redelivery |
| Concurrent scheduled worker invocations | at most 5 by cadence/duration | PGMQ visibility plus run leases fence duplicate work |
| Run attempts | 3 by default | durable `failed`, safe seller notification, queue ack |
| Retry delay | 30, 60, then bounded at 900 seconds | same message is deferred, not republished |
| Maintenance cadence | hourly at minute 17 | owner-activated only |
| Maintenance batch | 25 jobs | another invocation resumes remaining work |
| Storage cleanup attempts | 5 | private dead letter, exposed by health |

The five-minute maximum and one-minute cadence permit no more than five
overlapping single-message worker requests, below Supabase Cron's documented
recommendation of no more than eight concurrent jobs. Claiming one message per
request prevents later serial work from inheriting an already-spent visibility
window. The database does not trust that bound: message visibility, message/run
pairing, and expiring fencing tokens remain the authoritative concurrency
controls. The consumer retains an explicit bounded-batch option for deterministic
partial-completion acceptance, but the scheduled production contract does not use it.

## Retention policy

| Data | Retention/action |
| --- | --- |
| Unresolved staging paths | eligible after 24 hours; every path referenced by an item is protected |
| Failed/canceled abandoned capture | after every terminal attempt is 30 days old, only when it has no listing and no active/successful sibling run; retention locks and re-checks sibling runs before atomically marking them expired and queuing photo deletion; item/run ids remain accounting tombstones and the UI directs the seller to recapture |
| Unclaimed guest draft | exactly 24 hours after the completed run made the usable draft durable; server time expires and scrubs recoverable product content while preserving run, prediction, provider, and settled-credit evidence |
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

The same maintenance cycle first invokes `expire_guest_draft_recoveries` with
the fixed batch bound. Claim completion and expiry share a recovery advisory
lock and terminal predicate, so exactly one can become authoritative. Expiry
queues guest source objects and any destination objects left by an interrupted
copy; a successful claim queues only guest source objects. The Storage phase is
therefore replayable and cannot delete the account copy of a committed claim.

Terminal `pipeline_runs` rows are not deleted. They remain durable notification
and AI-item-credit accounting anchors, including the ledger owned by #168.
Photos referenced by a successful listing never enter cleanup work.

## Local enable, inspect, and disable

1. Reset and verify the local schema:

   ```sh
   pnpm supabase db reset --local --no-seed
   pnpm supabase test db --local supabase/tests/pipeline_operations.test.sql
   ```

   Drop the path to run every contract in `supabase/tests`, which is what the
   `database` CI job runs:

   ```sh
   pnpm supabase test db --local
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

## Scheduler reachability

Three conditions must hold before any scheduler can drain the queue. All are
properties of the app or of the stored origin, not of the schedule itself, so
none is visible from the `crons` array or from reading the pg_cron template.

They apply to **both** scheduled routes — `/api/internal/pipeline-worker` and
`/api/internal/pipeline-maintenance`. The template schedules both, and a
maintenance route that never runs means retention, guest-draft expiry, and
Storage cleanup silently stop.

1. **Method.** Both routes answer `GET` and `POST` identically. Vercel Cron only
   ever issues `GET`; the pg_cron template POSTs through pg_net. A route that
   answered one method returned `405` to the other and did nothing.
2. **No redirect in front of the route.** Both paths are listed in the auth
   proxy's public matcher (`src/proxy.ts`) because a scheduler carries no Clerk
   cookie. Public here means "not cookie authenticated"; each route's own
   `CRON_SECRET` guard is unchanged and still fails closed with `503` unset and
   `401` on a bad bearer.

   A login redirect in front of either route is invisible in **both** directions,
   which is why this is the dangerous failure mode rather than a loud one:

   | Scheduler | Behavior on the `307` | What the operator sees |
   | --- | --- | --- |
   | Vercel Cron | [does not follow redirects](https://vercel.com/docs/cron-jobs/manage-cron-jobs#cron-jobs-and-redirects) — the `3xx` is the final response | invocation recorded, no work done |
   | pg_net | **follows** it and fetches `/login` | `net._http_response` row with `status_code = 200` and a ~50 KB HTML body |

   Measured locally against pg_net 0.20.3: a redirected maintenance call stored
   `status_code 200` with 52,079 bytes of login-page HTML. A green response log
   is therefore not evidence that a route ran — check the body.
3. **No trailing slash on the stored origin.** `<origin>/` concatenated with
   `/api/internal/...` produces a doubled slash, which Next.js answers with a
   `308` to the normalized path. The template normalizes with `rtrim(..., '/')`
   so a stored origin in either form works; if you build the URL yourself, strip
   it.

Whichever scheduler the owner activates, verify by reading the response **body**,
not just the status: the worker returns `{"claimed":…,"succeeded":…}` and
maintenance returns `{"queueMessagesDeleted":…,"health":{…}}`. HTML, a `307`,
`401`, or `405` all mean the route was never reached.

### Why the worker is not in `vercel.json`

The repository deliberately does not schedule this route as a Vercel cron job.
[Vercel's plan limits](https://vercel.com/docs/cron-jobs/usage-and-pricing) cap
Hobby at **one invocation per day** with **±59 minutes** of scheduling
imprecision, and a sub-daily cron expression **fails deployment** on that plan.
The worker claims one message per invocation (`PIPELINE_OPERATIONS_POLICY.worker.batchSize`),
so a Hobby cron would move one accepted run per day — not a drained queue. The
fixed one-invocation-per-minute cadence above needs Vercel Pro, and ADR-0009
authorizes no paid plan without an explicit owner-approved upgrade trigger.

The Supabase pg_cron template below already meets the cadence policy at no cost
and is the decided hosted activation path (owner decision, 2026-07-31).

`vercel.json` therefore declares no `crons` array at all. That is deliberate and
asserted by `src/vercel-config.test.ts`; an entry appearing there is a regression,
not a completion.

## Owner-only hosted activation and rollback

Supabase pg_cron is the activation path. It meets the one-invocation-per-minute
policy above at no cost, which Vercel's Hobby scheduler cannot (see the previous
section). Hosted activation is a credential action against real infrastructure
and is never performed by a repository change — the steps below are the owner's
to run, in order.

Exactly **two values** are substituted anywhere in this procedure:

| Placeholder | Value | Notes |
| --- | --- | --- |
| `<ORIGIN>` | the deployed SnapList HTTPS origin, e.g. `https://snaplist.vercel.app` | scheme included; a trailing slash is tolerated but not needed |
| `<CRON_SECRET>` | the same secret configured as the app's `CRON_SECRET` env var | generate with `openssl rand -hex 32`; never commit it or paste it into a migration |

Nothing else in the SQL below changes.

**1. Confirm the target.** Check the deployment, spend cap, and current Supabase
limits before scheduling anything.

**2. Set `CRON_SECRET` on the deployment** (Vercel → project → Settings →
Environment Variables), then redeploy so the running instance has it. With it
unset both routes answer `503` and the schedule will drain nothing.

**3. Prove reachability by hand, before scheduling.** Substitute both values and
run these from your own machine. Read the **body**, not just the status:

```sh
# Expect: {"claimed":0,"succeeded":0,"retrying":0,"failed":0,"skipped":0}
curl --fail-with-body -X POST \
  -H "Authorization: Bearer <CRON_SECRET>" \
  <ORIGIN>/api/internal/pipeline-worker

# Expect: {"queueMessagesDeleted":0,...,"health":{"queueDepth":0,...}}
curl --fail-with-body -X POST \
  -H "Authorization: Bearer <CRON_SECRET>" \
  <ORIGIN>/api/internal/pipeline-maintenance
```

HTML in either body means a login redirect is still in front of the route; a
`401` means the secret does not match the deployment; a `405` means the route
does not answer that method. Stop and fix before continuing — a schedule laid on
top of any of these reports success forever and moves nothing.

**4. Enable the extensions** in the Supabase SQL editor (idempotent):

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;
```

**5. Store both values in Vault, then schedule.** Open
`supabase/templates/pipeline-operations-cron.sql`, read it, replace
`<owner-supplied-https-origin>` with `<ORIGIN>` and `<owner-supplied-cron-secret>`
with `<CRON_SECRET>`, and run the file. Vault — not the SQL file, and not the
repository — holds the values.

If a secret of that name already exists, `vault.create_secret` fails rather than
overwriting. Rotate instead:

```sql
select id, name from vault.secrets where name like 'snaplist_pipeline_%';
select vault.update_secret('<id-from-above>', '<new value>');
```

**6. Verify it is actually firing.** Wait two minutes, then run all three. Each
has a specific pass condition:

```sql
-- (a) Both jobs registered and active.
select jobid, jobname, schedule, active from cron.job
where jobname like 'snaplist-pipeline-%';
--     expect snaplist-pipeline-worker '* * * * *' and
--            snaplist-pipeline-maintenance '17 * * * *', both active = t

-- (b) The schedule is executing without SQL errors.
select j.jobname, d.status, d.start_time, d.return_message
from cron.job_run_details d join cron.job j on j.jobid = d.jobid
where j.jobname like 'snaplist-pipeline-%'
order by d.start_time desc limit 10;
--     expect one 'succeeded' worker row per minute
--     'failed' here means the SQL never left Postgres; read return_message

-- (c) The HTTP request actually reached the route. THIS is the one that
--     catches a redirect: status_code 200 is necessary but NOT sufficient.
select id, status_code, created, left(content, 120) as body
from net._http_response order by id desc limit 10;
--     expect JSON bodies: {"claimed":...} / {"queueMessagesDeleted":...}
--     HTML (a <!DOCTYPE html> body, tens of KB) = redirected to /login
--     status_code 0 or a populated error_msg = the origin was unreachable
```

Then confirm real work moves: submit one item and watch it leave `queued` on its
own, with no manual `curl`.

**7. Watch** queue age, retries, terminal failures, cleanup dead letters,
database size, Storage, egress, invocations, and compute.

Rollback is non-destructive:

```sql
select cron.unschedule('snaplist-pipeline-worker');
select cron.unschedule('snaplist-pipeline-maintenance');
```

Keep the queue, runs, Vault entries, and object cleanup jobs until the owner has
verified recovery. Secret deletion/rotation is a separate credential action.

### Proved locally, not hosted

The whole path above was executed end to end against a local Supabase stack
(pg_cron 1.6.4, pg_net 0.20.3, PGMQ 1.5.1) on 2026-07-31: the committed template
was applied verbatim with local values, and an accepted run moved
`queued → retrying → failed` across four consecutive minute-boundary firings with
zero manual invocation, `net._http_response` recording `200` and a JSON worker
summary each time, ending with a drained queue. The run's terminal state is
`failed` because the local fixture has no real photo objects or provider
credentials — that exercises the durable attempt/retry/terminal path, not model
quality. The hosted equivalent is still the owner's to run; nothing in this
repository can perform it.

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
