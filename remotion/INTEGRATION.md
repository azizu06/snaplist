# Real-UI demo media

The marketing tour and the in-app inbox teaser use captures of the shipped
SnapList components, not a separately drawn demo interface. Deterministic
fixtures live under `src/app/(app)/dev/preview`; the capture boundary only adds
theme, focus, and mobile-state controls for the media pipeline.

## Pipeline

1. `pnpm demo:capture-ui` starts the local app and captures 36 PNGs under
   `public/demo/captures/{desktop,mobile}/{light,dark}`.
2. The capture harness uses Chrome device-metric overrides so the mobile CSS
   viewport is exactly 432×540 while the output is 1080×1350. Mobile inbox
   captures fail if the document, any conversation row, or the simulator
   control exceeds the viewport.
3. `pnpm demo:render-real-ui -- stills` renders review stills into the ignored
   `.review-shots/real-ui-media` directory.
4. `pnpm demo:render-real-ui` writes the light/dark MP4 files consumed by the
   app. All clips are six-second, muted, loop-safe H.264 renders.

No credentials or production APIs are needed. Use the authenticated
dev-preview fixtures if the real auth stack is unavailable.

## Capture states

| Capture | Real view/state |
| --- | --- |
| `upload` | Current upload view |
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

## Outputs

Desktop tour clips:

- `public/demo/steps/{snap,identify,price,write,publish}.mp4`
- `public/demo/buyer-qa.mp4`
- `public/demo/inbox-qa.mp4`

Portrait mobile clips:

- `public/demo/steps/{snap,identify,price,write,publish}-mobile.mp4`
- `public/demo/buyer-qa-mobile.mp4`
- `public/demo/inbox-qa-mobile.mp4`

Every path also has a `-dark.mp4` sibling. `SeamlessThemeVideo` swaps the
correct theme and mobile source. Its loading, failure, and reduced-motion
fallback is a responsive still from the same capture set, so those paths also
show the real SnapList UI.

`hero-demo` remains the existing vision showcase and is outside the issue #95
tour/inbox replacement. Legacy Remotion compositions remain registered for
reference but are not written by `demo:render-real-ui`.

## Validation

Run the focused capture/catalog tests before rendering:

```sh
pnpm vitest run src/lib/demo-capture-qa.test.ts \
  'src/app/(app)/inbox/conversation-list-layout.test.ts' \
  src/lib/demo-products.test.ts
```

For a single capture while debugging, set
`DEMO_CAPTURE_ONLY=mobile/dark/inbox-list`. A full capture run is still required
before final rendering.
