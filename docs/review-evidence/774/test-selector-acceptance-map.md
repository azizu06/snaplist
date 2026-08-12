# Issue #774 test selector to acceptance and risk map

Status: idempotent reconciliation is source-only pending a new exclusive DB lease. Source now has
107 unique migrations: `20260811120000_durable_seller_voice_context.sql` remains clean-install
authority and `20260811123000_reconcile_durable_seller_voice_context.sql` converges that fresh shape
with the older #774 body already present on the shared stack. The shared local schema remains
FOREIGN #774 and stale until the reconciliation lease. No hosted provider is exercised by any
selector.

## Acceptance and risk keys

- **A1 — Claimed authority:** derive the voice receipt only from the leased run,
  its item, and its tenant. Risk: cross-tenant audio access or forged authority.
- **A2 — Verified input and fail-open:** verify path, digest, WAV media, duration,
  and size; every invalid/non-transcribed outcome continues photos-only. Risk:
  unbounded or attacker-controlled media and avoidable run loss.
- **A3 — Retry and generation binding:** one terminal outcome per accepted voice
  version; replay does not transcribe again; output is regenerated only when the
  terminal voice binding differs. Risk: duplicate paid calls or stale listing text.
- **A4 — Listing truth:** seller voice is unverified condition/detail context and
  cannot replace verified identity, sold evidence, or price. Risk: marketplace
  misrepresentation.
- **A5 — Operator activation:** hosted transcription is default-off and resolves
  only through the role-keyed registry after explicit activation. Risk: undisclosed
  audio egress and cost.
- **A6 — Durable cost accounting:** the worker durably reserves one content-free
  provider/model/call receipt before adapter entry. Replay conservatively reuses
  that receipt and cannot omit or double it, including when a later checkpoint or
  fallback usage write fails. Risk: understated paid usage, duplicate paid calls,
  or corrupted allowance inputs.
- **A7 — Retained lifecycle:** structured transcript/language follows item ownership,
  guest claim, item deletion, and account erasure under private-table fencing.
  Risk: tenant leakage or retained personal data after deletion.
- **A8 — Cleanup and privacy:** raw audio cleanup survives, while audio, transcript,
  and provider errors stay out of queue, prediction, usage, and worker logs. Risk:
  sensitive seller content disclosure.
- **A9 — Lease and stage fencing:** checkpoint and outcome writes remain lease-scoped
  and monotonic for resumed runs. Risk: stale worker mutation or stage regression.

## Source/Vitest selectors

