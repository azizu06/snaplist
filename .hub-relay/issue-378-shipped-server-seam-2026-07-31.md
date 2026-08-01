# Issue #378 — final report to the hub

**Status:** ready for the hub's merge decision. I do not self-merge.

- PR: #580, ready for review (not draft)
- Head: `e15b4a37af4fda7154cb64624ffadd4d722154dc`
- CI run: `30682492664` on that exact head. `database: success`, `verify: success`, `image: success`
- Branch: `fix/378-honest-export-packs`, worktree `/Users/aziz.u/.claude/worktrees/snaplist-378`
- Review: round 2 of 3. Round 1 both REQUEST CHANGES, round 2 both APPROVE, all round-2 findings P3
- Simulator lease: never taken. No `xcodebuild`, no simulator, no `db reset`. Verified through CI

## Which XPORT states shipped

**None as live native states, and that is the scope split.** #378 is `Blocked by #376`, and #376 has no
Listing Review SwiftUI view on `main`. The full XPORT-01…05 vertical crosses four major production
surfaces and could not be verified without the lease, which #375 holds exclusively.

So this PR ships the **server seam only**, which AGENTS.md permits when the seam is contract-tested
and explicitly blocks its consumer. Filed **#581** for the native family, and the PR is linked
`Refs #378`, not `Closes`. Acceptance criterion 5 and the native halves of 2 and 6 are recorded on
#378 as transferring to #581.

Proof-only fixtures XPORT-06, 07A, 07B were not shipped as live states.

Delivered: the Depop export pack, durable Prepared/Shared handoff receipts under revision guards,
the assisted-destination invalidation sweep, the typed TypeScript seam over three guarded RPCs, and
the web export view rendering all three destinations.

## How the Prepared/Shared invariant is enforced

Enforced in the database, not only in the RPC, so a client cannot route around it.

1. `export_handoffs_shared_requires_handoff_check` makes a `Shared` receipt for a row that never
   performed a handoff **unrepresentable**. pgTAP asserts the raw insert raises `23514`.
2. `authenticated` holds `select` only. No `insert`, no `update`. Every write goes through a guarded
   SECURITY DEFINER capability. The `revoke` names `public, anon, authenticated, service_role`
   explicitly, because `revoke ... from public` alone leaves Supabase's default role grants intact.
3. `listings_assisted_export_never_published` makes `status = 'published'` on a facebook, mercari, or
   depop row a constraint violation. Nothing can render Published, Listed, or Sold.
4. `ExportHandoffState` is `"prepared" | "shared"`. Published, synced, received, and verified are not
   knowable, so they are not representable in the type.
5. **Gate 2.** `assert_export_pack_current` re-checks the full `review_revision` under `for share`, so
   a confirm sheet left mounted over a listing that moved fails closed with `P0002` and honest copy.
   A stale confirmation cannot write `Shared`.
6. The sweep (below) means a `Shared` receipt cannot outlive the identity it described.

## 07A vs 07B decision — implemented 07B

07A treats `canOpenURL` as a destination-availability truth source. Rejected. It needs
`LSApplicationQueriesSchemes`, it answers "is a handler registered", and it cannot promise the app
will accept the payload. Treating it as truth would have SnapList assert a device fact it cannot
verify, which is the same class of error the whole family exists to prevent.

Schema consequence: **there is no destination-availability column.** 07B is the honest reading and is
what the seam supports.

## RED evidence

Six cycles, one public seam at a time.

1. Depop pack — `TypeError: Cannot read properties of undefined (reading 'safeParse')`
2. Cached pack per destination at the effective price — `TypeError: ... (reading 'price')`
3. Durable receipts — `psql: ERROR: relation "public.export_handoffs" does not exist`
4. Typed handoff seam — `Error: Failed to resolve import "./handoff"`
5. Round-1 blocker, the sweep — RED captured by dropping the trigger **inside a rolled-back
   transaction** so the shared local stack was never mutated:
   `not ok 22 - invalidating the packs leaves no assisted destination behind`
   `not ok 23 - invalidating the pack deletes its handoff receipt`
6. Refusals keep their meaning — both new vitest cases failed against the old
   `throw new Error(error.message)` / `data as string`

Green now: pgTAP 23/23, vitest 73/73 on `src/lib/export`, tsc and eslint clean.

## The round-1 blocker and why the fix differs from the suggestion

Both reviewers found it, and it was the one thing here that could have shipped a lie: a seller's
`Shared` claim outliving the identity it described. Four production paths invalidate cached packs
with the literal `platform in ('facebook','mercari')`, so a Depop pack and its receipt survived.

The suggested fix, adding `'depop'` to those four predicates, means re-declaring four SECURITY DEFINER
functions totalling roughly 600 lines verbatim on the guided-correction surface this issue does not
own. I used a statement-level sweep on `public.listings` instead. Twenty lines, expresses the rule
once, covers call sites written after this PR.

The first draft of the sweep was wrong and the test caught it: a `FOR EACH STATEMENT` trigger fires
even when its own statement matched zero rows, so "the recursive pass matches nothing" is not a
termination argument. It recursed to `stack depth limit exceeded`. Guarded on
`pg_catalog.pg_trigger_depth() > 1`.

## Two things for the hub

**1. Local grant gap, unrelated to this branch.** `authenticated` holds no `select`, `insert`,
`update`, or `delete` on any `public` table in the shared local stack. Raw ACL is
`{postgres=arwdDxtm/postgres,anon=Dxtm/postgres,authenticated=Dxtm/postgres,service_role=Dxtm/postgres}`.
This is why six pre-existing pgTAP files (`home_current_item_projection`, `ebay_message_transport`,
`pipeline_recovery_ux`, `pipeline_operations`, `pipeline_credited_retention`,
`ebay_dispatch_durable_completion`) fail locally with `permission denied for table items` while
passing in CI. I did not patch them.

It also blocks one accepted P3: Spec wanted the invalidating delete in my retention block run as
`authenticated` under RLS rather than as the session role. I cannot run that variant here and would
not push a test I have not seen pass. Recorded in the PR body.

**2. Design confirmation pass never re-run.** Flagged in the dispatch as known-unresolved. I found
nothing internally inconsistent in the visual spec that affected the server seam, but the native
family (#581) will need that pass resolved before implementation.

## Follow-ups routed, not silently decided

- **#581** owns the native XPORT-01…05 family, plus two P3s from round 2: a price-only edit advances
  `review_revision` without touching the packs, so a seller who already shared sees the pack rebuilt
  at the new price while it still reads `Shared`; and the photos half of AC1 is native-only too.
- No other issues opened. Every remaining small correction rode this PR and is recorded in its body,
  per the size-based routing rule.
