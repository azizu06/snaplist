# SnapList native V1 design inventory and implementation handoff

Status: provider-neutral contract, reconciled 2026-07-16

This document mirrors the binding state boundary in
[`native-v1-design-inventory.json`](./native-v1-design-inventory.json). The JSON file is the
machine-auditable source for state status, package provenance, product truth, visual exceptions, and
implementation owners. Product behavior remains subordinate to `PRD.md`, ADR-0008, and ADR-0009.
Visual appearance for an implementation-frozen state comes from the verified V1 package. Neither
this document nor that package authorizes SwiftUI work outside the owning GitHub issue.
Design-review task `019f6900-23bc-7a23-a861-1cfa65753dc8` remains active and design-only; its live
Claude project and candidate/repair work are read-only to implementation owners.

## Frozen package

- ZIP: `/Users/aziz.u/Documents/Codex/2026-07-15/snaplist-ios-design-review/outputs/snaplist-implementation-fidelity-package-v1-2026-07-16.zip`
- SHA-256: `13ea5cfc237a98d188452b66abde94fb24b44e2e539ee63f42eb232120672415`
- Entry point: `README-FIRST.md`, followed by every machine-readable manifest used by the owning
  implementation issue.
- Scope: 25 implementation-frozen states across accountless onboarding, capture, Seller Home, and
  pricing evidence.

The package is authoritative for the appearance and interaction contract of the 25 states below.
The repo product contract wins if a rendered reference or exported HTML implies different product
behavior. Exported HTML is measurement evidence, not production source.

## State authorization boundary

### Implementation-frozen: 25 states

