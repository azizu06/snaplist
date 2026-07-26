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
publish receipts, Clerk identity, and Apple/RevenueCat references.

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
| Hosted transcription retention | `provider-owned`. OpenAI is the pinned provider; the default API data policy is the selected control, so a provider-side copy may sit in abuse-monitoring logs for up to 30 days. Zero Data Retention needs OpenAI's prior approval, is not active, and must not be recorded as the ceiling until an approval receipt exists. |
| eBay publish receipts | `delete`. The stored `listings.ebay_offer_id`, `listings.ebay_listing_id`, and `listings.ebay_status` are treated as Personal Information under the API License Agreement Section 1 definition and deleted per Section 9, and within ten days of termination per Section 16.2. The live eBay listing is an eBay-owned record and is never reported deleted by SnapList. |
| Clerk identity | `delete`, proved by verified absence. Account erasure calls `clerkClient.users.deleteUser(userId)` and reads the user back; the API reporting it absent is the completion proof. The `user.deleted` webhook acknowledges the request and is not accepted as proof. Clerk publishes no numeric post-deletion window, so SnapList claims none. |
| Apple/RevenueCat references | `delete` at account erasure, after credit reservations reconcile. SnapList holds no per-user tax record: Apple is the merchant of record, charges the customer including tax, and keeps the payout and financial reports. The stored rows are an entitlement mapping with no customer identity, price, or tax amount, so no multi-year retention applies. Deleting a RevenueCat customer removes its whole alias set; completion is proved by reading the customer back, because RevenueCat does not document deletion as synchronous. |

Two of these stay conditional. If SnapList adopts alternative payment processing or external purchase
links, Apple stops collecting the tax and the Apple/RevenueCat row reopens. If OpenAI grants Zero
Data Retention, the hosted-transcription ceiling shortens. Neither conclusion has been reviewed by a
tax professional or by provider support, which is recorded in the rows rather than implied here.

### 5. Keep execution separately issue-owned

This decision record and contract authorize policy only. They do not implement item deletion,
account erasure, Storage cleanup, a hosted schedule, provider mutation, native UI, or credentials.
Future executor issues must consume the contract, preserve tenant fencing and replay safety, and
produce the named completion proof before reporting deletion.

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
