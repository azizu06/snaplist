# Immediate parallel listing processing

The native submission route returns durable acceptance, then uses Next.js `after()` to call the
existing authenticated worker in a separate HTTP invocation. The worker registers consumption with
its own `after()` and returns prompt 202 admission; the sender awaits only admission. Each invocation claims at most ten
messages and processes them concurrently. The existing minute cron remains the backup/retry sweeper.
No database schema, production data, cron schedule, provider cap, or credit policy changed.

## Local receipt, 2026-10-01

Real layers: isolated local Postgres, PGMQ, RLS, private Storage, submission/staging, fenced worker
RPCs, checkpointing, durable completion, provider-usage isolation, and credit settlement. HTTP wake
requests reached the production bearer-protected admission route through loopback HTTP, composed
with the real worker. Fixture layers:
authentication principals and the model stages (1.5 s identification + 2.5 s pricing + 1.5 s listing).
The Next.js `after()` scheduling boundary is simulated with explicitly tracked promises and separately
covered through the production routes' unit contracts; this is not a deployed Vercel or real-provider
capacity measurement.

The harness is reused from the September 24 concurrency investigation, with explicit safeguards
against a shared or hosted database. It accepts only project `snaplist-parallel-listings`' dedicated
API/database addresses `127.0.0.1:56421` / `127.0.0.1:56422`. Secrets are not printed.

| Scenario | All wakes returned | Last claim | Last processing start | Durable wall time | Peak overlapping runs | Settled credits |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| One submission, automatic wake | 124 ms | 131 ms | 163 ms | 5.730 s | 1 | 1 |
| Five submissions, automatic wakes | 178 ms | 172 ms | 208 ms | 5.777 s | 5 | 5 |
| Ten submissions, automatic wakes | 287 ms | 249 ms | 316 ms | 5.896 s | 10 | 10 |
| Ten queued items, backup plus two duplicate invocations | — | — | — | 5.648 s | 10 | 10 |

All four scenarios had exactly one distinct claim per item, one correctly owned listing and
prediction per run, isolated provider usage, and an empty queue afterward. The backup race returned
claim counts `[0, 0, 10]`. Another invocation claimed zero after completion.

An injected identification failure among five siblings produced four successful drafts and one
retry. Only the failed run reached attempt 2; the other four stayed at attempt 1. After retry:
five unique runs, six queue deliveries, five settled credit reservations, zero restorations, no
duplicate listing/prediction, and an empty queue. Test-only retry delay was one second; production
remains 30 seconds with bounded exponential backoff and three attempts.

TDD receipts: the concurrency test first failed with peak `1` instead of `5`; the backup-default test
first requested `1` instead of `10`; the production submission route first scheduled zero wakeups.
Each passed after its corresponding implementation. A consumer infrastructure error is also tested
to wait for successful siblings before rejecting the invocation.

## Admission lifetime finding

The initial implementation awaited synchronous worker completion from the submission's `after()`.
The review's underlying lifetime finding was valid, but its example that all ten wakes wait for a
nonempty batch was disproved. A real local ten-item baseline split claims `[8, 2]` between two workers:
their HTTP responses took 5.719 s and 5.714 s. The other eight workers claimed zero and responded in
6–28 ms. A single-item baseline waited 6.097 s. One baseline five-item attempt missed the 3 s claim
threshold (3.947 s). Admission, start, overlap, and settlement assertions remain unchanged.

A later run alongside build/lint reached 8.615 s for ten items and missed the original 8.5 s fixture
wall limit. Running the suite alone still reached 8.517 s, versus a matched single item at 5.912 s;
admission/start/overlap checks passed. The host reported load averages 26.80 / 114.34 / 175.57 across
15 logical CPUs. Firstmate authorized replacing only the fixed wake wall limit with the same-run
single-item wall time plus the already-required three-second start window. This bound checks that
bursts finish near one item's time rather than scaling with item count; it does not invent a hosted
8.5 s SLA. Raw timings are retained here. The final sequential suite passed all five scenarios
at the tabled times, with host load averages 11.22 / 72.68 / 147.16 and no overlapping task-local
CPU validation commands. Typecheck, lint, production build, and 181 focused tests also passed.

The narrow correction uses the same authenticated endpoint. A POST carrying the wake header
registers a callback before 202 admission, and that callback awaits the entire bounded consumer.
The native submission still tracks its HTTP dispatch, now capped at ten seconds rather than 290.
No untracked promise or new queue exists. Setup/registration failures return 500; background errors
are logged and leave the durable queue and fenced lease recovery intact. Ordinary scheduler methods
retain their aggregate responses. Tests held consumption unresolved while admission returned,
verified the tracked callback stayed pending, checked auth/setup failures, and injected a background
failure. The first admission test timed out against synchronous completion (RED), then passed.

