# Showcase screenshot provenance

All seven phone images are stills from the captain's native iPhone screen recording,
`RPReplay_Final1790869944.MP4` (1206 × 2622, 439.768 seconds). They replace the
older Mirroring captures. Each uses the same original repository-authored generic
iPhone-style enclosure, transparent 480 × 996 WebP output and 220 px display width.
The enclosure is illustrative, not an Apple marketing asset or a photographed device.
The animated Scout remains unchanged and is documented below.

| README image | Shared native PNG | Source time (seconds) | What it shows |
| --- | --- | --- | --- |
| `phone-capture.webp` | `native-01-shoe-capture.png` | 8.5 | Jordan 3 shoes in the capture camera. |
| `scout-pro.webp` | `native-02-pro-on-sandbox.png` | 85.0 | Actual "SnapList Pro is on" screen during the Apple sandbox demonstration, with Scout and monthly terms. |
| `phone-to-list.webp` | `native-03-to-list.png` | 352.8 | Two ready items with rendered backpack and mouse thumbnails; no raw item ID title or placeholder. |
| `phone-listing-review.webp` | `native-04-listing-sold-comps.png` | 207.5 | Jordan 3 review: $155 price, three sold matches, $100–$180 range, sale cards and editable fields. |
| `phone-ebay-posted.webp` | `native-05-posted-to-ebay.png` | 301.7 | Actual post-success screen, Jordan photo and "Live on eBay" label. |
| `phone-flips.webp` | `native-06-flips-live.png` | 321.0 | Populated Flips with the posted Jordan photo, after loading completes. |
| `phone-sharing.webp` | `native-07-facebook-share.png` | 378.0 | Logitech mouse sharing drawer at $44.95 with two photos; Facebook Marketplace, Mercari and Depop all show Not started. |

## Capture quality, privacy and evidence

The source timestamps fall within the editor's corresponding `screen` ranges in
`data/snaplist-demo-edit/edit/edl.json`. They were checked against the walkthrough
bug log. Selected frames contain no mouse cursor, raw "Item <id>" title, empty
"No items yet" state, "Can't load" state, "(seller-stated)" suffix, error banner
or missing item photo. Each source and framed output was visually inspected.
No readable name, email, account ID, credential or notification is displayed.
The one-letter profile avatar remains visible where captured.

The native PNGs are unretouched full-resolution extracts. No status-bar crop was
needed because no notification is visible. Native recording, microphone/camera,
time and battery indicators remain source content. Framing resizes proportionally
and rounds the screen aperture; it does not redraw UI or digitally remove a cursor.
No source commit or installed-build SHA is inferred from the recording filename.

The Pro-on image is explicitly an Apple sandbox demonstration, not a live Apple
purchase receipt or permanent price/allowance commitment. The eBay success screen
shows the app's recorded confirmation; this extraction task did not publish an
item or independently re-query eBay. Published is distinct from sold. The sharing
screen shows Not started and is a manual handoff, not an external Facebook,
Mercari or Depop publish. Pricing wording is reproduced as displayed, without a
new independent sold-match evaluation. This task did not operate the phone.

## Reproduce and reuse

The seven native PNGs and their receipt are exported to the authorized local
`~/Desktop/snaplist-clips/stills/` folder for the Devpost worker. The raw recording
and PNGs are not committed to this repository.

[Native still receipt](native-still-receipt.json) records the source-video hash,
editor EDL hash, source seconds, native dimensions, PNG filenames and hashes.
To extract an individual still without resizing or filtering:

```sh
ffmpeg -ss SOURCE_SECONDS -i RPReplay_Final1790869944.MP4 \
  -map 0:v:0 -frames:v 1 -threads 1 STILL.png
```

Copy the selected PNGs under their listed filenames to ignored
`ios/Artifacts/readme-input/`, then regenerate the README images from the root:

```sh
python3 scripts/readme/frame-screens.py \
  --manifest scripts/readme/sources.json --output-dir docs/readme
```

[Frame receipt](frame-receipt.json) records the frame, source and output hashes,
encoder version, byte counts and dimensions. See the
[framing tool instructions](../../scripts/readme/README.md) for crop validation.
All older pointer-bearing or placeholder captures are excluded. The old
`listing-review.png` and `trophy-wall.png` remain only for historical simulator
evidence in the [developer guide](../developer-guide.md#screenshot-provenance).

## Scout hero animation

`scout-barcode.gif` is an offscreen frame render of the app's accepted transparent
`ios/SnapList/Resources/FirstValueOnboarding/032-seedance-barcode-scan.webm`
animation at source commit `408bddc0`. `TrophyWallScout.barcodeScan` in
`ios/SnapList/Features/Home/HomeScoutMotion.swift` selects this clip and its
alpha-preserving MOV runtime derivative for empty Flips. No mascot motion was
redrawn or generated for the README. No simulator or physical phone was used.
The app plays this home-state clip once; the README repeats it indefinitely.

The GIF preserves transparency and the complete scan action, crops only the
transparent margins, and uses a shared 128-color palette. It is 240 × 255 px,
65 frames / 4.06 seconds at approximately 16 fps, and 1,483,536 bytes. Its compact
180 px centered placement keeps the existing screenshots immediately beneath the hero.
The barcode is mascot illustration, not a promise of barcode-only capture.

Regenerate from the repository root with FFmpeg (the explicit libvpx decoder
preserves the WebM alpha channel):

```sh
ffmpeg -y -v error -c:v libvpx-vp9 \
  -i ios/SnapList/Resources/FirstValueOnboarding/032-seedance-barcode-scan.webm \
  -filter_complex '[0:v]fps=16,crop=784:834:100:50,scale=240:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:reserve_transparent=1:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:alpha_threshold=128' \
  -loop 0 docs/readme/scout-barcode.gif
```
