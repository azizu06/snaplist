# SnapList iOS foundation

`ios/` is the native SwiftUI client inside the SnapList monorepo. It does not reorganize or
duplicate the TypeScript/Supabase server.

> **Product authority changed in epic #349.** The current lean MVP has exactly two primary
> destinations, **Scan** and **Trophy Wall**, with Settings opened from the profile avatar. The
> existing five-tab shell and broad V1 state families are retained implementation history, not
> authority for new work. No SwiftUI recomposition is authorized until the redirected versioned
> high-fidelity package and owning issue are approved.

## Toolchain and deployment target

- Xcode 26.5 (local validation build 17F42).
- iOS 17.0 minimum deployment target.
- iPhone app target plus unit-test and UI-test targets.

iOS 17 is the implementation floor because the app router and native data flow use Apple’s
Observation framework and `@Observable`. This is not a product analytics claim.

## Run and test

Open `SnapList.xcodeproj`, select the shared `SnapList` scheme, and use an iPhone simulator. From the
repository root:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer ios/Scripts/test.sh
```

Override `SNAPLIST_IOS_DESTINATION` when the default `iPhone 17 Pro, OS=latest` simulator is
unavailable.

Existing deterministic launch arguments and visual-state fixtures remain regression tools for
shipped legacy code. They do not authorize retired navigation or screens. A future redirected design
package must supply new state IDs and visual acceptance references before implementation.

## Current product boundary

- **Scan** owns recoverable intake for one to five ordered photos and optional voice context capped
  at fifteen seconds. Issue #352 owns the photo-count behavior gap; #351 owns voice behavior.
- Processing continues asynchronously after durable server acceptance. Seller UI uses plain-language
  states and never exposes queue, worker, lease, or provider terminology.
- **Trophy Wall** is the compact local/server chronological projection; it is not Home, Listings,
  Inbox, Insights, an activity center, or a separate Runs destination.
- The first usable listing precedes signup/paywall.
- eBay is the only direct-publish destination and requires explicit seller confirmation through the
  adapter. Facebook Marketplace, Mercari, and Depop receive prepared/shared export packs only.

The retained OpenAPI still exposes `/v1/home` and a four-photo maximum as current runtime
compatibility. Its `x-snaplist-product-authority` metadata marks those as legacy/#352-owned gaps, not
lean navigation authority or evidence that the one-to-five target is already shipped.

## Architecture boundary

- `MobileAPIClient` stays behind the provider-neutral HTTP contract.
- RLS tenant isolation, App Attest guest authority, private Storage, durable pipeline/recovery,
  AI-item credit settlement, effective-price precedence, coherent correction, and eBay adapter
  authority remain server truth.
- Native code must not duplicate entitlement, queue, pricing, credit, provider, or marketplace
  policy.
- Existing screen-family placeholders and typed legacy routes are implementation history, not
  permission to extend retired product families.

## Design contracts and assets

- `DesignContracts/V1` is now a stop-notice/current-authority boundary.
- `DesignContracts/Retired/V1-2026-07-16` preserves the original text package locally for historical
  and checksum review. The original PNG assets remain byte-for-byte in `DesignContracts/V1/assets`.
- `DesignContracts/Resolved/V1PlusRunRev` is also historical evidence where it conflicts with #349;
  its former approved-state count does not authorize new work.
- Only a redirected, versioned high-fidelity package plus its owning issue may authorize future
  SwiftUI composition.
- Temporary resale photography, reference pixels, and HTML reference implementations must not ship.

## Accessibility foundation

Future approved composition must preserve safe areas, semantic Dynamic Type, VoiceOver labels,
Reduced Motion, non-color status cues, focus behavior, and minimum 44-by-44-point targets. Retired
visual geometry is not an acceptance reference for the new shell.
