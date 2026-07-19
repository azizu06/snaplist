# Real-UI demo media

The marketing tour and the in-app inbox teaser use captures of the shipped
SnapList components, not a separately drawn demo interface. Deterministic
fixtures live under `src/app/(app)/dev/preview`; the capture boundary only adds
theme, focus, and mobile-state controls for the media pipeline.

## Pipeline

1. `pnpm demo:capture-ui` starts the local app and captures 40 PNGs under
   `public/demo/captures/{desktop,mobile}/{light,dark}`. Jobs run serially by
   default so development-only keyless bootstrap redirects cannot race; set
   `DEMO_CAPTURE_CONCURRENCY` only for an already-stable external preview host.
2. The capture harness resolves Chrome/Chromium from `CHROME_PATH`, standard
   macOS application paths, or `PATH`, then uses exact 1440×900 desktop and
   390×844 mobile CSS viewports. Captures fail on horizontal overflow, missing
   or collapsed focus targets, offscreen actions, or a requested theme that did
   not actually mount. Mobile inbox captures also verify every conversation row
   and simulator control remains inside the viewport.
3. `pnpm demo:render-real-ui -- stills` renders review stills into the ignored
   `.review-shots/real-ui-media` directory.
4. `pnpm demo:render-real-ui` writes the light/dark MP4 files consumed by the
   app. All clips are six-second, muted, loop-safe H.264 renders.

No credentials or production APIs are needed. Use the authenticated
dev-preview fixtures if the real auth stack is unavailable.

## Capture states

| Capture | Real view/state |
| --- | --- |
| `upload-empty` | Current empty upload view |
| `upload-filled` | Current upload view after the licensed local PlayStation 5 photo is assigned to the real file input and its change event is handled |
| `review-identify` | Current listing review and item identification |
| `review-price` | Current price and confidence card with cited sources |
| `review-write` | Current editable title and description fields |
| `publish-draft` | Current publish review before posting |
| `publish-live` | Current live-on-eBay confirmation state |
| `inbox-list` | Current buyer conversation list |
| `inbox-draft` | Current drafted-reply approval state |
| `inbox-sent` | Current sent buyer thread |

Each state is captured in desktop/mobile and light/dark variants. The Remotion
layer in `remotion/real-ui/RealUiCapture.tsx` only applies a subtle loop-safe
push-in and crossfades between real states; it does not redraw controls or add
fabricated product behavior.

The PlayStation 5 anchor and the supporting reseller catalog are locally hosted.
Their source, author, license, and crop records are in
[`docs/demo-asset-provenance.md`](../docs/demo-asset-provenance.md).

## Outputs

Desktop tour clips:

- `public/demo/steps/{snap,identify,price,write,publish}.mp4`
- `public/demo/buyer-qa.mp4`
- `public/demo/inbox-qa.mp4`

Action-cropped mobile clips (6:5, 1080×900):

- `public/demo/steps/{snap,identify,price,write,publish}-mobile.mp4`
- `public/demo/buyer-qa-mobile.mp4`
- `public/demo/inbox-qa-mobile.mp4`

Every path also has a `-dark.mp4` sibling. Desktop outputs are 16:9 at
1920×1080. `SeamlessThemeVideo` swaps the
correct theme and mobile source. Its loading, failure, and reduced-motion
fallback is a responsive still from the same capture set, so those paths also
show the real SnapList UI.

Only the real-UI compositions used by `demo:render-real-ui` remain registered.
Superseded handcrafted showcase and stage compositions are intentionally not
kept as reference code because their rendered outputs are not consumed by the
application.

## Validation

Run the focused capture/catalog tests before rendering:

```sh
pnpm vitest run src/lib/demo-capture-qa.test.ts \
  'src/app/(app)/inbox/conversation-list-layout.test.ts' \
  src/lib/demo-products.test.ts
```

For a single capture while debugging, set
`DEMO_CAPTURE_ONLY=mobile/dark/inbox-list`. A full capture run is still required
before final rendering. When a composition-only change follows a verified full
render, `DEMO_RENDER_ONLY=buyer-qa,buyer-qa-mobile pnpm demo:render-real-ui`
regenerates just those light/dark outputs.