| Exact selector | Acceptance | Primary risk proved |
| --- | --- | --- |
| `parseEnv > keeps hosted seller-context transcription default-off with an explicit boolean gate` | A5 | Missing/false stays off; malformed operator state is rejected. |
| `parseEnv > fails startup when seller-context transcription is enabled for an unsupported provider` | A5 | Explicit Google activation cannot silently become a zero-call unsupported path. |
| `seller context transcription activation > is default-off and accepts only an explicit boolean operator choice` | A5 | Provider/key/model presence cannot implicitly activate audio egress. |
| `seller context transcription activation > rejects explicit activation for an unsupported selected provider without exposing keys` | A5, A8 | The pure registry fence is provider-named and secret-free. |
| `seller context transcription activation > lets explicit OpenAI transcription override ambient Google selection` | A5 | One effective provider controls activation, adapter, and model selection. |
| `seller context transcription activation > fails closed when explicit Google transcription overrides ambient OpenAI` | A5, A8 | An unsupported explicit override fails with provider/config names only. |
| `register > rejects startup before runs when seller-context transcription has no provider adapter` | A5 | Server registration rejects an enabled unsupported provider before work is claimed. |
| `resolveSellerContextTranscriber > fails before a run when transcription is enabled for a provider with no adapter` | A5, A6 | Enabled Google fails closed with zero usage rather than reporting unsupported. |
| `resolveSellerContextTranscriber > normalizes configured output and fails open when disabled or failed` | A2 | Adapter failure does not fail the photo pipeline. |
| `resolveSellerContextTranscriber > maps empty and adapter-unavailable output to photos-only outcomes` | A2 | Every non-transcribed terminal result has one bounded meaning. |
| `resolveSellerContextTranscriber > rejects inputs outside the verified ADR-0011 WAV receipt contract` | A1, A2 | Unverified media never reaches a transcription adapter. |
| `resolveSellerContextTranscriber > aborts the adapter and returns photos-only at the 20-second deadline` | A2 | Timeout is bounded and returns photos-only; production attempt accounting is proved at the composition rejection/failure seam below. |
| `resolveSellerContextTranscriber > fails open on caller cancellation without misreporting the deadline` | A2 | Cancellation classification remains truthful. |
| `resolveSellerContextTranscriber > keeps valid text when provider language is missing, invalid, or oversized` | A2, A7 | Language authority is canonical and bounded. |
| `resolveSellerContextTranscriber > repairs unpaired UTF-16 surrogates before returning Unicode scalars` | A2, A7 | Retained transcript stays valid, bounded Unicode. |
| `provider-neutral pipeline worker composition > keeps hosted seller-audio transcription off without explicit activation` | A5, A6 | Normal OpenAI config makes zero provider calls and records zero transcription usage. |
| `provider-neutral pipeline worker composition > rejects enabled seller-audio configuration at worker construction when selected provider has no adapter` | A5, A8 | Unsupported enabled config fails before queue claim or adapter execution. |
| `provider-neutral pipeline worker composition > transcribes accepted voice after explicit activation through the production registry` | A5, A6 | Explicit activation makes exactly one role-keyed call and one usage receipt. |
| `provider-neutral pipeline worker composition > records one activated transcription attempt when the provider rejects` | A2, A6 | Rejection still records the actual paid attempt without transcript content. |
| `provider-neutral pipeline worker composition > durably records one transcription when generation fails and replay reuses voice` | A3, A6 | Later failure persists one attempt; replay calls the adapter zero more times. |
| `provider-neutral pipeline worker composition > blocks the adapter when reserved transcription receipt persistence fails and replays conservatively` | A3, A6, A8 | Failed pre-call accounting prevents adapter entry; replay flushes the content-free reservation and does not transcribe ambiguously. |
| `provider-neutral pipeline worker composition > preserves one reserved transcription receipt when its terminal checkpoint and fallback write fail` | A3, A6, A8, A9 | A post-call terminal checkpoint loss plus fallback outage still replays one durable receipt with zero retranscription. |
| `provider-neutral pipeline worker composition > preserves one reserved transcription receipt when a non-retryable later stage and fallback write fail` | A3, A6, A8 | Original terminal failure classification survives while the paid receipt remains one and replay adds no transcription. |
| `provider-neutral pipeline worker composition > exposes voice storage as one private path download capability` | A1 | Worker receives no generic storage authority. |
| `durable vision pipeline processor > passes one accepted seller voice note to listing generation without replacing verified identity or price` | A1, A4 | Voice affects bounded detail only; identity and price remain authoritative. |
| `durable vision pipeline processor > persists the accepted voice attempt before transcription and reuses its terminal result on retry` | A3, A9 | Ambiguous retry cannot repeat provider work. |
| `durable vision pipeline processor > checkpoints the content-free transcription reservation before the configured adapter can run` | A3, A6, A8, A9 | Verified audio cannot cross the paid boundary before its strict routing/count receipt is durable. |
| `durable vision pipeline processor > regenerates one legacy listing for the exact terminal voice binding and reuses it on replay` | A3 | Pre-voice generated text is not reused; exact replay is stable. |
| `durable vision pipeline processor > keeps accepted-voice checkpoints monotonic when a claimed run resumes at pricing` | A9 | Voice checkpoint cannot regress a pricing-stage run. |
| `durable vision pipeline processor > keeps accepted-voice checkpoints monotonic when a claimed run resumes at generating` | A9 | Voice checkpoint cannot regress a generating-stage run. |
| `durable vision pipeline processor > fails open to photos when accepted voice bytes fail receipt verification` | A2 | Receipt mismatch avoids transcription and preserves listing value; field-by-field bounds are covered by the transcriber contract selector. |
| `durable vision pipeline processor > fails open without reading a voice path outside the claimed tenant` | A1, A2 | Forged tenant path is never downloaded. |
| `durable vision pipeline processor > records explicit provider contact provenance for local receipt rejection` | A2, A7, A8 | Pre-adapter rejection remains local and cannot create a hosted-provider erasure disclosure. |
| `durable vision pipeline processor > records explicit provider contact provenance for provider-contacted timeout` | A2, A7, A8 | A contacted timeout remains truthfully disclosed without retaining provider payloads. |
| `durable vision pipeline processor > continues photos-only after a terminal {empty,unsupported,timed-out,failed} transcription outcome` | A2 | All four terminal non-transcribed states preserve photo processing. |
| `durable vision pipeline processor > does not repeat transcription after an attempt marker survives an ambiguous response` | A3 | Attempt marker is an at-most-once fence. |
| `listing/generate — valid output maps onto ListingCopy (ebay) > adds bounded seller context as an unverified note without replacing core identity` | A4 | Prompt/schema boundary preserves marketplace truth. |
| `durable pipeline queue consumer > turns a transient error into a bounded retry and extends visibility without ack` | A8, A9 | Provider-echoed transcript is absent from logs/failure state; retry class stays unchanged. |
| `provider usage record contents > keeps content out even when a reporter is handed it` | A6, A8 | Usage schema drops transcript/audio/provider payload and keeps aggregate call facts. |
| `run-scoped pipeline worker store > rejects provider usage unless the RPC reports literal true` | A3, A6 | A false or null database outcome cannot be mistaken for a durable paid-attempt receipt. |
| `run-scoped pipeline worker store > records terminal voice cleanup through the leased run without tenant or content` | A1, A7, A8, A9 | Cleanup/outcome RPC carries identifiers, terminal enum, and explicit contact boolean only. |
| `authenticated mobile item submission against local Supabase > returns one canonical run and matching voice receipt after ambiguous v2 replay` | A1, A3 | Submission replay binds one accepted receipt to one canonical run. |
| `authenticated mobile item submission against local Supabase > carries the accepted run voice through the claimed worker context into listing generation` | A1, A3, A4, A6, A7, A8, A9 | Self-contained highest real submission-to-worker-to-listing seam; the usage writer holds the run lease row through mutation so completion blocks, a usage row exists, and queue/prediction/usage leak checks are non-vacuous. |
| `durable seller voice worker migration > derives one accepted voice receipt from the claimed run, item, and tenant` | A1 | SQL context function joins all three authorities. |
| `durable seller voice worker migration > records only a bounded terminal outcome through the live run lease` | A8, A9 | Outcome capability excludes tenant/content parameters and rejects stale leases. |
| `durable seller voice worker migration > persists aggregate transcription cost authority without voice content` | A6, A8 | Usage JSON allowlist contains routing/call facts only. |
| `durable seller voice worker migration > locks the authoritative lease row through the provider usage mutation` | A6, A9 | Completion or lease replacement cannot interleave after lease validation and before usage mutation. |
| `durable seller voice worker migration > rejects malformed transcription receipts before persistence with one fixed error` | A6, A8 | Missing, wrong-type, or extra receipt fields fail with no payload echo. |
| `durable seller voice worker migration > validates provider usage scalar types and bounds before numeric conversion` | A6, A8 | Seller text and oversized numbers cannot reach a cast or leak through a database error. |
| `durable seller voice worker migration > merges one failed-attempt transcription receipt with replay usage exactly once` | A3, A6 | Narrow conflict update preserves one voice call and idempotent replay totals. |
| `durable seller voice worker migration > merges one late transcription receipt into old-worker usage and reports conflicts truthfully` | A3, A6 | Rolling upgrade full-first rows retain their full usage, accept one exact voice receipt, and reject incompatible identities. |
| `durable seller voice worker migration > merges an empty legacy full-first row with one late transcription exactly once` | A3, A6 | A canonical all-zero legacy row accepts one late call and no incompatible identity. |
| `durable seller voice worker migration > records explicit provider contact provenance before erasure disclosure` | A7, A8 | Hosted-provider disclosure is driven by a typed boolean, never terminal message inference. |
| `durable seller voice worker migration > retains one typed seller context with the item after terminal run pruning` | A7 | Thirty-day checkpoint pruning does not erase live item authority. |
| `durable seller voice worker migration > fences and counts retained seller context during account erasure` | A7, A9 | Erasure cannot miss or race the private tenant row. |
| `durable seller voice worker migration > keeps the capability service-only` | A1, A9 | Seller roles cannot invoke worker outcome authority. |
| `durable seller voice worker migration > fails the provider usage pgTAP bootstrap closed without the exact issue schema` | A6, A9 | The SQL suite exits nonzero unless the exact #774 column, strict validator, and row lock are installed. |
| `durable seller voice reconciliation migration > orders one unique reconciliation migration after the clean-install authority` | A7, A9 | Reconciliation has one unique later version and cannot shadow clean-install authority. |
| `durable seller voice reconciliation migration > adds provider-contact provenance without inventing it for legacy outcomes` | A7, A8 | Stale rows keep their prior disclosure signal while the new contact provenance remains unknown; no historical fact or default is invented. |
| `durable seller voice reconciliation migration > reinstalls the exact corrected RPC and strict usage definitions with narrow grants` | A3, A6, A8, A9 | Fresh and stale schemas receive byte-identical corrected capabilities and service-only execution. |
| `durable seller voice reconciliation migration > fails closed before mutation unless the accepted issue schema exists` | A7, A9 | Migration cannot mutate an unrelated or incomplete schema. |
| `durable seller voice reconciliation migration > fails closed unless the reconciled signatures grants RLS and triggers converge` | A6, A7, A9 | Success requires exact signatures, empty search paths, narrow grants, RLS, and lifecycle triggers. |
| `durable seller voice reconciliation migration > rejects a same-named provenance constraint or column default that changes meaning` | A7, A8 | Same-name drift and false historical defaults fail closed. |
| `durable seller voice reconciliation migration > is replay-safe after either accepted schema without destructive or history DDL` | A7, A9 | Second execution preserves tables, rows, triggers, RLS, and migration history. |
| `durable seller voice reconciliation migration > fails pgTAP bootstrap closed until the reconciliation contract is installed` | A6, A7, A9 | pgTAP cannot pass against the stale partial schema. |
| `durable seller voice reconciliation migration > records the exact clean-install stale-upgrade replay and live-suite lease plan` | A1-A9 | Final DB proof has finite clean-install, upgrade, replay, lifecycle, incident, and residue gates. |
| `seller-media drift guard > finds transcription audio only in modules that have been accounted for` / `routes every seller-audio module through the transcription registry` | A5, A8 | `experimental_transcribe` audio and `resolveTranscriptionModel` cannot drift outside the role-keyed registry unnoticed. |

