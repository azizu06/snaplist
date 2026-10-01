# Immediate parallel listing processing

The native submission route returns durable acceptance, then uses Next.js `after()` to call the
existing authenticated worker in a separate HTTP invocation. Each invocation claims at most ten
messages and processes them concurrently. The existing minute cron remains the backup/retry sweeper.
No database schema, production data, cron schedule, provider cap, or credit policy changed.

## Local receipt, 2026-10-01

Real layers: isolated local Postgres, PGMQ, RLS, private Storage, submission/staging, fenced worker
RPCs, checkpointing, durable completion, provider-usage isolation, and credit settlement. HTTP wake
requests reached a loopback bearer-protected receiver composed with the real worker. Fixture layers:
authentication principals and the model stages (1.5 s identification + 2.5 s pricing + 1.5 s listing).
The Next.js `after()` scheduling boundary is separately covered through the production route's unit
contract; this is not a deployed Vercel or real-provider capacity measurement.

The harness is reused from the September 24 concurrency investigation, with explicit safeguards
against a shared or hosted database. It accepts only project `snaplist-parallel-listings`' dedicated
API/database addresses `127.0.0.1:56421` / `127.0.0.1:56422`. Secrets are not printed.

| Scenario | Last claim | Last processing start | Durable wall time | Peak overlapping runs | Settled credits |
| --- | ---: | ---: | ---: | ---: | ---: |
| One submission, automatic wake | 186 ms | 233 ms | 5.829 s | 1 | 1 |
| Five submissions, automatic wakes | 195 ms | 235 ms | 5.789 s | 5 | 5 |
| Ten submissions, automatic wakes | 281 ms | 340 ms | 5.897 s | 10 | 10 |
| Ten queued items, backup plus two duplicate invocations | — | — | 5.655 s | 10 | 10 |

All four scenarios had exactly one distinct claim per item, one correctly owned listing and
prediction per run, isolated provider usage, and an empty queue afterward. The backup race returned
claim counts `[0, 10, 0]`. Another invocation claimed zero after completion.

An injected identification failure among five siblings produced four successful drafts and one
retry. Only the failed run reached attempt 2; the other four stayed at attempt 1. After retry:
five unique runs, six queue deliveries, five settled credit reservations, zero restorations, no
duplicate listing/prediction, and an empty queue. Test-only retry delay was one second; production
remains 30 seconds with bounded exponential backoff and three attempts.

TDD receipts: the concurrency test first failed with peak `1` instead of `5`; the backup-default test
first requested `1` instead of `10`; the production submission route first scheduled zero wakeups.
Each passed after its corresponding implementation. A consumer infrastructure error is also tested
to wait for successful siblings before rejecting the invocation.

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
both submission and worker routes allow 300 seconds. The wake is best-effort, uses a 290-second
bounded HTTP wait, and refuses redirects. A missed wake leaves the durable message for the next
minute tick, which can now start up to ten items together. Warm/cold starts and real provider latency
remain unmeasured here. Existing provider spend caps and admission/entitlement gates remain active.

The worker's per-run fencing and retry behavior are unchanged. All claimed siblings are awaited
before an invocation surfaces an infrastructure error; a stale attempt may still return a worker
500, but cannot abandon its siblings. The hosting function can still terminate at its 300-second
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
