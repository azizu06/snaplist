# Showcase screenshot provenance

All four showcase images are captures of the running SwiftUI app on an iPhone 16 Pro, iOS 27.0, normal signed Release at `56ed76107a143e4d85962bdf3afee5b93fd5695a`. Each source and final image was visually inspected before committing; captures with account details were excluded. No UI was composited or retouched.

| Image | Phone worker source | What it demonstrates |
| --- | --- | --- |
| `phone-to-list.jpg` | `devpost-screens/to-list-1790835303-1179x2556.png` | A retained keyboard item ready for review and the Scout/dock layout. |
| `phone-listing-review.jpg` | `phone-visual-56ed7610/02-review-workflow-done-restored.png` | Compact editable review fields. The $90 value has **no verified sold matches**, as the screen states. |
| `phone-flips.jpg` | `devpost-screens/flips-1790835301-1179x2556.png` | The empty finished-items destination and Scout; no sold/published history is implied. |
| `scout-pro.jpg` | `devpost-screens/scout-pro-paywall-1790835302-1179x2556.png` | The actual Scout paywall opened from Settings. Account details were scrolled offscreen before capture. The displayed $9.99 is the product price in this build, not a purchase receipt or a permanent public price commitment. |

All source paths are relative to the phone worker's local `ios/Artifacts/input-keyboard-followup/` folder. The source artifacts and private test logs remain ignored. This README task did not operate the phone or make a purchase. These screenshots do not establish a live App Store purchase or restore.

To list, Flips, and Pro came from on-device XCTest screenshot attachments. Their 1206 × 2622 originals were exported by the phone worker to 1179 × 2556 using an explicitly authorized proportional resize and center crop, preserving the real status bar. They have no device/Mirroring frame. This task compressed To list and Flips to JPEG at 780 px high and Pro at 1000 px high.

The review image retains the iPhone Mirroring frame, status bar, and pointer/focus decoration and is stored at 560 px high. It shows more editable fields than the newer review capture, whose main photo falls back to a placeholder; that newer capture was not selected. Neither review capture provides verified sold-comp evidence.

Only item content and a one-letter avatar are visible in the selected root/review screens; no name, email, address, account ID, notification, or credential is displayed. No Subscribe or Restore action was taken for the paywall capture.

The older `listing-review.png` and `trophy-wall.png` filenames remain for the historical simulator evidence described in the [developer guide](../developer-guide.md#screenshot-provenance). Those fixture matches are not live sales research and are not the current hero images.

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
centered placement keeps the existing screenshots immediately beneath the hero.
The barcode is mascot illustration, not a promise of barcode-only capture.

Regenerate from the repository root with FFmpeg (the explicit libvpx decoder
preserves the WebM alpha channel):

```sh
ffmpeg -y -v error -c:v libvpx-vp9 \
  -i ios/SnapList/Resources/FirstValueOnboarding/032-seedance-barcode-scan.webm \
  -filter_complex '[0:v]fps=16,crop=784:834:100:50,scale=240:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:reserve_transparent=1:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:alpha_threshold=128' \
  -loop 0 docs/readme/scout-barcode.gif
```