## Transactional DB/RLS selectors

Final local DB receipt: `/tmp/snaplist-774-db-verify.B1Y6ND/00-preflight.log` records
the exact source and stored-function body hash
`73b5954ad4af17d6e6a1bd66c24e4e9617f9c0becac998a8f1c436a9e8951404`.
`01-raise-statement-audit.log` proves five fixed content-free failures with zero format
arguments or `DETAIL`/`HINT`; `02-function-property-audit.log` proves `SECURITY DEFINER`,
empty `search_path`, exact grants, lease fencing, both merge orders, `ROW_COUNT`, and exact
replay. `03-pipeline-run-provider-usage-pgtap.log` records 37/37. `99-end-audit.log`
records unchanged history (106 rows, latest `20260811120000`), zero fixtures or issue
sessions/aborted transactions, and all ten shared containers healthy/running. The shared
local schema is explicitly FOREIGN #774 for every other DB owner.

The exclusive collision RED lease recorded the two superseding failures without residue:

- `/tmp/snaplist-774-db-red.crbE7t/01-composed-724-over-774-red.log` proves the frozen
  #724 validator rejects the #774 reservation with SQLSTATE `23514` at
  `pipeline_run_provider_usage_initial_usage_check`.
- `/tmp/snaplist-774-db-red.crbE7t/02-old-worker-full-first-red.log` proves the former #774
  RPC returned true while silently retaining `model_calls=2` and `transcriptions=[]`.
