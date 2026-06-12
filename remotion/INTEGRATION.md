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
| `step-identify` | `public/demo/steps/identify.mp4` | 15.0s (450f) | `camera` | **14.0s** (attributes + 94% + schema-valid) |
| `step-price` | `public/demo/steps/price.mp4` | 18.0s (540f) | `sneakers` | **16.6s** (price applied) |
| `step-write` | `public/demo/steps/write.mp4` | 18.7s (560f) | `mixer` | **9.3s** (eBay rendering complete) |
| `step-publish` | `public/demo/steps/publish.mp4` | 16.0s (480f) | `keyboard` | **13.3s** (live + confirmation card) |
| `buyer-qa` | `public/demo/buyer-qa.mp4` | 22.0s (660f) | `chess` | **18.0s** (approved reply sent) |

Poster extraction example:
`ffmpeg -ss 14.3 -i public/hero-demo.mp4 -frames:v 1 poster.jpg`

## What each clip shows

- **hero-demo** — pure vision-model showcase, three acts. Photo arrives
  (act 1 is the only cursor act: a verified click on the dropzone), scan sweep
  + OCR boxes land on the *actual printed text* in each photo (“Polaroid /
  Supercolor 645 CL”, “GAME BOY COLOR / Nintendo”, “CASIO / G-SHOCK”),
  structured attributes populate with per-field confidence chips, then the
  attributes assemble into a listing draft (title types itself, specifics
  chips, streamed description). Pricing appears only as a one-chip coda.
  Ends on a three-draft end card that crossfades into the loop.
- **step-snap** — whole photo-adding flow: phone-frame capture (shutter →
  flash → photo flies into the rail), an OS drag-drop of a Finder-style file
  card onto the dropzone (press + release cursor-verified), and a “+ Add”
  click for a third angle. Ends “3 photos · ready to identify”.
- **step-identify** — vision scan → OCR boxes on “Canon” / “EOS 80D” →
  six structured attributes with confidence chips → ID-confidence composite
  (94%) with named signals → dark structured-output panel that types the JSON
  and stamps “schema valid”. Cursor-free by design.
- **step-price** — comp search visualized: two queries fire in the agent feed,
  six comp rows land with sources (eBay/Mercari/Poshmark/Depop — the lone
  *asking* price visibly down-weighted), dots scatter on a price axis, the
  $40–$58 band forms around the $48 suggestion, confidence composes from
  named signals to 84%, then a verified click applies the price.
- **step-write** — listing copy writes itself per platform: eBay (keyword
  title, item-specifics grid, streamed description), then verified tab clicks
  to Facebook Marketplace (casual/local, copy-paste export note) and Mercari
  (short title, hashtag chips, shipping line). Ends “3 platforms ready”.
- **step-publish** — review screen: checklist ticks, amber autopilot gate
  (“74% < 85% threshold — your review required”), verified Publish click →
  posting state → green “Live on eBay” + confirmation card with listing id.
- **buyer-qa** — trust story: buyer question lands in the inbox (verified row
  click), the agent streams a grounded draft (grounding chips: attributes /
  listing copy / condition · Fair), seller clicks into the draft (verified)
  and appends one edit, then a verified “Approve & send” click delivers the
  reply into the thread (“Sent to buyer via eBay messages”).

## Set consistency

All clips share the same Prism-style shell (white canvas, navy `#131e3a` ink,
violet `#635bff` accent, `#f4f6fb` backdrop), the same top bar with a
step-identity badge (`STEP 1 · SNAP` … `BUYER Q&A`), the same agent-feed,
chip, confidence and cursor primitives — they read as one set in a carousel.

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

`--muted` matters: the landing `<video>`s are muted anyway and a silent AAC
track inflates file size. After changing any choreography constants, run
`pnpm exec tsx remotion/suite/assert-clicks.ts` before re-rendering.

The legacy 1120x840 hero (`hero-demo-v3`) and 800x600 `stage-*` compositions
are still registered for reference; `public/stage-*.mp4` are superseded by
`public/demo/steps/*.mp4` once the how-it-works carousel is rewired.
