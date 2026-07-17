# README FIRST — SnapList RUN + REV implementation delta

Version: RUN/REV delta v1.1  
Date: 2026-07-16  
Status: approved implementation delta  
Exact base: `snaplist-implementation-fidelity-package-v1-2026-07-16.zip`

Replacement: this archive supersedes `snaplist-implementation-fidelity-delta-run-rev-v1-2026-07-16.zip` (SHA-256 `d6468601ac3ad584caaf69b9bf27d64d1b5d2d8eb575f26576babed30e13e001`) only to apply the ADR-0008 customer-facing plan-name correction: `Seller Pro` → `SnapList Pro`. Layout, state IDs, routes, and approval status are unchanged.

This ZIP is self-contained for the two newly approved design families. It adds complete resolved JSON contracts, exact copy, routes, accessibility behavior, local rendered references, canonical board captures, assets, and hashes. It does not promote any candidate or repair family.

## Approval manifest

- Approved additions: RUN-01–08; REV-01, REV-02 (frames 02a–02e plus technical-retry and tested keep/replace variants), REV-07, REV-08.
- Candidate unchanged: CAP-03a/b/c/d/e and CAP-04.
- Withheld: CAP-05. Do not implement from this package.
- Base V1 remains the source for its 25 approved golden states.

## GitHub routing

- Epic #204 owns the iOS fidelity rollout.
- #205 is the native foundation/fidelity harness.
- #206 onboarding, #207 capture launcher/guided camera, #208 Seller Home, and #209 pricing evidence remain orchestrator-controlled; this delta does not promote or change them.
- #161 is the backend dependency for durable notification, retry, cancel, Realtime fallback, and tenant-safe deep links.
- #167 remains provider-neutral inventory reconciliation; this package does not alter it.
- RUN-01–08 routes to #211 after #205/#161 contracts are available.
- REV-01/02/07/08 routes to #212 after #205/#174/#211 contracts are available.
- The design-review task did not create GitHub issues. The orchestrator owns issue creation/routing.

## Start here

1. Read `delta-manifest.json`.
2. Read `contracts/run-backend-contract-mapping.json` and `contracts/rev-guided-correction-contract.json`.
3. Use `changes/` to understand additions and `resolved/` as the complete post-delta implementation contract.
4. Open the local HTML references and compare with the bundled canonical board captures and live Claude URLs.
5. Bind routes to native iOS navigation/sheets/alerts and the real server contracts. Do not port HTML mechanics.
6. Run the visual-regression, VoiceOver, Dynamic Type, Reduced Motion, target-size, offline, error, notification, and deep-link gates before promotion.

## Golden exception

The action-blue discrepancy is resolved for implementation: use `#3665F3`. The older Pricing source’s `#0031E9` remains only a recorded visual-diff exception; do not create a second action-blue token.

The customer-facing plan name is `SnapList Pro`. `Seller Pro` has zero canonical occurrences in this replacement package and must not render in SwiftUI.

## No reverse-engineering rule

All approved assets and behavior contracts needed for these families are local in this ZIP. Temporary item photography is marked and is not a production asset. The live Claude URLs are visual evidence, not the only source of behavior.