- `/tmp/snaplist-774-db-red.crbE7t/99-end-audit.log` proves rollback, zero fixtures or
  external issue sessions, unchanged 106-row history, and a healthy running stack.

| Exact selector | Acceptance | Primary risk proved |
| --- | --- | --- |
| `a failed attempt records one content-free transcription receipt` | A6, A8 | Failed run attempt writes one safe aggregate. |
| `a successful replay fills non-transcription usage` | A3, A6 | Replay can complete the same run record without erasing voice cost. |
| `replay usage is combined while the transcription total stays one` | A3, A6 | Final row has one transcription plus replay model totals. |
| `the same replay receipt is accepted idempotently` / `replaying the same success does not double any recorded attempt` | A3, A6 | Redelivery is value-idempotent. |
| `an old-worker full-first row accepts one late transcription receipt` / `the late receipt preserves full usage and adds one transcription call` | A3, A6 | Rolling upgrade order cannot omit the paid voice attempt or replace earlier model authority. |
| `the exact late transcription replay reports durable success` / `the exact late transcription replay does not double any usage` | A3, A6 | Exact receipt replay is truthfully successful and value-idempotent. |
| `a different late transcription identity conflicts instead of reporting success` / `an incompatible late receipt leaves the durable usage unchanged` | A3, A6, A8 | The RPC raises one content-free conflict and preserves the incumbent authority. |
| `a transcription receipt with a missing field is rejected before persistence` / `a transcription receipt with a wrong field type is rejected before persistence` / `a transcription receipt with an extra text field is rejected without echoing it` | A6, A8 | The exact receipt is strict and every malformed form uses one fixed error. |
| `a malformed numeric scalar is rejected without echoing it` | A6, A8 | Type/bounds validation occurs before numeric conversion. |
| `an all-zero old-worker row accepts one late transcription receipt` / `the all-zero late receipt replays idempotently` / `a different late receipt conflicts with the all-zero old-worker row` | A3, A6 | Empty legacy full-first upgrade is merge-once, replay-safe, and identity-fenced. |
| `guest recovery live DB/RLS and private Storage boundary > claims encrypted recovery into plaintext review and eBay publish inputs` | A7 | Retained seller voice transfers from guest tenant to claimed tenant. |
| `non-guest item deletion against local Supabase > purges the seller's item graph, publishes storage cleanup, and spares the other tenant` | A7, A8 | Owned retained voice is deleted; foreign tenant row survives. |
| `durable account erasure against local Supabase > discloses hosted transcription retention only after explicit provider contact` | A7, A8 | Unsupported local outcomes omit the provider-copy disclosure; contacted timeout includes it. |
| `durable account erasure against local Supabase > blocks a new eBay publish before the adapter and never treats an existing listing as ended` | A7, A9 | Retained voice is counted, fenced, and removed during erasure. |