| Family | IDs | Owning issue |
| --- | --- | --- |
| Accountless onboarding and permission | `ONB-00`, `ONB-01`, `ONB-05`, `ONB-06`, `ONB-07`, `native-camera-permission`, `ONB-08`, `settings-handoff`, `ONB-09-camera`, `ONB-09-library`, `returning-sign-in` | [#206](https://github.com/azizu06/snaplist/issues/206) |
| Capture entry and guided camera | `CAP-01`, `CAP-02a`, `CAP-02b1`, `CAP-02b2`, `CAP-02c`, `CAP-03-handoff` | [#207](https://github.com/azizu06/snaplist/issues/207) |
| Seller Home | `HOME-01`, `HOME-02`, `HOME-03`, `HOME-04` | [#208](https://github.com/azizu06/snaplist/issues/208) |
| Pricing and market evidence | `S1`, `S1b`, `S2`, `S3` | [#209](https://github.com/azizu06/snaplist/issues/209) |

The shared native foundation and fidelity harness belong to
[#205](https://github.com/azizu06/snaplist/issues/205). The parent implementation epic is
[#204](https://github.com/azizu06/snaplist/issues/204).

### Candidate only: six Photo Review states

`CAP-03a`, `CAP-03b`, `CAP-03c`, `CAP-03d`, `CAP-03e`, and `CAP-04` remain design candidates. They
are not implementation-frozen and must not be promoted by copying candidate markup, interactions,
fixtures, or screenshots into production. `CAP-03-handoff` is the terminal frozen capture boundary.

### Withheld

`CAP-05` remains withheld while its barcode/ISBN interaction is repaired. It has no implementation
authorization from V1. No barcode screen, success state, fallback, or interaction may be inferred
from adjacent capture screens.

### Visually approved, still blocked on a delta package

- Runs: `RUN-01` through `RUN-08`.
- Review: `REV-01`, `REV-02`, `REV-07`, and `REV-08`.

These states have visual approval but require separate machine-readable delta ZIPs before any
implementation. A route may end at a typed future destination, but it may not invent the blocked
screen. All other families in the JSON inventory remain planned or optional and not
implementation-frozen.

## Binding product corrections

### First value and corrections

- The first path asks no seller-goal, experience, category, or marketplace questions before a usable
  draft. Optional lightweight personalization may appear only afterward and must remain skippable.
- The guest allowance is exactly one complete AI item run on the device plus one guided identity
  correction for the same physical item and unchanged immutable photo set.
- Manual editing is unlimited while the photo-set fingerprint is unchanged. Adding, replacing, or
  removing a photo creates a new photo set. A new item, changed photo set, or complete re-analysis
  requires a new run.
- Technical retry, recovery, and queue redelivery reuse the original run and do not consume another
  item credit. The first usable guest result remains encrypted and recoverable for 24 hours.

### SnapList Pro and AI-item credits

- Customer-facing paid-plan naming is **SnapList Pro**. Internal legacy identifiers may remain only
  where they are not customer-visible.
- The first usable listing and first seller-confirmed eBay publish are free. Creating an account and
  connecting eBay become blocking only when the guest selects **Publish to eBay**.
- The hard paid gate appears when complete AI item run #2 attempts to reserve a credit. Editing,
  saving, or publishing the existing first draft does not spend a new credit.
- SnapList Pro uses a configurable monthly AI-item allowance. The public count stays unset until
  TestFlight supplies median and p95 cost per usable item. Apple-billed periods and localized price
  come from server-verified StoreKit state.
- A credit is reserved before processing, settled exactly once when a coherent item, price, and
  editable draft are durably available, and restored exactly once after failure or cancellation
  before that point. The plan changes access volume, not AI quality.

### Navigation, durable work, and push

- Primary destinations are exactly Home, Listings, central Capture, Inbox, and Insights.
- Account/Settings opens from the profile control. The bell opens the complete activity center.
- Run history and processing state are contextual from Home. They are not a primary destination.
- Home and the activity center show durable backend truth. No screen fabricates percentages, ETAs,
  provider success, or a second run.
- Push is limited to draft ready, failed or needs-input processing, buyer message, sold/order action,
  expired eBay connection, and failed assisted export. Routine stage movement and successful sync
  stay in the app.

### Seller control and marketplace truth

- eBay is the only direct launch marketplace. Mercari, Facebook Marketplace, and Depop receive
  platform-appropriate text/photos plus an Apple share sheet, honest deep link, or completion
  checklist. The seller finishes in the destination app.
- SnapList owns unpublished drafts. After publish, eBay owns listing and order truth. External eBay
  changes sync into SnapList; seller-requested changes pass through the adapter and become local
  truth only after the provider confirms them. Conflicts are explicit.
- Publish, reprice, end, relist, add tracking or mark shipped, and send-message actions always require
  explicit seller confirmation. Confidence or eligibility can recommend an action but cannot cause
  one.
- A sold-elsewhere flow defaults **Also end on eBay** on, yet still executes only after one explicit
  confirmation and verified listing ownership/mapping.

### Post-sale and economics honesty

- Launch may reflect sold, paid, ship-by, shipped, canceled, tracking, and an approved authoritative
  delivery signal. Standard eBay Fulfillment `FULFILLED` is labeled **shipped**. It does not prove a
  carrier delivery event.
- Safe post-sale writes are limited to verified, seller-confirmed actions such as adding tracking or
  marking shipped. Cancellations, refunds, returns/cases, disputes, and label purchase remain status
  plus honest eBay handoff surfaces at launch.
- Cost basis is optional on the draft and may be requested again at sale. Without cost, show revenue,
  estimated fees, and estimated net proceeds; do not label a number as profit. Adding cost later may
  update profit retroactively.

### One-item product posture

The default launch path is one item to one usable draft and seller-controlled publish. Advanced
volume workflows remain a later growth path. They do not replace the central one-item capture action,
weaken per-item credits or review, or introduce marketplace automation.

## Visual and asset contract

- Preserve the approved **White Seller Utility** direction. Older visual hypotheses and character
  systems are superseded; do not reintroduce them or invent a new direction in implementation.
- Use `#3665F3` for the locked action blue. The approved Pricing source currently renders `#0031E9`;
  that is a temporary visual-diff exception, not a second implementation token.
- Use only the approved transparent Scout files at their allowed guide moments. Preserve alpha,
  silhouette, intrinsic ratio, color, and approved size role. Do not redraw, regenerate, vectorize,
  recolor, rotate, mask, box, or make Scout persistent.
- Product photos in the review package are temporary review fixtures. They cannot ship. Replace them
  with cleared production photography, and never reuse pixels from reference apps.
- Native implementation uses real system permission UI, safe areas, Dynamic Type, VoiceOver,
  Reduced Motion, non-color status cues, and at least 44-by-44-point targets. Screenshot acceptance
  compares the implementation beside or over the supplied rendered reference; geometry-only checks
  are insufficient.

## Implementation stop rules

1. Verify the ZIP hash and read `README-FIRST.md` plus the relevant machine-readable files.
2. Confirm the state is `implementation_frozen` in the JSON inventory and is owned by the active
   issue. Status in a rendered board alone is insufficient.
3. Stop at candidate, withheld, delta-gated, container, optional, or planned states. Do not infer the
   next screen.
4. Keep SwiftUI behind the versioned provider-neutral HTTP contract. Do not duplicate entitlement,
   pricing, queue, marketplace, publishing, or messaging policy in the client.
5. Keep design work and active provider artifacts read-only unless a separate design task explicitly
   owns them.
