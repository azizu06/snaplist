# Retired SnapList native V1 contract archive

This directory preserves the content of the text contracts from `origin/main` at
`b01d9b4d59b884392434d65675943e276fd2a5e8`, before epic #349 superseded their product authority.
Repository patching normalized a missing terminal newline in
`CLAUDE-DESIGN-CONTRACT-EXTRACT.txt`, so this is not a byte-for-byte clone of the source commit or
external ZIP. `ARCHIVE-MANIFEST.json` records the actual repository-copy bytes and makes this archive
integrity-verifiable. The archived `SOURCE-MANIFEST.json` remains the old package’s historical hash
record; its hashes must not be presented as verification of the normalized repository copy.

The archive is historical evidence only and does not authorize SwiftUI implementation.

The three original PNG assets remain byte-for-byte at `../../V1/assets/` because Git does not need a
second binary copy. Their hashes are recorded in the archived `SOURCE-MANIFEST.json`. The original
absolute ZIP path is provenance, not the only way to review the archived contracts.

For current authority, read `PRD.md`, ADR-0008,
`docs/design/native-v1-design-inventory.json`, and `../../V1/README-FIRST.md`.