## Next exclusive local DB lease: exact execution plan

Expected source audit: 107 unique migration versions. Preflight must prove exclusive ownership,
healthy containers, no task-owned client, exact source hashes, and shared history still 106 unique
with latest `20260811120000`. The shared schema must match the recorded stale-body hashes before any
mutation.

First create one lease-owned temporary database from the local Supabase base, apply the complete
ordered migration set through both clean-install authority
`20260811120000_durable_seller_voice_context.sql` and reconciliation
`20260811123000_reconcile_durable_seller_voice_context.sql`, verify 107 unique applied versions,
capture exact definitions/grants/RLS/triggers, replay only reconciliation once more, and require an
identical catalog hash plus retained-row preservation. Drop that exact temporary database after
terminating only its lease-owned sessions.

Next, against the shared stale schema, apply only
`20260811123000_reconcile_durable_seller_voice_context.sql` inside one bounded transaction without
editing migration history. Capture catalog and retained-row hashes, perform a second reconciliation
replay in a second bounded transaction, and require identical hashes and zero row loss. Do not replay
`20260811120000_durable_seller_voice_context.sql`.

After both convergence lanes pass, run the four mapped live Vitest commands and the 48/48 pgTAP
suite exactly once:

```sh
pnpm exec vitest run src/lib/mobile-item-submission/mobile-item-submission.rls.test.ts -t "carries the accepted run voice through the claimed worker context into listing generation"
pnpm exec vitest run src/lib/guest-recovery/guest-recovery.rls.test.ts -t "claims encrypted recovery into plaintext review and eBay publish inputs"
pnpm exec vitest run src/lib/item-deletion/item-deletion.rls.test.ts -t "purges the seller's item graph, publishes storage cleanup, and spares the other tenant"
pnpm exec vitest run src/lib/account-erasure/account-erasure.rls.test.ts -t "discloses hosted transcription retention only after explicit provider contact|blocks a new eBay publish before the adapter and never treats an existing listing as ended"
pnpm supabase test db --local supabase/tests/pipeline_run_provider_usage.test.sql
```

