# Demo-video suite — integration guide

Seven Remotion-rendered clips, all **1920x1080 @ 30fps, h264, no audio track,
seamlessly looping** (the last frame crossfades into a frozen copy of frame 0,
so `loop` + `autoplay` + `muted` + `playsinline` is all a `<video>` needs).
Compositions live in `remotion/suite/`; ids match the table below.

Every product shown is from `src/lib/demo-products.ts` with its exact verified
title; the per-video allocation is recorded in `DEMO_SURFACE_ASSIGNMENTS`.
Cursor clicks are programmatically verified — `pnpm exec tsx
remotion/suite/assert-clicks.ts` asserts the cursor tip equals each click
target's center at the click frame, with a ≥12-frame dwell.

## The clips

| Composition id | File | Duration | Products (exact catalog slugs) | Suggested poster frame |
| --- | --- | --- | --- | --- |
| `hero-demo` | `public/hero-demo.mp4` | 49.0s (1470f) | `polaroid`, `gameboy`, `gshock` | **14.3s** (act-1 draft assembled) |
| `step-snap` | `public/demo/steps/snap.mp4` | 16.0s (480f) | `guitar` | **13.3s** (3 photos · ready) |
| `step-identify` | `public/demo/steps/identify.mp4` | 15.0s (450f) | `camera` | **14.0s** (details + 94% + plain summary) |
| `step-price` | `public/demo/steps/price.mp4` | 18.0s (540f) | `sneakers` | **16.6s** (price applied) |
| `step-write` | `public/demo/steps/write.mp4` | 18.7s (560f) | `mixer` | **9.3s** (eBay rendering complete) |
| `step-publish` | `public/demo/steps/publish.mp4` | 16.0s (480f) | `keyboard` | **13.3s** (live + confirmation card) |
| `buyer-qa` | `public/demo/buyer-qa.mp4` | 22.0s (660f) | `chess` | **18.0s** (approved reply sent) |

Poster extraction example:
`ffmpeg -ss 14.3 -i public/hero-demo.mp4 -frames:v 1 poster.jpg`

## What each clip shows

- **hero-demo** — photo-to-listing showcase, three acts. Photo arrives
  (act 1 is the only cursor act: a verified click on the dropzone), scan sweep
  + detection boxes land on the *actual printed text* in each photo
  (“Polaroid / Supercolor 645 CL”, “GAME BOY COLOR / Nintendo”,
  “CASIO / G-SHOCK”), the extracted details populate with per-field how-sure
  chips, then they assemble into a listing draft (title types itself, detail
  chips, streamed description). Pricing appears only as a one-chip coda.
  Ends on a three-draft end card that crossfades into the loop.
- **step-snap** — whole photo-adding flow: phone-frame capture (shutter →
  flash → photo flies into the rail), an OS drag-drop of a Finder-style file
  card onto the dropzone (press + release cursor-verified), and a “+ Add”
  click for a third angle. Ends “3 photos · ready to identify”.
- **step-identify** — photo scan → detection boxes on “Canon” / “EOS 80D” →
  six extracted details with how-sure chips → “how sure is the match” (94%)
  with named reasons → a plain-language item summary that types itself and
  stamps “every detail double-checked”. Cursor-free by design.
- **step-price** — price research visualized: two searches fire in the live
  feed, six recent-sale rows land with sources (eBay/Mercari/Poshmark/Depop —
  the lone *asking* price visibly counts less), dots scatter on a price axis,
  the $40–$58 band forms around the $48 suggestion, “why trust this price”
  fills to 84%, then a verified click applies the price.
- **step-write** — listing copy writes itself per marketplace: eBay
  (search-friendly title, item-details grid, streamed description), then
  verified tab clicks to Facebook Marketplace (casual/local, copy-paste note)
  and Mercari (short title, hashtag chips, shipping line). Ends
  “3 marketplaces ready”.
- **step-publish** — review screen: checklist ticks, amber autopilot gate
  (“only 74% sure, so it waits for your OK”), verified Publish click →
  posting state → green “Live on eBay” + confirmation card with listing id.