[Next.js documents](https://nextjs.org/docs/app/api-reference/functions/after) that `after()` extends
serverless lifetime through `waitUntil` and is subject to the route's duration limit. That makes the
extra sender lifetime concrete, even though no user-facing acceptance was delayed.
[Vercel's Fluid compute pricing](https://vercel.com/docs/functions/usage-and-pricing) excludes I/O
wait from active CPU billing but charges provisioned memory through the instance's last in-flight
request. Requests can share instances, so this evidence does not imply ten extra memory allocations
or a measured dollar saving. Removing the avoidable sender lifetime is an in-scope resource-cost
correction; actual hosted placement, billing mode, cold starts, and charges remain unmeasured.

## Reproduce

The public seams are `consumePipelineQueue`, the native `POST /v1/items/runs` route, and the
authenticated HTTP wake capability. Tests are in `src/lib/pipeline-queue/parallel-listings.rls.test.ts`;
the reused fixture harness is `src/test/parallel-listings-harness.ts`.

Prepare the pinned CLI through the project wrapper's documented preparation command. Make a local
workdir containing copies of `supabase/config.toml`, `supabase/seed.sql`, and `supabase/migrations/`.
Set its project id to `snaplist-parallel-listings`; use API 56421, database 56422, shadow 56420,
pooler 56429, Studio 56423, inbucket 56424, analytics 56427, and inspector 58093. Disable Studio,
inbucket, edge runtime, and analytics. Start only that workdir:

```sh
pnpm prepare:supabase-loopback -- --source-only
pnpm supabase --workdir .hub-relay/local-stack start
pnpm supabase --workdir .hub-relay/local-stack status -o json > .hub-relay/local-status.json
```

This host's pinned platform CLI had an invalid code signature and was SIGKILLed. Firstmate explicitly
approved invoking the prepared, validated `supabase-go` binary directly for this isolated stack,
matching the investigation's workaround. The patched Go guard tests passed. No shared stack was
started, stopped, or changed.

Load `API_URL`, `DB_URL`, `PUBLISHABLE_KEY`, and `SECRET_KEY` from the local status JSON into
`SUPABASE_URL`, `SUPABASE_TEST_DB_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SECRET_KEY` without
printing their values. Then:

```sh
SNAPLIST_PARALLEL_LISTINGS_TEST=1 pnpm vitest run src/lib/pipeline-queue/parallel-listings.rls.test.ts
```

The suite refuses any other API/database address before creating a client or purging a queue.
Ordinary test runs skip this suite. Stop only the dedicated workdir with `stop --no-backup` afterward.

## Expected hosted behavior and phone verification

After deployment, normal successful native submissions should start without waiting for a cron
boundary. Set `SNAPLIST_PUBLIC_ORIGIN` to this API deployment and keep `CRON_SECRET` configured;
both submission and worker routes allow 300 seconds. The wake is best-effort, awaits only authenticated
admission with a ten-second HTTP deadline, and refuses redirects. The worker's own `after()` tracks
consumption within its existing 300-second limit. A missed wake leaves the durable message for the next
minute tick, which can now start up to ten items together. Warm/cold starts and real provider latency
remain unmeasured here. Existing provider spend caps and admission/entitlement gates remain active.

The worker's per-run fencing and retry behavior are unchanged. All claimed siblings are awaited
before consumption surfaces an infrastructure error; synchronous scheduler requests return worker
500s, while admitted background wakes log failures. Neither abandons its siblings. The hosting
function can still terminate at its 300-second
limit, after which existing lease/checkpoint recovery applies.

For the owner phone test, using normal app submissions only:

1. Use a signed-in demo account with allowance for three runs. Prepare three distinct photo sets
   beforehand so the submissions can be accepted within roughly ten seconds. Start a screen recording
   and note each acceptance time.
2. Submit the three items, opening the item list after the third acceptance. Each should begin
   analyzing within seconds of its own acceptance; ready drafts should not follow a one-minute
   staircase. Compare each acceptance-to-start interval, since capture and provider times differ.
3. Open all three drafts and verify their own photos, identity, price evidence, and editable copy,
   with one history entry each. Firstmate can corroborate run/attempt and credit receipts through
   read-only logs. Record observed times and any fallback/retry. This test does not publish listings.

Framework references: [Next.js after](https://nextjs.org/docs/app/api-reference/functions/after)
keeps post-response work alive within the route's configured duration;
[Vercel function duration](https://vercel.com/docs/functions/configuring-functions/duration)
is still the outer execution limit. The phone test is the remaining real-provider/device boundary.