Then rerun the three incident-recovery files with their exact DB selectors and unchanged assertions:

```sh
pnpm exec vitest run src/lib/pipeline-operations/cleanup-source-parity.test.ts -t "names exactly the sources the database CHECK constraint accepts"
pnpm exec vitest run src/test/exclusive-resource-lock.test.ts -t "waits until the current owner releases the same resource|does not serialize independent resources|is not blocked by an abandoned filesystem coordinator"
pnpm exec vitest run src/lib/pipeline-operations/credited-retention.concurrency.test.ts -t "lets a locked retry win and makes retention preserve the photo set|lets retention win once and makes the waiting retry fail closed|allows an in-flight settlement while retention sees the active run and no-ops|allows an in-flight restoration while retention sees the active run and no-ops"
```

END requires 48/48 pgTAP, every named live and incident selector GREEN, shared history unchanged at
106 unique/latest `20260811120000`, temporary database removed, zero residue or task-owned sessions,
and all shared containers healthy/running. Shared schema remains labeled FOREIGN #774 until this
candidate merges or is reconciled by authoritative migration history.

## Consolidation and cohesion rationale

- `voice-context.test-fixture.ts` owns verified bounded WAV bytes, digest, duration,
  media type, and canonical receipt construction. Both production composition and
  durable processor tests use it.
- `verifiedVoiceHarness` in `durable-processor.test.ts` owns storage, transcriber,
  outcome recorder, processor, and claimed context construction. All durable
  voice behavior families vary only the risk input; unique persistence, tenancy,
  stage, and retry assertions remain visible.
- Long DB tests are not duplicate unit scaffolding. They extend existing tenant
  lifecycle selectors transactionally so guest claim, item deletion, account
  erasure, retention, and RLS are proved through their production RPCs.
- Slice crosses submission, worker, registry, checkpoint, listing, usage, and
  lifecycle SQL because splitting would leave either an accepted receipt that
  production drops or a paid/content-bearing call without durable accounting and
  deletion authority. Round-2 reviewers accepted that vertical cohesion. Round-3
  additions are only explicit activation, failure accounting, shared test support,
  and this acceptance record. Post-round-4 correction moves the content-free
  reservation before adapter entry, retries it from both `voiceAttempt` and terminal
  voice checkpoints, preserves later failure classification, and makes unsupported
  or overridden provider selection synchronous and fail-closed. No native or
  marketplace surface changes.
- Exact final file/LOC and Graphify classification belong to the frozen candidate
  receipt. Graphify remains deferred until the candidate has a committed SHA.

## #724 dependency collision receipt

Canonical merge order is #774 first. The frozen #724 migration at
`/Users/aziz.u/.codex/worktrees/issue-724/snaplist/supabase/migrations/20260808220000_post_completion_provider_usage.sql`
(SHA-256 `fcd6421951df71a18a7a5390d0140a0be29c3173a516da86c8f0afaee6ee9acb`) is blocked
and unmergeable over #774 as written. It rejects the `transcriptions` key, calculates
`modelCalls` from `models` alone, and builds an initial envelope without the transcription
dimension. #724 must rebase after #774, retimestamp its unreleased migration, and widen its
validator, trigger/backfill envelope, and composed tests. #774 does not edit or duplicate
those #724-owned functions.