- **buyer-qa** — trust story (badged STEP 6 · ANSWER BUYERS — it is the sixth
  step of the how-it-works pipeline): buyer question lands in the inbox
  (verified row click), a reply drafts itself from the item's real details
  (chips: the item's details / your listing / condition · Fair), seller
  clicks into the draft (verified) and appends one edit, then a verified
  “Approve & send” click delivers the reply into the thread (“Sent to the
  buyer through eBay messages”).

## Set consistency

All clips share the same calm shell (white canvas, near-black `#1a1a1a` ink,
green `#008060` accent, `#f6f6f7` backdrop), the same top bar with a
step-identity badge (`STEP 1 · SNAP` … `STEP 6 · ANSWER BUYERS`), the same
live-progress feed, chip, how-sure and cursor primitives — they read as one
set in a carousel.

**Plain-language rule (ui-r6):** every word rendered inside a clip is seller
language. No tool-call tags, no JSON, no “comps”/“conf”/“schema”/“pipeline”/
“structured output”, no abbreviations (“6 days ago”, never “6d”). The
audience is a homeowner, not an engineer.

## Re-rendering

```sh
npx remotion render remotion/index.ts hero-demo      public/hero-demo.mp4           --crf 28 --muted
npx remotion render remotion/index.ts step-snap      public/demo/steps/snap.mp4     --crf 26 --muted
npx remotion render remotion/index.ts step-identify  public/demo/steps/identify.mp4 --crf 26 --muted
npx remotion render remotion/index.ts step-price     public/demo/steps/price.mp4    --crf 26 --muted
npx remotion render remotion/index.ts step-write     public/demo/steps/write.mp4    --crf 26 --muted
npx remotion render remotion/index.ts step-publish   public/demo/steps/publish.mp4  --crf 26 --muted
npx remotion render remotion/index.ts buyer-qa       public/demo/buyer-qa.mp4       --crf 26 --muted
```

### Dark variants (theme-aware videos)

Every suite clip also ships a dark render so the videos follow the app's
light/dark toggle (the app swaps `foo.mp4` ↔ `foo-dark.mp4` via
`useThemedVideoSrc`). The dark palette is injected by the Scene from the
`theme` input prop — see `suite/theme.ts` (`paletteVars`); light is the var
fallback, so the light renders above are unchanged. Re-render the dark set
with `--props '{"theme":"dark"}'` and the `-dark` filenames:

```sh
npx remotion render remotion/index.ts hero-demo      public/hero-demo-dark.mp4            --crf 28 --muted --props '{"theme":"dark"}'
npx remotion render remotion/index.ts step-snap      public/demo/steps/snap-dark.mp4     --crf 26 --muted --props '{"theme":"dark"}'
npx remotion render remotion/index.ts step-identify  public/demo/steps/identify-dark.mp4 --crf 26 --muted --props '{"theme":"dark"}'
npx remotion render remotion/index.ts step-price     public/demo/steps/price-dark.mp4    --crf 26 --muted --props '{"theme":"dark"}'
npx remotion render remotion/index.ts step-write     public/demo/steps/write-dark.mp4    --crf 26 --muted --props '{"theme":"dark"}'
npx remotion render remotion/index.ts step-publish   public/demo/steps/publish-dark.mp4  --crf 26 --muted --props '{"theme":"dark"}'
npx remotion render remotion/index.ts buyer-qa       public/demo/buyer-qa-dark.mp4       --crf 26 --muted --props '{"theme":"dark"}'
```

The hero's dark first-frame poster is a still:
`npx remotion still remotion/index.ts hero-demo public/hero-demo-poster-dark.jpg --frame 0 --props '{"theme":"dark"}'`.

`--muted` matters: the landing `<video>`s are muted anyway and a silent AAC
track inflates file size. After changing any choreography constants, run
`pnpm exec tsx remotion/suite/assert-clicks.ts` before re-rendering.

The legacy 1120x840 hero (`hero-demo-v3`) and 800x600 `stage-*` compositions
are still registered for reference; `public/stage-*.mp4` are superseded by
`public/demo/steps/*.mp4` once the how-it-works carousel is rewired.
