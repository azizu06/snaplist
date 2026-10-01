# Showcase screenshot provenance

The README shows real captures of the native app in one original,
repository-authored generic iPhone-style presentation frame. Every phone image
is transparent, 480 × 996 px and displayed at 220 px wide. The frame is illustrative,
not an Apple marketing asset or a photographed device. The Scout animation is
unchanged and documented below.

| Image | Phone worker source in `devpost-screens/mirroring-set/` | Native source commit | What it demonstrates |
| --- | --- | --- | --- |
| `phone-airpods-review.webp` | `final2-03-airpods-review-1179x2556.png` | `6e74fc72dbdb2fa652f14c8e910573b8f7267d51` | Full AirPods Max hero photo, seller-stated identity, editable $148.50 price and the app's pricing wording. |
| `phone-dualsense-review.webp` | `final2-04-dualsense-review-1179x2556.png` | `6e74fc72dbdb2fa652f14c8e910573b8f7267d51` | Full DualSense hero photo, item identity and editable $149.99 price. |
| `phone-flips.webp` | `final2-07-flips-populated-1179x2556.png` | `6e74fc72dbdb2fa652f14c8e910573b8f7267d51` | Populated final-build Flips with the posted Jordan photo and October 1 date, without an unavailable tag. |

Raw sources remain in the phone worker's ignored
`ios/Artifacts/input-keyboard-followup/` folder. Per-source SHA-256 hashes and
framing receipts are checked into [frame-receipt.json](frame-receipt.json).

## Capture and evidence limits

These are iPhone Mirroring captures of the running app, not native
high-resolution screenshot attachments. The worker removed the Mac window by
cropping observed screen bounds: final2 captures 612 × 1332 at +16+76. The
final2 1179 × 2556 files are scaled exports of those Mirroring crops.
Original windows/crops are retained locally. The framing tool then preserves
screen proportions, rounds the aperture and adds the same illustrative device
body. No mouse cursor or Mirroring pointer is visible in the three selected
screens. No app UI,
item photos, prices, marketplace status or evidence was fabricated or painted in.

The phone worker's `final2-walk-099-101-verdicts.json` records the signed final
Release source and new AirPods/DualSense/Flips exports. It reports that the final
Jordan Flips tile opened the actual native eBay Active listing at $160 with one
available and zero sold. The screenshot used here shows the Flips tile; the
account-bearing eBay proof stays private. Neither Flips nor the live listing
means the item sold. Historical post-success and sharing screenshots are omitted
because they contain Mirroring pointers; their source artifacts remain local.
This README task did not operate the phone, publish a listing,
make a purchase or send an external share.

Pricing and identity wording are reproduced as displayed by the app; this
framing task did not independently verify each sold match or product identity.
These images do not establish an App Store release or live Apple purchase/restore.

## Privacy and image quality

Every selected full-resolution source and final framed output was visually
inspected for real rendered photos and public-safe content. No name, email,
account identifier, credential or notification is visible. The one-letter
profile avatar is retained. All private/account-background images are excluded,
including newer confirmation/paywall captures that expose the eBay account name.

To list is omitted: the newer ready-list rows have blank thumbnails even though
AirPods and DualSense photos render in review. Nike Dunk is excluded; Jordan 3
is the only shoe. Empty/black Flips captures, photo placeholders and diagnostic
screens are excluded. Every included draft has a real hero photo and price.
Prepared/shared export packs
remain distinct from eBay publish and sold status.

## Reproduce the framed images

See [the framing tool instructions](../../scripts/readme/README.md). Copy the
three selected raw files under their original filenames to ignored
`ios/Artifacts/readme-input/`, then run from the repository root:

```sh
python3 scripts/readme/frame-screens.py \
  --manifest scripts/readme/sources.json --output-dir docs/readme
```

The receipt records source, frame and output hashes, crop rectangles, encoder
version, sizes and dimensions. Raw sources and private test logs remain ignored.
The older `listing-review.png` and `trophy-wall.png` filenames remain only for
historical simulator evidence in the [developer guide](../developer-guide.md#screenshot-provenance).
Those fixture matches are not live sales research or current hero images.

## Cursor-free capture gate

Only the final2 AirPods Max, DualSense and populated Flips sources pass the
current cursor-free gate. Historical Jordan review, eBay post success, sharing
and paywall images were removed because they contain Mirroring pointers. They
may return only after clean recapture with the pointer outside the Mirroring
window, then full source/output privacy, photo and cursor inspection. The README
does not digitally erase pointers or fabricate replacement app content.

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
