# Selected H paywall drawer

The selected design is hybrid H: Scout at a seller's packing counter, with the localized StoreKit plan presented as a taped packing slip. The drawer fits its content at standard text sizes. Accessibility sizes use a scrolling full-height sheet. Pending and verified confirmation retain the same plan, with distinct Scout poses and stamped status.

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
