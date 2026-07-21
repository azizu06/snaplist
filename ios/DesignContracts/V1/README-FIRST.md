# SnapList native V1 package — superseded authority notice

Status: **historical evidence only; no SwiftUI implementation authorization**

Epic [#349](https://github.com/azizu06/snaplist/issues/349) replaced this package’s five-tab native
V1 with the lean Scan-to-Trophy-Wall MVP. Read `PRD.md`, ADR-0008, and
`docs/design/native-v1-design-inventory.json` before using anything in this directory.

Current product authority:

- exactly two primary destinations: **Scan** and **Trophy Wall**;
- Settings from the profile avatar;
- one to five ordered photos plus optional voice context capped at fifteen seconds;
- asynchronous processing after durable acceptance, expressed in plain seller language;
- first usable listing before signup/paywall;
- eBay as the only direct-publish destination;
- Facebook Marketplace, Mercari, and Depop as prepared/shared export packs only.

The original design tokens, screen specs, routes, copy, manifests, and checksums are retained in the
repository at [`../Retired/V1-2026-07-16`](../Retired/V1-2026-07-16/ARCHIVE-NOTICE.md); the original
PNG assets remain byte-for-byte in this package's `assets/` directory. They are historical evidence
only and do not authorize implementation, visual-regression acceptance, or inference of adjacent
states. In particular, do not recreate Home/Listings/central Capture/Inbox/Insights navigation,
activity center, separate Runs, buyer messaging, analytics, post-sale operations, bulk/haul posture,
barcode-only capture, or garment measurements.

Final SwiftUI composition waits for the redirected versioned high-fidelity design package and its
owning issue. Preserve the existing RLS, App Attest, durable pipeline/recovery, credit, effective-price,
coherent-correction, and eBay-adapter boundaries while waiting.
