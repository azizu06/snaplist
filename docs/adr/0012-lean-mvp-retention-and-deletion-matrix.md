# ADR-0012 — Lean-MVP retention and deletion matrix

- **Status:** Accepted policy; every release datum now carries a resolved disposition
- **Date:** 2026-07-22 (obligations resolved 2026-07-25)
- **Owner:** issue #383; the four blocked obligations were resolved by issue #506

## Context

The redirected Scan-to-Trophy-Wall MVP needs one deletion and retention authority before account
erasure, temporary voice cleanup, or App Store review can claim complete behavior.

Earlier implementation records contain useful local cleanup behavior, but they do not collectively
answer which party owns each datum, when deletion is required, how long it may remain, which
capability performs the action, or what proves completion. Provider and legal obligations also cannot
be inferred from current code or historical policy.

## Decision

### 1. Keep one normative row-level authority

`docs/contracts/lean-mvp-retention-v1.json` is the only normative row-level retention authority. It
covers local photos and voice, private Storage photos and raw voice, a possible hosted transcription
copy, retained transcripts, items, eBay drafts, export packs, pipeline runs, pricing evidence,
per-run telemetry, tenant user settings, guest recovery, AI-item credits, eBay connections and
publish receipts, Clerk identity, Apple/RevenueCat references, and the PostHog person plus
historical account-linked analytics events.

Every release datum has exactly one disposition. A complete disposition names:

- treatment (`delete`, `retain`, `provider-owned`, or `blocked`);
- owner;
- deletion triggers;
- maximum retention;
- executor; and
- completion proof.

The executable parser rejects a missing or double disposition. This ADR explains the contract but
does not create a second prose matrix that could drift from it.

### 2. Separate temporary raw voice from retained seller context

Local voice follows the same protected, backup-excluded 24-hour recovery ceiling as local photos.
Server raw voice is private temporary transcription input. Its deletion trigger is the first durable
terminal transcription outcome and its hard maximum is 24 hours after durable acceptance. A failed
delete is not completion; durable cleanup success plus object absence is required.

The bounded transcript, `seller_voice` provenance, and optional canonical language tag are a different
datum. They may remain with the item, but are deleted when the seller deletes voice context, when an
unclaimed guest result expires, with item deletion, or with account erasure. Raw audio never inherits
the transcript's longer lifecycle.

### 3. Preserve referenced value; delete temporary or owner-deleted data

Successful listing photos, coherent items/drafts, export packs, pricing evidence, and seller-linked
run telemetry may remain only while their owning item lifecycle requires them. Uncommitted private
staging and unclaimed guest recovery have the existing 24-hour ceilings. Terminal pipeline
operational metadata has the existing 30-day ceiling; the remaining tenant run identity cannot
outlive item deletion or account erasure under this policy.

Guest claim transfers the same result atomically; it does not copy a second result. Guest expiry
deletes the unclaimed result at 24 hours. Credit reservations must settle or restore before account
erasure removes their tenant ledger, so deletion cannot corrupt accounting truth.

### 4. Block rather than invent external or legal policy

An unresolved row uses the `blocked` treatment, identifies the exact blocker, and names no fictional
executor or duration. Provider-owned records are never reported as deleted merely because SnapList
removed its local reference. `status` is machine-checked against the rows: a `complete` contract
cannot carry a blocked disposition or an open blocker, and a `release-blocked` one must name the
disposition holding it back.

The four obligations this ADR opened are now resolved from public provider documentation, and each
disposition carries the URL and the clause it rests on. Where the answer came from an owner's
judgement rather than a provider statement, the row says so in an `ownerDecision` field so a later
reviewer can revise it without mistaking it for a vetted fact.

| Obligation | Resolution |
| --- | --- |
| Hosted transcription retention | `provider-owned`. OpenAI is the pinned provider and the default API data policy is the selected control. OpenAI publishes `/v1/audio/transcriptions` as retaining nothing, None for both abuse monitoring and application state; the general 30-day default bounds endpoints that do retain. That None is OpenAI's published figure rather than something SnapList observed, so the treatment stays `provider-owned`. Zero Data Retention needs OpenAI's prior approval, is not active, and must not be recorded as the ceiling until an approval receipt exists. |
| eBay publish receipts | `delete`. The stored `listings.ebay_offer_id`, `listings.ebay_listing_id`, and `listings.ebay_status` are treated as Personal Information under the API License Agreement Section 1 definition and deleted per Section 9, and within ten days of termination per Section 16.2. The live eBay listing is an eBay-owned record and is never reported deleted by SnapList. |
| Clerk identity | `delete`, proved by verified absence. Account erasure calls `clerkClient.users.deleteUser(userId)` and reads the user back; the API reporting it absent with status 404 is the completion proof. The `user.deleted` webhook acknowledges the request and is not accepted as proof. Clerk publishes no numeric post-deletion window, so SnapList claims none. The proof is defined and executable in `src/lib/retention-contract/clerk-identity-absence.test.ts`, and was observed on 2026-07-26 against a live Clerk development instance: the deleted user read back as absent with status 404 and error code `resource_not_found`. Running it needs an owner-held `sk_test_` key, so it skips where none is configured. |
| Apple/RevenueCat references | `delete` at account erasure, after credit reservations reconcile. SnapList holds no per-user tax record: Apple charges the customer including any applicable taxes, never discloses the customer to the developer, and keeps the payout and financial reports. The cited terms name Apple Distribution International Ltd. or Apple Services Pte. Ltd. the merchant of record for their customers and make the transaction a contract with Apple otherwise, and the conclusion holds either way. The stored rows are an entitlement mapping with no customer identity, price, or tax amount, so no multi-year retention applies. Deleting a RevenueCat customer removes its whole alias set; completion is proved by reading the customer back, because RevenueCat does not document deletion as synchronous. |

