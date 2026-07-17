# Seller Home visual fidelity

The approved source is the frozen implementation package whose SHA-256 is
`13ea5cfc237a98d188452b66abde94fb24b44e2e539ee63f42eb232120672415`.
All four native states were captured on the isolated iPhone 15 Pro simulator at
the canonical 393 x 852 logical viewport with Reduced Motion enabled, then
compared using `ios/Scripts/visual-diff.sh`.

| State | Normalized pixel error | Reviewed outcome |
| --- | ---: | --- |
| HOME-01 | 0.079756 | Approved information order, counts, attention priority, current durable stage, reassurance, and dock are preserved. |
| HOME-02 | 0.110930 | Approved first-item copy, capture CTA, and three-step explanation are preserved. |
| HOME-03 | 0.117479 | Approved six-item attention order, unread count, current durable stage, and dock are preserved. |
| HOME-04 | 0.072987 | Approved focused search, filters, recents, keyboard presentation, and hidden dock are preserved. |

Justified native deltas:

- The simulator renders the real iOS 26 status region, Dynamic Island, safe
  areas, and software keyboard instead of the prototype's drawn system chrome.
- SF Symbols stand in for the prototype's remote Unsplash thumbnails and avatar.
  Temporary review photography is intentionally absent from shipping assets.
- Active Home states include a native 44-point search control so the approved
  HOME-04 listing search and filters are reachable outside visual fixtures.
- SwiftUI text metrics, native control focus, and accessibility touch targets
  introduce small line-wrap and spacing differences while preserving hierarchy.

The canonical actuals, references, side-by-sides, and 50 percent overlays were
generated under `/private/tmp/snaplist-issue208-visual/` for review evidence and
are intentionally not bundled into the application.
