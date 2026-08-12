# Issue #774 local DB lease-boundary incident receipt

Date: 2026-08-11 (America/New_York)

Status: no local or hosted DB access is authorized after this receipt. The shared local schema
must not be described as clean until an exclusive-lease preflight proves it. It remains labeled
FOREIGN #774 and stale relative to the current source migration.

## Command and environment

The source-only full-suite command incorrectly disabled Supabase keys without overriding the
direct PostgreSQL test URL:

```sh
SUPABASE_PUBLISHABLE_KEY= \
SUPABASE_SECRET_KEY= \
SUPABASE_SERVICE_ROLE_KEY= \
NEXT_PUBLIC_SUPABASE_ANON_KEY= \
NEXT_PUBLIC_SUPABASE_URL= \
SNAPLIST_REQUIRE_DB_STACK=0 \
pnpm test
```

No secret value was printed. Because `SUPABASE_TEST_DB_URL` was absent,
`credited-retention.concurrency.test.ts` and `exclusive-resource-lock.test.ts` used their checked-in
loopback fallback `postgresql://postgres:[REDACTED]@127.0.0.1:54322/postgres`;
`cleanup-source-parity.test.ts` resolved the same local test database through the repository helper.

The corrected source-only gate pinned every DB/API endpoint to explicit unreachable loopback port
1:

```sh
DATABASE_URL=postgresql://postgres:[REDACTED]@127.0.0.1:1/postgres \
SUPABASE_TEST_DB_URL=postgresql://postgres:[REDACTED]@127.0.0.1:1/postgres \
SUPABASE_URL=http://127.0.0.1:1 \
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:1 \
SNAPLIST_REQUIRE_DB_STACK=0 \
pnpm test
```

A non-network preflight parsed all four endpoints and required hostname `127.0.0.1` and port `1`.
The corrected run passed 297 files / 2,536 tests, with 3 files / 237 tests skipped. No source failure
remained.

After the hub adjudication, one focused command included the mobile and account-erasure files without
the explicit endpoint overrides. All 14 live selectors skipped before a probe because their required
credentials were absent; nevertheless that command shape was noncompliant and its result was
discarded. The same focused gate was rerun only after the four-endpoint port-1 preflight and passed
78 source assertions with the same 14 live selectors skipped.

## Files and selectors that reached the shared DB

Source inspection finds three direct-Postgres files whose reachability does not depend on the
cleared Supabase API keys:

1. `src/lib/pipeline-operations/cleanup-source-parity.test.ts`
   - `pipeline storage cleanup source types > names exactly the sources the database CHECK constraint accepts`
   - Read-only `pg_get_constraintdef`; no DDL or fixture mutation.
2. `src/test/exclusive-resource-lock.test.ts`
   - `exclusive test resource lock > waits until the current owner releases the same resource`
   - `exclusive test resource lock > does not serialize independent resources`
   - `exclusive test resource lock > is not blocked by an abandoned filesystem coordinator`
   - Uses transaction-scoped PostgreSQL advisory locks only. Leases are released; the third selector's
     temporary filesystem lock and reaper directory are removed in `finally`. No DDL or durable DB row.
3. `src/lib/pipeline-operations/credited-retention.concurrency.test.ts`
   - `lets a locked retry win and makes retention preserve the photo set`
   - `lets retention win once and makes the waiting retry fail closed`
   - `allows an in-flight settlement while retention sees the active run and no-ops`
   - `allows an in-flight restoration while retention sees the active run and no-ops`

The four credited-retention selectors are not wholly rollback-contained: `stageCreditedRun` commits
an item/run/credit/device fixture before each selector, and `failAndAgeRun` commits its updates for
the two retention/retry cases. Each contested operation otherwise uses explicit transactions and
`finally` rollback. The file-level `afterAll` acknowledges every recorded queue message, deletes
cleanup jobs for every recorded fixture item, deletes those items (cascading the run graph), and
commits. The run reported no `afterAll` failure, but this is not accepted as proof of a clean shared
database; the next exclusive lease must audit residue directly.

## Observed failures and commit boundary

The unsafe run ended with 5 failed files / 4 failed tests, 293 passed files, 2 skipped files,
2,556 passed tests, and 213 skipped tests.

- `credited-retention.concurrency.test.ts > lets retention win once and makes the waiting retry fail closed`
  observed `storageJobsQueued=0`, expected `1`. Its fixture and fail/age setup had already committed.
  The failing retention call remained inside an uncommitted transaction and the selector's `finally`
  rolled it back.
- `credited-retention.concurrency.test.ts > allows an in-flight settlement while retention sees the active run and no-ops`
  observed `storageJobsQueued=1`, expected `0`. The fixture had committed. The settlement DML remained
  uncommitted and was rolled back, but the separate retention transaction committed before the failed
  assertion. That committed call could have cleaned an eligible incident fixture and published its
  cleanup job. The file-level cleanup is designed to delete that fixture/job, but only the next lease
  may prove absence.
- `instrumentation.test.ts` had two environment-validation failures because empty secret-key variables
  are invalid input. These selectors performed no DB setup or connection.
- `listing-sync.rls.test.ts`, `policy-location-store.rls.test.ts`, and
  `publish-binding.rls.test.ts` failed in setup with `TypeError: Invalid URL` from the deliberately empty
  URL before a DB/API probe or fixture could run.

No incident selector executes DDL or migration-history writes. The failed existing concurrency
assertions remain unchanged and must not be weakened or omitted.

## Process-only end audit

After the corrected unreachable run completed, an OS process scan found no Vitest worker, psql
client, credited-retention client, or `issue-227-*` database client. An `lsof` scan found no
established TCP connection to `127.0.0.1:54322`. The only process-scan hits were the audit shell and
its `rg` child. This is process evidence only, not a database-session or residue claim;
`pg_stat_activity` and schema/fixture state were deliberately not queried outside a lease.

## Mandatory first steps for the next exclusive lease

1. Prove exclusive ownership: process, container, port, and external DB-session preflight.
2. Compare schema, migration history, stored function definitions, and hashes against the frozen
   current source.
3. Audit every incident identifier before applying anything: `issue-227-%` users/idempotency keys,
   `issue-227-*` application names/sessions, fixture item/run/credit rows, queue messages, and cleanup
   jobs; also prove no aborted transaction or unexpected DDL/history change.
4. Only if the incident audit is clean, transactionally apply the corrected #774 delta and run the
   authorized five live suites.
5. END with rollback/fixture absence, zero issue sessions/aborted transactions, unchanged authorized
   migration history, exact corrected definitions, and all shared containers healthy/running.
