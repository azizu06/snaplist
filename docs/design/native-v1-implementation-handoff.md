# Lean native design authority handoff

Status: **redirection boundary; no SwiftUI implementation authorization**

This document mirrors [`native-v1-design-inventory.json`](./native-v1-design-inventory.json).
`PRD.md` and ADR-0008 own product behavior. Epic
[#349](https://github.com/azizu06/snaplist/issues/349) supersedes the earlier native V1 information
architecture and state inventory wherever they conflict with the lean Scan-to-Trophy-Wall MVP.

## Current authority

- Primary destinations are exactly **Scan** and **Trophy Wall**.
- Settings opens from the profile avatar.
- Scan accepts one to five ordered photos and one optional voice note capped at fifteen seconds.
- Scan clears after durable server acceptance; processing continues asynchronously.
- Trophy Wall merges local pending intake with canonical server identity and shows plain-language
  states. It never exposes queue, worker, lease, or provider vocabulary or fake progress.
- The first coherent editable listing precedes signup/paywall.
- eBay is the only direct-publish destination. Facebook Marketplace, Mercari, and Depop receive
  honest prepared/shared export packs.
- RLS tenancy, App Attest guest authority, durable recovery, credit settlement, effective-price
  precedence, coherent correction, eBay adapter authority, and explicit seller confirmation remain
  binding.

The final high-fidelity composition remains owned by the redirected design task. Product/contract
work may proceed through its owning issue, but this document and JSON inventory do not authorize new
SwiftUI composition.

## Superseded packages

The following packages remain checksum-verifiable historical evidence only:

- Base V1 ZIP:
  `/Users/aziz.u/Documents/Codex/2026-07-15/snaplist-ios-design-review/outputs/snaplist-implementation-fidelity-package-v1-2026-07-16.zip`
  (`13ea5cfc237a98d188452b66abde94fb24b44e2e539ee63f42eb232120672415`)
- RUN/REV delta:
  `/Users/aziz.u/Documents/Codex/2026-07-15/snaplist-ios-design-review/outputs/snaplist-implementation-fidelity-delta-run-rev-v1.1-2026-07-16.zip`
  (`93bb1571b2926c4c79744a8fe28905f972a7fda506a81765376b704dbb964884`)

Their former `implementation_frozen` labels no longer authorize new work. Retaining the packages and
their historical migration/implementation evidence does not make their five-tab navigation or broad
state families current product authority.

## Attribute-scoped overrides on sealed packages

A newer package does not replace an older one wholesale. These records govern a single named
attribute each; every other attribute of the cited packages stays approved and in force, and the
sealed ZIPs are unmodified. `native-v1-design-inventory.json` holds the machine-readable form under
`seller_facing_copy_supersessions` and `package_claim_overrides`.

**Allowance noun.** The seller-facing noun for the included-first-run allowance
(`ai_item_allowance_periods`, `period_key = 'included-first-run'`) is **`AI listing`**, governed by
`snaplist-pro-gate-design-package-v1-2026-07-25` (`PAY-01`: `You made one AI listing for free.`).
`RUN-08`'s `Your first item is on us` / `Item 1 will finish free` phrasing is superseded **for that
attribute only** — `item` still means the seller's physical object, and RUN-08's other approved
states are untouched. New or revised copy naming this allowance uses `AI listing`.

The superseded noun still ships in the working tree at `ONB-06`
(`OnboardingDomain.swift` / `OnboardingFlowView.swift`), `HomeViews.swift`,
`src/lib/scout-guidance/catalog.v1.json`, its `approved-copy-provenance.v1.json` record, and a
`SnapListUITests` assertion. The JSON lists all five and states what the list excludes. Recording
the supersession does not reconcile them; seller-facing copy changes are owned by the active design
round and its implementing issue, and the UI test is expected to fail when that happens.

**Pro Gate free-publish claim.** `snaplist-pro-gate-design-package-v1-2026-07-25`'s README states
the first item is free end to end including its first eBay publish. That is **product intent, not
available behavior**, and must not be implemented from. No publish entitlement object exists in the
shipped schema: `ai_item_allowance_periods`, `ai_item_credit_reservations`, and
`revenuecat_customer_bindings` all grant AI item runs, and nothing grants, reserves, or settles a
publish. The package's own seller-facing strings promise nothing about publish and are unaffected.
See [#377](https://github.com/azizu06/snaplist/issues/377).

## Retired lean-launch families

| Family | Superseded records | Disposition |
| --- | --- | --- |
| Home, Listings, central Capture, Inbox, Insights, activity center, separate Runs | #204–#215 and original V1 frames | Replaced by Scan + Trophy Wall; Settings from profile avatar |
| Inbox and buyer messaging | #140, #141, #145, #146, #150 | Outside lean MVP |
| Generic analytics, Insights, profit dashboards, streaks | #118, #220, #274, #289 | Outside lean MVP |
| Post-sale, fulfillment, sold elsewhere, repricing, relisting | #169, #172, #176, #177 | Outside lean MVP |
| Bulk/haul capture and triage list | #100, #111, `CAP-06`, `CAP-07` | Outside launch posture |
| Barcode-only capture | `CAP-05` | Rejected; passive ISBN/UPC hints may remain internal |
| Garment measurements | #104, #116, #124, `CAP-08`, `CAP-09` | Outside MVP composition |
| Autonomous marketplace actions | legacy autopilot/reprice/message concepts | Prohibited; explicit confirmation remains mandatory |

Future triage must not recreate these families from historical screenshots, code, migrations, or
closed issues. Reintroduction requires a separately approved post-MVP contract that explicitly
reopens ADR-0008.

## Owned implementation gaps

- [#351](https://github.com/azizu06/snaplist/issues/351) owns optional fifteen-second voice-context
  authority and photos-only fallback.
- [#352](https://github.com/azizu06/snaplist/issues/352) owns the one-to-five mobile submission
  behavior contract.
- The redirected design task owns final high-fidelity screen composition.

Documentation describes the approved target; it must not claim those gaps are already implemented.

## Implementation stop rules

1. Stop if an issue asks for a state outside Scan, Trophy Wall, listing review, eBay publish, or the
   three honest export-pack destinations without explicitly reopening ADR-0008.
2. Stop if a retired V1 frame is offered as implementation authority. It may be used only as
   historical evidence or as a source of individually re-approved visual primitives.
3. Stop before SwiftUI composition unless the redirected versioned design package and owning issue
   are approved.
4. Keep native code behind provider-neutral server contracts. Do not duplicate entitlement, queue,
   pricing, credit, marketplace, or seller-confirmation policy in the client.
5. Preserve Dynamic Type, VoiceOver, Reduced Motion, non-color status cues, truthful progress, and
   minimum 44-by-44-point targets in any future approved design.
6. Stop if new or revised seller-facing copy names the included-first-run allowance anything other
   than `AI listing`.
7. Stop if a free-first-eBay-publish entitlement, gate, or seller-facing claim is being built from a
   design package README. No such entitlement exists in the shipped schema.
