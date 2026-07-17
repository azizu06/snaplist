# SwiftUI mapping notes

These notes map approved design concepts to native iOS primitives. They are not production SwiftUI code and do not authorize changes outside the frozen screen families.

## Native structure

- Use `NavigationStack` for pushed destinations such as sold comps, run detail, Activity, Account, and contextual task destinations.
- Use `.sheet` with native detents and dismissal behavior for marketplace explanation, returning-user sign in, add cost, manual price, and the CAP-01 launcher where appropriate.
- Use the actual camera and photo-picker authorization APIs. Render the operating system permission alert; never reproduce the HTML alert in production.
- Use `UIApplication.openSettingsURLString` for the denied-camera Settings handoff, then re-read authorization state when the app becomes active.
- Use `safeAreaInset(edge: .bottom)` or an equivalent native composition for pinned action trays and the floating dock. Do not hard-code around the home indicator.
- Use `Material` only where the design calls for translucent dock/sheet material. The reference blur values describe intent; native material should remain legible and performant.

## Shell and scrolling

- Keep the five destinations exactly Home, Listings, central Capture, Inbox, and Insights.
- Account/Settings opens from the header avatar; the bell opens Activity. Do not create Runs or You tabs.
- The floating dock belongs above the bottom safe area and disappears while the search keyboard is visible.
- Seller Home content scrolls behind the floating dock with enough bottom content inset that the final row is never obscured.
- Pricing uses a scrolling evidence region plus a pinned payout/action tray. The tray must not cover chart/comp content at large Dynamic Type sizes.

## State and data

- Model canonical UI states explicitly rather than deriving labels from unrelated booleans.
- Sold-comp point count, row count, evidence copy, median/range, selected comp, and chart must share one fixture/data source.
- Camera guidance must use real framing results. Preserve the complete item and accepted thumbnail; never crop merely to imitate the reference.
- Persist staged photos across navigation and process interruption according to the product contract.
- External authorization, eBay truth, and durable run status remain authoritative. Never manufacture a successful state for visual continuity.

## Accessibility

- Apply `.accessibilityLabel`, `.accessibilityHint`, selected/pressed traits, and stable reading order to all named controls.
- Use `@Environment(\.accessibilityReduceMotion)` to replace slide, rise, scale, bounce, and spring transitions with opacity or immediate state changes.
- Build from semantic Dynamic Type text styles or scaled metrics while preserving the measured hierarchy. Twelve points is the absolute reference floor, not permission to disable scaling.
- Keep every interactive hit region at least 44×44 points, including icons, close buttons, chips, and chart/list selection targets.
- Restore focus to the opener after sheets and alerts dismiss.
- Status always combines icon/shape with words; never depend on color alone.

## Charts and evidence

- Prefer Swift Charts when it can reproduce the verified plot and interaction accurately; otherwise use a custom SwiftUI `Canvas` with accessible list fallback.
- Chart scrubbing must select an actual sold record and expose the same record as the corresponding list row.
- Use tabular figures for currency, ranges, counts, and chart labels.
- The current Pricing source uses `#0031E9`; implementation should use the locked action color `#3665F3` and record the temporary golden delta until the design source is reconciled.

## Visual implementation sequence

1. Import tokens and approved Scout assets.
2. Build typography, buttons, chips, seller rows, headers, sheets, dock, and pinned trays in isolation.
3. Implement the app shell and safe-area behavior.
4. Implement Accountless Onboarding and its real permission paths.
5. Implement Capture entry and guided-camera states with real item framing.
6. Implement Seller Home variants and contextual navigation.
7. Implement Pricing fixtures, chart/list parity, sheets, and pinned tray.
8. Add VoiceOver, Dynamic Type, Reduced Motion, focus restoration, and denied/error behavior.
9. Capture canonical screenshots and compare against the visual-regression manifest.

Do not implement the Photo Review candidates or any later family until a subsequent package marks them implementation-frozen.