Three of these stay conditional. If SnapList adopts alternative payment processing or external
purchase links, Apple stops collecting the tax and the Apple/RevenueCat row reopens. If OpenAI grants
Zero Data Retention, the hosted-transcription ceiling shortens. If a non-OpenAI transcription adapter
is activated — which ADR-0011 and `docs/contracts/voice-context-v1.json` deliberately leave open — the
hosted-transcription row reopens and its retention must be re-cited before that adapter carries seller
audio. No conclusion here has been reviewed by a tax professional or by provider support, which is
recorded in the rows rather than implied here.

One completion proof runs from an owner-held key rather than from CI. The Clerk absence test was
observed on 2026-07-26 against a live Clerk development instance — an `sk_test_` secret, no
production data — and the deleted user read back as absent with status 404 and error code
`resource_not_found`, which the `clerk-identity` row records. The test asserts the reported 404
rather than merely that the read rejected, so a network or auth failure cannot be mistaken for
absence. It skips where no `sk_test_` `CLERK_RETENTION_PROOF_SECRET_KEY` is configured, so CI, which
runs without secrets, does not re-observe the proof; re-observing it is an owner-run step.

### 5. Keep execution separately issue-owned

This decision record and contract authorize policy only. They do not implement item deletion,
account erasure, Storage cleanup, a hosted schedule, provider mutation, native UI, or credentials.
Future executor issues must consume the contract, preserve tenant fencing and replay safety, and
produce the named completion proof before reporting deletion.

### 6. Let the erasure receipt outlive the account, scrubbed and bounded

Issue #384's executor needs one record that survives the deletion it performs. A durable erasure has
to answer a replayed `Idempotency-Key` with the generation it already resolved to, and has to keep
refusing writes to an account that is gone; deleting that record with everything else makes both
answers impossible, and a replay would then start a second erasure of a person who no longer exists.

So `account-erasure-receipt` is a matrix row rather than an implementation detail, and it carries
three limits. It is not tenant data: it lives in `private`, it is unreachable by any tenant, and it
is keyed by a SHA-256 digest of a fixed constant prefix and the user id rather than by the id. That
prefix is a domain separator carried in the migration source, not a secret, so the digest is
deliberately *not* described as salted — what defeats enumeration is the entropy of a Clerk user id,
not anything withheld from someone who has read the migration.

It is scrubbed at the moment a *completed* status is written — the SnapList user id, Clerk user id,
RevenueCat app user ids, and `Idempotency-Key` are removed by database constraint, not by convention
— so what outlives the account cannot re-identify the person. An erasure that has not completed,
including one parked in `deletion_needs_attention`, still holds those identifiers, because resuming
the deletion requires them. That is a bounded window on unfinished work rather than a retention
decision, and such a row is not pruned until it completes.

And it expires: a daily private prune removes receipts 30 days after they complete. That window is
an owner judgement, long enough for a client retrying a stalled erasure to resolve to its own
generation and short enough that a digest does not become indefinite retention.

### 7. Delete PostHog analytics through verified provider state

Issue #617 selects PostHog's current real-deletion API, not suppression. Account erasure resolves
the exact PostHog person UUID from the Clerk user ID, durably records that UUID before the external
mutation, and calls `POST /api/projects/:project_id/persons/bulk_delete/` with `delete_events=true`,
`delete_recordings=false`, and `keep_person=false`. Session replay is disabled in the native
PostHog configuration, so there is no recording datum for this executor to delete. The server uses a
private PostHog management API key with `person:read` and `person:write`; the public iOS project token
is ingestion authority only and is never accepted by the erasure path.

PostHog returns HTTP 202 because historical-event deletion is asynchronous. That response is not
completion proof. The erasure receipt remains non-terminal until the matching person UUID has a
`completed` deletion-status row with `delete_verified_at` and retrieving the person reports it
absent. Only then does finalization write `posthog_person_and_events_deletion_proved_at` and scrub the
working PostHog UUID. PostHog publishes no deletion-completion SLA, so the matrix makes no invented
numeric provider promise; pending or unavailable proof keeps account erasure incomplete.

The anonymous pre-identify ID has an explicit boundary. When PostHog ingests `$identify`, it merges
the anonymous history into the Clerk-keyed person, so deleting that person UUID and its historical
events covers both distinct IDs. Before that merge, the anonymous UUID may already label events in
PostHog, but SnapList's server neither receives nor persists it and PostHog has no Clerk-ID
association by which a later account erasure can discover that unlinked provider identity. The
matrix says this limitation rather than claiming unreachable coverage.

Current provider authority: [Persons API](https://posthog.com/docs/api/persons), including bulk
deletion and deletion-status verification; retrieved 2026-08-02.

## Consequences

- Account-erasure and App Store review work share one machine-checked vocabulary instead of deriving
  policy from migrations or provider assumptions.
- Raw seller voice has both an event-bound deletion trigger and an absolute 24-hour ceiling.
- A future legal or provider unknown becomes a visible release blocker again by moving one
  disposition to `blocked` and flipping `status`; the parser refuses to let the two disagree.
- Retention no longer blocks release, but nothing here makes deletion work. Executor issues still owe
  the named completion proof for every row.
- Existing cleanup implementations are evidence, not proof that every matrix row is executable.

## Excluded

No database or Storage mutation, deletion executor, native UI, Xcode/simulator work, hosted/provider
action, provider activation, credential use, or production account erasure is part of issue #383.
