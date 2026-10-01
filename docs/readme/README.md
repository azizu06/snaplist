# Showcase screenshot provenance

The README uses real captures of the running native app inside one original,
repository-authored generic iPhone-style presentation frame. Every phone image
is transparent, 480 × 996 px and displayed at 220 px wide. The frame is illustrative;
it is not an Apple marketing asset or a photographed device. The animated Scout
below remains the app animation described later in this file.

| Image | Phone worker source | What it demonstrates |
| --- | --- | --- |
| `phone-to-list.webp` | `devpost-screens/to-list-1790835303-1179x2556.png` | A retained keyboard item ready for review. Native screenshot attachment from signed Release `56ed76107a143e4d85962bdf3afee5b93fd5695a`. |
| `phone-listing-review.webp` | `devpost-screens/mirroring-set/shoes-ready-review-hero-phone.png` | Air Jordan 3 Retro White Cement Reimagined, Men's Size 10: four photos and editable $160 price. |
| `phone-price-evidence.webp` | `devpost-screens/mirroring-set/shoes-review-comp-cards-1-2-phone.png` | The same item's actual five sold matches, $100–$219.99 range, and $155 / $219.99 eBay sale cards. |
| `scout-pro.webp` | `devpost-screens/mirroring-set/pro-paywall-before-purchase-phone.png` | Scout Pro opened after saving shoe intake; $9.99 monthly terms, Subscribe, Restore, Terms and Privacy. This is a pre-purchase screen, not a purchase receipt. |

Source paths are relative to the phone worker's local ignored
`ios/Artifacts/input-keyboard-followup/` folder. The Mirroring captures came from
installed native source `408bddc0d01811958b9c27f115783f9488c7e1e5`; the worker's
`sandbox-shoes-capture-manifest.json` documents the review captures and source
commit. They were cropped by that worker from 652 × 1436 windows to the observed
620 × 1344 phone bounds at +16+76, without content edits. Pointer decorations
inside the screen are retained; the Mac window and surrounding background are
excluded. No UI, prices, sold cards or item photos were fabricated or painted in.

Each selected full-resolution source and framed output was visually inspected.
No email, name, account ID, credential or notification is visible. All files
marked private and all account-background captures were excluded. The earlier
empty Flips screenshot and review placeholder were removed from the showcase;
a populated Flips/sharing capture can replace this interim price-evidence shot
when the phone worker supplies it. Actual price-evidence wording is shown as
captured; framing does not independently validate the matcher or every sale.
Prepared/shared export packs must remain distinct from eBay publish or sold status.

This task did not operate the physical phone, publish a listing or purchase a
subscription. Screenshots do not establish an App Store release or a live Apple
purchase/restore. The selected paywall price is this build's product price, not a
permanent public price commitment.

## Reproduce the framed images

See [the framing tool instructions](../../scripts/readme/README.md). Copy the
selected raw files under their original filenames to ignored
`ios/Artifacts/readme-input/`, then run from the repository root:

```sh
python3 scripts/readme/frame-screens.py \
  --manifest scripts/readme/sources.json --output-dir docs/readme
```

The tool preserves screen proportions, clips the rounded screen aperture, adds
the original device enclosure and hardware island, and encodes WebP with
transparent alpha. [frame-receipt.json](frame-receipt.json) records exact source,
frame and output hashes, crop rectangles, encoder version, size and dimensions.
Raw files and private test logs remain ignored.

The older `listing-review.png` and `trophy-wall.png` filenames remain only for
historical simulator evidence in the [developer guide](../developer-guide.md#screenshot-provenance).
Those fixture matches are not live sales research or current hero images.

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
