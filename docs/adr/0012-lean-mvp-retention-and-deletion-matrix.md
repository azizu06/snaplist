# ADR-0012 — Lean-MVP retention and deletion matrix

- **Status:** Accepted policy; release remains blocked on unresolved obligations
- **Date:** 2026-07-22
- **Owner:** issue #383

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
per-run telemetry, guest recovery, AI-item credits, eBay connections and publish receipts, Clerk
identity, and Apple/RevenueCat references.

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

The contract remains `release-blocked` while any of these records is unresolved:

| Blocker | Required authority before completion can be claimed |
| --- | --- |
| Hosted transcription retention | Current selected-provider policy and approved zero-retention control evidence before activation |
| eBay publish receipts | Approved legal/eBay rule distinguishing deletable SnapList receipt fields from eBay-owned external records, with duration and proof |
| Clerk identity | Current Clerk deletion behavior, retention policy, and provider deletion proof |
| Apple/RevenueCat references | Approved transaction, refund, tax, RevenueCat, and legal rule naming deletable mappings, any retained reference, duration, and provider proof |

An unresolved row uses the `blocked` treatment, identifies the exact blocker, and names no fictional
executor or duration. Provider-owned records are never reported as deleted merely because SnapList
removed its local reference.

### 5. Keep execution separately issue-owned

This decision record and contract authorize policy only. They do not implement item deletion,
account erasure, Storage cleanup, a hosted schedule, provider mutation, native UI, or credentials.
Future executor issues must consume the contract, preserve tenant fencing and replay safety, and
produce the named completion proof before reporting deletion.

## Consequences

- Account-erasure and App Store review work share one machine-checked vocabulary instead of deriving
  policy from migrations or provider assumptions.
- Raw seller voice has both an event-bound deletion trigger and an absolute 24-hour ceiling.
- Legal/provider unknowns remain visible release blockers and can be resolved by updating one
  blocker-linked disposition with cited authority.
- Existing cleanup implementations are evidence, not proof that every matrix row is executable.

## Excluded

No database or Storage mutation, deletion executor, native UI, Xcode/simulator work, hosted/provider
action, provider activation, credential use, or production account erasure is part of issue #383.
