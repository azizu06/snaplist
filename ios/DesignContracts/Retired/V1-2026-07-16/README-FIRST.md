# SnapList implementation fidelity package v1

Status: approved-family engineering handoff, 2026-07-16

This package is the implementation contract for the 25 independently approved SnapList states. It supplements the Claude Design artifacts with measured tokens, component anatomy, exact state/route contracts, assets, and visual-regression guidance. It is intentionally more complete than a screenshot handoff.

## Approved implementation scope

- Accountless onboarding and permission: 11 states
- Capture entry and guided camera: 6 states
- Pricing and market evidence: 4 states
- Seller Home: 4 states

Photo Review CAP-03a/b/c/d/e and CAP-04 are included only as six final-round candidates. Do not implement them as frozen production UI until a later package promotes them.

## Start here

1. Read `snaplist-design-tokens.json`.
2. Build the shared primitives in `snaplist-component-contract.json`.
3. Use `snaplist-screen-specs.json` and `snaplist-copy-catalog.json` state by state.
4. Wire `snaplist-interaction-routes.json` using native iOS presentation and navigation.
5. Apply `snaplist-asset-manifest.json` and the bundled transparent Scout assets.
6. Follow `snaplist-swiftui-mapping-notes.md`; the HTML files are reference code, not production code.
7. Capture implementation screenshots and compare them with the Claude master board according to `snaplist-visual-regression-manifest.json`.

## Visual sources of truth

- [Master Review Board](https://claude.ai/design/p/897124b5-5da4-447e-9dab-26706c006653?via=share&file=SnapList+Master+Review+Board+-+Approved+%2B+Final+Round.dc.html&present=1)
- [Implementation Fidelity Contract](https://claude.ai/design/p/897124b5-5da4-447e-9dab-26706c006653?via=share&file=SnapList+Implementation+Fidelity+Contract+-+Approved+Families+v1.dc.html&present=1)
- [Accountless Welcome + Photo Permission](https://claude.ai/design/p/897124b5-5da4-447e-9dab-26706c006653?via=share&file=Accountless+Welcome+%2B+Photo+Permission+-+Hi-Fi.dc.html&present=1)
- [Capture Entry + Guided Camera](https://claude.ai/design/p/897124b5-5da4-447e-9dab-26706c006653?via=share&file=Capture+Entry+%2B+Guided+Camera+-+Hi-Fi.dc.html&present=1)
- [Seller Home Live](https://claude.ai/design/p/897124b5-5da4-447e-9dab-26706c006653?via=share&file=Seller+Home+Live.dc.html&present=1)
- [Price Screen Live](https://claude.ai/design/p/897124b5-5da4-447e-9dab-26706c006653?via=share&file=Price+Screen+Live.dc.html&present=1)

The local `*-reference.html` files are exported rendered HTML/CSS snapshots for measurement and hierarchy inspection. Relative product-image URLs may require the live Claude project. Do not port DOM mechanics directly into SwiftUI.

## Known design-system discrepancy

The locked SnapList action color is `#3665F3`. The approved Pricing source currently renders `#0031E9` with badge fill `#EDF1FD`. Use the locked `#3665F3` in implementation and record the temporary visual-diff exception until the Pricing design source is reconciled. Do not introduce a permanent second action blue without explicit approval.

## Acceptance gate

A screen is implementation-complete only when:

- its canonical fixture and state match this package;
- navigation, sheets, alerts, denial/recovery, and back/cancel behavior match the route contract;
- controls are at least 44×44 pt and app text is at least 12 pt;
- VoiceOver, Dynamic Type, Reduced Motion, and non-color status cues pass;
- an implementation screenshot has been reviewed beside its Claude Design reference;
- no major geometry, copy, navigation, item framing, status, or approved asset differs intentionally.

Do not infer later processing, draft, publishing, paywall, Listings, Inbox, Insights, Account, Activity, export, order, or system-state designs from this package.
