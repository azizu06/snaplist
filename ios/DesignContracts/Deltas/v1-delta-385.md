# v1-delta-385: account deletion tail

Delta id: `v1-delta-385`
Predecessor: Settings Hub + Delete Account v1, approved 2026-08-04
Owning issue: #385 (App Store Guideline 5.1.1(v))
Status: built and shipped, pending design ratification

## What this delta is

The approved package covers DEL-01 through DEL-08. Building the client half of
the erasure endpoint produced three states the package does not have, because
the server can answer in ways no approved state describes truthfully. All three
are implemented in this delta. They are not recorded here as future work.

This file records what the code does. It does not promote anything out of
candidate status: whether these states become frozen, take different copy, or
fold into existing ones is the design owner's call, and ratification is routed
separately.

Every state below is reachable in the shipped build, carries the frozen
accessibility identifier `settings.state.<lowercased id>`, and is covered by a
test in `AccountDeletionTests` or `AccountDeletionUITests`.

## Added states

### DEL-05a, the deletion stopped short of finishing

`AccountDeletionPhase.stalled(AccountDeletionStall)`.

DEL-05 says the deletion is still running. That is false once the server has
reported a status it will not move past on its own, so DEL-05a exists to say
what is actually true: the erasure started and stopped partway.

The tray is decided by the stall's reason, never by the state:

- `needsAttention` offers "Check the server again". `deletion_needs_attention`
  is absent from the handler's `TERMINAL_STATUSES`
  (`src/lib/account-erasure/service.ts`), so a request carrying the same
  Idempotency-Key re-walks storage and re-runs the identity delete rather than
  replaying the stored answer. The common way to land here is a transient Clerk
  failure, which `deleteClerkIdentity` reports as unproved absence, and one more
  request is what finishes it. Removing the control would strand a seller whose
  data is gone and whose sign-in survived.
- `keyConflict` and `appNotConfigured` offer no way to ask again. The erasure
  this device can name is not the one the server has, or the build has nowhere
  to send the request. A control whose only possible effect is the same answer
  is worse than no control.

### DEL-06r, the identity confirmation expired

`AccountDeletionPhase.reverificationExpired`.

DEL-06's retry re-sends the same stale factor verification age and earns the
identical refusal from Clerk, so DEL-06r routes back to DEL-02 instead. The
primary control is "Confirm it is you".

### DEL-07f, the account is gone and this device is not clean

`AccountDeletionPhase.deviceNotCleared`.

DEL-07 assumes device clearing succeeds. When the server has confirmed the
deletion and this iPhone will not give up its copies, neither DEL-07 nor DEL-06
is true: DEL-06 would tell the seller both that nothing here has been cleared
and that the server finish could not be confirmed, and both are false. DEL-07f
holds sign-out back, because signing out removes the only credential that can
reach the retry.

## Departures from packaged copy

- **DEL-08's packaged footnote is not used verbatim.** It was written for a
  build that signs out when the seller taps Done. This build signs out before
  DEL-08 is shown, so the packaged wording would describe a step that already
  happened. The package delegates DEL-08's terminal wording to this issue.
- **DEL-08 states retained records only when there are any.** The eBay line is
  rendered from `AccountErasureRetainedRecord`, so a deletion with nothing
  retained does not tell the seller about a listing they never published.

## What this delta does not change

DEL-01, DEL-02 and DEL-03 stay frozen. No token, component, asset or route
contract changes. No backend purge implementation: the erasure endpoint already
existed and was not touched.
