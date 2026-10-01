# Selected H paywall drawer

The selected design is hybrid H: Scout at a seller's packing counter, with the localized StoreKit plan presented as a taped packing slip. The drawer fits its content at standard text sizes and scrolls when its natural content exceeds the available native sheet viewport. Accessibility sizes use a scrolling full-height sheet. Pending and verified confirmation retain the same plan, with distinct Scout poses and stamped status.

## Design authority and research receipt

The interactive review compared A (Scout's counter), B (peek-over drawer), and C (packing slip), then refined A, C, and their hybrid. The final choice is H. Captured Lavish feedback rounds 3 and 4 explicitly choose H, compact fitting, minimal text, and no unfinished gap between the heading and Subscribe. The task's recorded review session is `b52684ad297b91a8`; its prior worker recorded closure and listener retirement before implementation. Review captures remain private task artifacts.

The prior worker's Mobbin retrieval receipt records six real Duolingo iOS screens, including [this retrieved screen](https://mobbin.com/screens/fd3e8e2e-0b82-4e2f-8223-b410a3e325f9). This is historical retrieval evidence, not a new retrieval on resume. Its friendly mascot-led hierarchy informed the exploration; no reference pixels or trademarks ship. The three scene backgrounds accompany existing approved Scout assets; no new mascot replaces Scout.

The current purchase-recovery evidence and contract are in [the recovery report](../purchase-success-loop/report.md). This visual change uses that existing store. It adds only a read-only accessor for the offered product and stabilizes a DEBUG timeout fixture. It does not duplicate the SDK, server, or account-switch repair.

## Presentation contract

- Offer: one short heading and Scout line, StoreKit title/cadence/localized price, monthly AI-listing benefit without an invented allowance number, renewal disclosure, Subscribe, Restore, close, Terms, and Privacy.
- Checking: busy presentation and no dismissal or duplicate purchase action while the existing store is confirming.
- Pending: explicitly unconfirmed, with Check again, Restore purchase, and Close. No Subscribe and no charge-absence claim.
- Verified: Pro-on presentation only after the existing server eligibility gate. Item entry resumes once; Settings entry finishes with Done.
- Failed SDK purchase: plain failure and recovery copy, without asserting that no charge occurred.
- Settings: the existing Get SnapList Pro row opens this same paywall, preserving included/operator/active/awaiting-server/expired presentation rules and account ownership.

Native primitives are SwiftUI sheet detents, safe-area inset, native buttons, Dynamic Type, accessibility focus, and reduced-motion transitions. The repository's native deployment/availability policy remains in force; server and StoreKit truth govern every plan and entitlement claim.

Small corrections carried with H: the kraft labels were darkened from 4.17:1 to 5.69:1 contrast against white, and the generic SDK-failure copy stopped claiming that nothing was charged.

## Posted Devin comment dispositions

The requested `data/snaplist-own-ebay-listing-link/devin-feedback-triage.md` was absent in this isolated checkout. The three available posted comments were retrieved read-only from the forge instead. Green bot status was not used as triage. The historical merged PR is cited only for comment identity, not as this implementation's delivery.

| Posted finding | Disposition and current evidence |
| --- | --- |
| [Previous account's subscription survives switching](https://github.com/azizu06/snaplist/pull/1157#discussion_r4148784427) | Fixed by existing main/recovery work. `SettingsSubscriptionAccountScope.rebind` compares Clerk account ID as well as display identity; `testSameEmailAndMethodStillResetSubscriptionForADifferentClerkID` exercises equal email/method with distinct accounts. Preserved here. |
| [Previous account's load overwrites new subscription](https://github.com/azizu06/snaplist/pull/1157#discussion_r4148784596) | Fixed by existing main/recovery work. Captured store ownership and request generation guard configuration, entitlement application, and load phase. `testAccountSwitchDiscardsSuspendedConfigurationAndServerResponses` exercises both suspended boundaries. Preserved here. |
| [Old account's paywall opens after switching](https://github.com/azizu06/snaplist/pull/1157#discussion_r4148784770) | Fixed by existing main/recovery work. `preparePlans` checks the captured reading and the paywall owner after awaiting preparation; stale plans are dropped. `testAccountSwitchDiscardsAPaywallPreparedForTheOldAccount` covers this. Preserved here. |

## Verification

Focused simulator and unit results, exact source head, and Graphify receipt are recorded in the new direct PR. Local result bundles and synthetic screenshots live in ignored `ios/Artifacts/`; generated graph output stays uncommitted. No physical phone, purchase, grant, login, production configuration, ledger, or RevenueCat configuration action is part of this delivery.

Resume validation: 104 focused unit tests and ten production UI tests passed on the owned iPhone 17 Pro simulator (iOS 26.5), with result bundle `ios/Artifacts/paywall-h-focused.xcresult`. The original swipe test went RED; a disappearance wait alone stayed RED; dragging from the upper scene went GREEN. The title's new bottom position left the old gesture too little travel. No production gesture handler was added. The fitted detent also stopped adding a second bottom inset. Native captures revealed stamp crowding of the renewal row; the stamp now reserves its own paper area, with a focused confirmation delta check.

Release configuration contract, token routing, test-runner contract, and the 237-selector shard inventory passed. The initial unsigned simulator invocation failed before reaching the UI because Clerk keychain access needs signing; normal simulator signing fixed the harness. The MCP cold-build call timed out while its underlying build continued; the completed build was preserved and subsequent bounded tests used direct `xcodebuild` with diagnostic collection disabled. No no-mistakes run, independent reviewer delegation, or long UI shard was used under the task's explicit fast path.

## Short-height overflow follow-up

[Long plans hide purchase terms](https://github.com/azizu06/snaplist/pull/1178#discussion_r4151994524): **fix**. At normal text size, a DEBUG-only fixture caps the actual mounted native drawer to a 360-point detent on the owned 402×874 simulator and supplies a longer synthetic product title and 12-month renewal metadata. It uses the production `ProGateSheet`, layout, native gestures, and footer; no product catalog or purchase is changed.

Before the fix, three upward drags left the plan frame exactly unchanged: `(23.19, 573.87, 355.62, 186.33)`. Subscribe remained hittable at y=820.23 while the title truncated and the legal row fell beyond the screen. The renewal row itself was visible in this particular pre-fix capture; the reproduced defect is the constrained, non-scrolling layout and unreachable full plan/legal disclosure, rather than a claim that every short layout hides that row. A 460-point cap still fit the terms, so the repro was reduced to the smaller available viewport. The normal unmodified drawer passed the control clearance check.

The narrow counterfactual keeps the native cap and adds an actual bounded viewport, natural wrapped-content measurement, and an overflow-only scroll path. The existing safe-area inset reserves the footer at its natural height. After the change, scrolling exposes the price and complete renewal line above Subscribe, with Restore, Terms, and Privacy reachable and the footer stationary. Normal fitted drawers retain the non-scrolling path and native downward dismissal. No custom screen-height estimate, billing logic, or production plan is introduced.

RED result: `ios/Artifacts/paywall-h-overflow-red3.xcresult`. Initial GREEN: `ios/Artifacts/paywall-h-overflow-green.xcresult` (overflow, normal clearance, native dismissal). Synthetic before/after captures are exported under `ios/Artifacts/paywall-h-overflow-green-attachments/`. Final rebased checks and Graphify source receipt are recorded on the same direct PR.
