# Marketing screen images: where they come from

`public/marketing/screens/*.webp` are the phone screens in the feature explorer, and
`public/marketing/hero/*.webp` are the layers of the scanning loop in the hero. They replaced the
drawn CSS phones in #859 / PR #860. This file records what each one shows, how it was produced, and
which claims in them are not real product output, so a later change does not have to re-derive any
of it from the binaries.

## What each file shows

| File | Section | Content |
| --- | --- | --- |
| `screens/scan.webp` | Scan | camera view framing an Air Jordan 3 |
| `screens/photo-review.webp` | Photo Review | three-photo strip for the same shoe, a Cover marker, an Add tile, and the voice note row in its empty state |
| `screens/listing-review.webp` | Listing Review | title, condition, price recommendation, sold matches |
| `screens/publish.webp` | Publish | assisted export and share, second-half publish screen |
| `screens/trophy-wall.webp` | Trophy Wall | chronological item states |

## How they are produced

The captures are not simulator screenshots. `scripts/shot-marketing.mjs` in
`~/Developer/snaplist-appstore` screenshots the same local HTML prototypes under `canvases/` that
the App Store panels come from, at a 4x device scale, and writes about 1560x3380 into
`captures/marketing/`. Each shot is then resized to 1240x2683 and encoded with `cwebp -q 80`.

There is no top crop, and that matters more than it sounds: 1240x2683 is 0.462, a real iPhone
screen, and the frames in `marketing.css` are built to that number so `object-fit: cover` has
nothing to trim.

Three of the five need the page put into a particular state first, and the script asserts each one
rather than trusting it. Publish clicks its first row. Trophy Wall substitutes a settled-wall state
string and throws if that string is not in the canvas. Listing review scrolls 38px so the sold-match
row ends on the screen edge instead of slicing the price, and throws if the scroll lands anywhere
else. Trophy Wall keeps its partial bottom row deliberately, because that reads as a grid that
continues and scrolling it would cut the top row instead.

**The App Store panel set is not touched.** `captures/appstore-sb/` stays exactly as approved. This
pipeline is marketing only.

Regenerating one means rerunning `scripts/shot-marketing.mjs`, redoing the resize, and replacing the
`.webp`. Do not retouch a `.webp` directly. The canvas is the source, and an edited derivative
silently diverges from the App Store set built from the same canvas.

### What this replaced, and why it looked wrong

The first version of these files was cropped 219px off the top and shipped at 620x1255. Both parts
were defects and they showed up together as "the phone got shrunk and the screenshots are cut off":

- The crop made the images 0.494 rather than 0.462, so they were squat. The drawn frames were then
  built to 0.494 to match, which is why the devices themselves looked wrong.
- 620px was under half the pixels a Retina screen asks for at the size these render, and the `sizes`
  hint said `288px` when the explorer screen actually renders at 327 to 357. Next served a 279px
  file into a 357px box. Every screen on the page was a blurry upscale.
- Two panels were captured mid-scroll, so their content really was cut. That is the only one of the
  three causes that needed a new capture.

## The hero scanning loop

`public/marketing/hero/` holds four kinds of file:

| File | What it is |
| --- | --- |
| `chrome.webp` | the shipping Scan screen with the viewfinder photo knocked out to transparency |
| `shutter.webp` | the shutter ring, cut out of that same capture so it can pulse on its own |
| `fender`, `nikedunk`, `rolex`, `sony`, `nintendo` `.webp` | the subjects the loop cycles through |

The chrome is derived, not drawn. The Scan canvas is captured twice, once normally and once with the
viewfinder photograph replaced by `#FF00FF`, and the alpha channel is a knockout of wherever the
second capture is magenta. So the flash button, framing corners, shutter, library button, tab bar
and status bar in the hero are the same pixels as the App Store panel. Nothing about the camera is a
drawing that could drift from the build, which is what keeps the hero inside Apple guideline 2.3.3.

That knockout also settled a question worth writing down: the viewfinder photograph is full bleed at
94% of the screen with no status-bar band above it. The white status text sits directly on the
subject, and the approved v4 Scan package says in as many words "No shelf, panel, scrim, grounding
gradient, or merged pill". So there is nothing to darken behind that text, and the only lever left
is which photograph goes in. Every loop subject is chosen with a dark top strip for that reason.
Two otherwise good candidates, a Polaroid on cyan and Ray-Bans on pale grey, were rejected on it.

The subjects are all recognisably branded, because a generic object does not read as something
somebody is reselling. They also have to survive a 0.462 crop, which rules out wide landscape
compositions: the crop takes a strip about a third of the width, and a subject spanning the frame
loses its logo to it.

Originals are in `~/Developer/snaplist-appstore/source/fx/hero/`, and
`scripts/hero-crop.mjs` in that repo carries the crop for each one:

| Item | zoom | fx | fy |
| --- | --- | --- | --- |
| `fender` | 0.85 | 0.55 | 0.55 |
| `nikedunk` | 1.00 | 0.50 | 0.55 |
| `rolex` | 0.90 | 0.50 | 0.48 |
| `sony` | 0.95 | 0.52 | 0.48 |
| `nintendo` | 0.85 | 0.49 | 0.58 |

Those numbers are not a recollection. Running the script reproduces all five shipped `.webp` files
to within 1.4 of 255 mean absolute channel difference, which is webp encoder noise. If a future
change to that script stops reproducing them, the script is what drifted.

The sweep line is the one element in the hero that is not app interface. It is a marketing device.
It belongs to this page and must not be carried into an App Store panel, where it would read as a
claim about a screen the app renders.

## Known honesty gap

`listing-review.webp` shows $118 with three sold matches between $104 and $135. Those numbers are
prototype fixture data, not a real pricing run, and they are on a public page. The correct fix is a
genuine run captured fresh, not an edited number in the image. Flagged in PR #860 and repeated here
so the next person to touch this directory sees it before they treat the figure as product truth.

The screens themselves depict shipping UI. Apple guideline 2.3.3 forbids showing interface the app
does not have, so any future screen added here has to come from a build that actually renders it.

Alt text is the accessible version of pixels, so it has to describe the image that ships rather than
the image somebody remembers. The Photo Review alt claimed a recorded twelve second voice note for a
while; the capture shows the empty voice note row.
