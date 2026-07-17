# SnapList iOS foundation

`ios/` is the native SwiftUI product inside the existing SnapList monorepo. It does not reorganize or duplicate the TypeScript/Supabase server. Issue #205 owns this foundation; the approved onboarding, capture, home, pricing, durable-run, and review screen families remain in their child issues.

## Toolchain and deployment target

- Xcode 26.5 (local validation build 17F42).
- iOS 17.0 minimum deployment target.
- iPhone app target plus unit-test and UI-test targets.

iOS 17 is the smallest production-shaped target for this foundation because the app router and native data flow use Apple's Observation framework and `@Observable`. Apple's [Observation migration guidance](https://developer.apple.com/documentation/swiftui/migrating-from-the-observable-object-protocol-to-the-observable-macro) marks those SwiftUI APIs as iOS 17+, while Apple's [Xcode support matrix](https://developer.apple.com/support/xcode/) confirms current Xcode can deploy to iOS 17. This is an implementation/tooling floor, not a product analytics claim.

## Run and test

Open `SnapList.xcodeproj`, select the shared `SnapList` scheme, and use an iPhone simulator. From the repository root:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer ios/Scripts/test.sh
```

Override `SNAPLIST_IOS_DESTINATION` when the default `iPhone 17 Pro, OS=latest` simulator is unavailable.

The shell exposes deterministic launch arguments for UI tests and future family implementations:

- `--fixture=home|listings|inbox|insights|account|activity|capture`
- `--zero-network-fixtures`
- `--visual-state=<approved manifest ID>`
- `--reduced-motion`
- `--keyboard-probe`
- `--dynamic-type=accessibility3`

`--visual-state` accepts only the 42 approved IDs in the resolved manifest. CAP-03a through CAP-04 remain candidates and CAP-05 remains withheld.

## Architecture boundary

- `AppRouter` owns typed per-tab navigation paths and item-driven sheets using SwiftUI Observation.
- The dock is Home, Listings, central Capture, Inbox, and Insights. Account and Activity are header routes; there is no Runs or You tab.
- `MobileAPIClient` currently executes only the implemented proof endpoints in `docs/contracts/mobile-api-v1.openapi.json`. Contract-only endpoints produce zero-network schema metadata through a separate fixture protocol and never imply server behavior.
- `AppDependencies` selects the live provider-neutral client or deterministic fixtures at the composition root.
- Screen-family placeholders are ownership markers, not implementations.

The repository OpenAPI contract remains authoritative. Its vendored copy exists only so the unit-test bundle can prove the typed inventory without network access.

## Design contracts and assets

- `DesignContracts/V1` preserves the original 25-state approved V1 package and its package hash.
- `DesignContracts/Resolved/V1PlusRunRev` vendors the canonical v1.1 RUN/REV replacement and resolves the approved inventory to 42 states. Its source manifest pins both package hashes, every resolved contract, the candidate/withheld boundary, and the #211/#212 implementation ownership.
- Only manifest-approved transparent Scout files are in the app asset catalog. Preserve their alpha, colors, silhouette, and intrinsic ratio; never crop, mask, box, redraw, recolor, rotate, or regenerate them.
- Temporary resale photography, reference-evidence pixels, and HTML reference implementations are deliberately excluded and must not ship.
- Action blue is locked to `#3665F3`. Destructive confirmations use the native platform role; there is no permanent custom red token.

## Fidelity capture and diff

Capture any approved state into an operator-controlled scratch path:

```sh
ios/Scripts/capture-visual-state.sh RUN-01 /tmp/RUN-01-actual.png
```

Compare it to an approved rendered reference crop. The command first verifies the state against the resolved visual manifest, then emits a side-by-side PNG, a 50% overlay, and a normalized mean absolute pixel error:

```sh
ios/Scripts/visual-diff.sh RUN-01 /path/to/RUN-01-reference.png /tmp/RUN-01-actual.png /tmp/RUN-01-diff
```

Reference crops and output remain operator-controlled scratch artifacts. Do not copy temporary product photography or third-party reference pixels into the repository or app bundle. XCTest attachments use Apple's supported [`XCUIScreenshot`](https://developer.apple.com/documentation/xctest/xcuiscreenshot) path for CI evidence.

## Accessibility foundation

The shell uses safe-area insets, scalable typography, labeled XCUITest IDs, 44-point minimum controls, VoiceOver labels, Reduced Motion-aware transitions, a keyboard-hidden dock, and deterministic accessibility-size fixtures. Unit and UI tests cover these invariants; family issues remain responsible for testing their actual approved screens.
