# README device framing

`frame-screens.py` uses ImageMagick 7 and Python 3's standard library. The frame
is an original repository-authored generic modern iPhone-style SVG, licensed
under this repository's Apache-2.0 license. It uses no Apple marketing artwork
or third-party mockup. It is a presentation enclosure, not a photo of hardware.

Every output is a transparent 480 × 996 WebP, with the same device geometry,
rounded screen aperture, bezel, side buttons and camera island. The image is
encoded at quality 88 with lossless alpha and must be smaller than 250,000 bytes.
The source status bar and app content remain intact. The camera island occupies
the hardware cutout area; no names, prices, item content or UI states are painted
into the screen.

```sh
brew install imagemagick
python3 scripts/readme/frame-screens.py screen.png phone.webp
python3 scripts/readme/frame-screens.py mirroring.png phone.webp \
  --crop 1179x2556+40+80
```

The example crop is syntax only: **measure each capture's actual screen bounds**.
Native 1179 × 2556 captures need no crop. Other bare captures with the same aspect
ratio (within 0.5%) are resized proportionally and centered with black padding
of at most a few pixels; screen content is never stretched or center-cropped. Desktop/Mirroring chrome must be removed by
an explicit crop; mismatched aspect ratios and out-of-bounds crops fail instead
of stretching or guessing. Do not include Mirroring hover controls or pointers
inside the chosen screen region. Use a settled capture with those absent.

For the accepted README set, place the five raw files in the ignored local
`ios/Artifacts/readme-input/` folder using the names in `sources.json`, then run:

```sh
python3 scripts/readme/frame-screens.py \
  --manifest scripts/readme/sources.json --output-dir docs/readme
```

`docs/readme/frame-receipt.json` records source/output SHA-256 hashes, exact
crops, frame hash, encoder version, dimensions and byte counts. Outputs are
repeatable with the same inputs and ImageMagick/libwebp versions; update the
receipt when source captures or the frame change. Raw captures remain ignored.
Capture provenance and privacy review belong in `docs/readme/README.md`.

Before publishing, inspect every full-resolution source and framed output for
names, emails, account identifiers, notifications, desktop chrome and empty or
unfinished UI. Check actual item content, price-evidence wording and honest
prepared/shared labels. Framing alone cannot fix missing content or prove sold
matches, a marketplace publish, or a subscription purchase.
