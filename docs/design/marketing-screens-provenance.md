# Marketing screen images: where they come from

`public/marketing/screens/*.webp` are the phone screens in the feature explorer, and
`public/marketing/hero/*.webp` are the layers of the scanning loop in the hero. They replaced the
drawn CSS phones in #859 / PR #860. This file records what each one shows, how it was produced, and
which claims in them are not real product output, so a later change does not have to re-derive any
of it from the binaries.

## What each file shows

| File | Section | Content |
| --- | --- | --- |
| `screens/scan.webp` | Scan | camera view framing Aziz's Air Jordan 3 on its box, with the framing brackets removed. Why they are removed is in "Whose shoes these are" below |
| `screens/photo-review.webp` | Photo Review | four-photo strip of Aziz's Air Jordan 3, one frame per source photograph, a Cover marker, an Add tile, and the voice note row in its empty state |
| `screens/listing-review.webp` | Listing Review | the same four photos, the item identified as an Air Jordan 3 Retro in summit white, the price recommendation, and three item-only Air Jordan 3 sold matches |
| `screens/publish.webp` | Publish | assisted export and share for the same item, second-half publish screen |
| `screens/trophy-wall.webp` | Trophy Wall | chronological item states, with Aziz's Air Jordan 3 leading the wall |

All five are one item carried end to end. That is deliberate: the explorer's tabs are pipeline
stages, so a visitor clicking through is being shown one thing moving, and unrelated items on each
tab would undercut the claim the section is making. Trophy Wall is legitimately several items,
because it is a wall of everything the seller has run, and his Air Jordan 3 leads it.

## How they are produced

The captures are not simulator screenshots. `scripts/shot-marketing.mjs` in
`~/Developer/snaplist-appstore` screenshots the same local HTML prototypes under `canvases/` that
the App Store panels come from, at a 4x device scale, and writes about 1560x3380 into
`captures/marketing/`. Each shot is then resized to 1240x2683 and encoded with `cwebp -q 80`.

There is no top crop, and that matters more than it sounds: 1240x2683 is 0.462, a real iPhone
screen, and the frames in `marketing.css` are built to that number so `object-fit: cover` has
nothing to trim.

All five have the OS status bar and, where the canvas draws one, the Dynamic Island removed before
capture. Aziz asked for this after putting the page next to Cal AI, whose device render carries
neither: "use that extra space instead of the dynamic notch for room." Scan gained the most, because
its status bar was white text sitting on a white wall and its island was a black pill over the
viewfinder; both are simply gone now rather than faint. The removal is structural rather than another
`data-dc-tpl` list, because only `scanfix` is plain markup and the other four build their phones from
templates where the row has no stable attribute until the board renders. It runs against the
already-resolved live screen and throws if it cannot find a status bar, so a silent miss cannot ship
a screen that disagrees with the other four.

The row is hidden with `visibility`, not `display`, and that word is the whole of a second
correction. Three of the five canvases build the row as a static element in normal flow, so
`display: none` deleted its 54px of layout along with its glyphs and every header below it slid up
flush against the glass. Aziz, looking at all five at once: "it's way too close to the top edge where
the headline and stuff is in the trophy wall headline and then the profile ... moving it down a bit
so there's breathing room." Keeping the box and suppressing only the paint returns each screen to the
safe-area geometry it was actually laid out against, rather than inventing a new inset. On `scanfix`
and `aefix`, whose rows are absolutely positioned, it is a no-op, which is correct: they never spent
the space to begin with, and re-encoding proved it, with those two coming out byte-identical while
the other three changed.

Three of the five need the page put into a particular state first, and the script asserts each one
rather than trusting it. Publish clicks its first row. Trophy Wall substitutes a settled-wall state
string and throws if that string is not in the canvas. Listing review scrolls 38px so the sold-match
row ends on the screen edge instead of slicing the price, and throws if the scroll lands anywhere
else. Trophy Wall drops its fourth tile row entirely, which reverses an earlier decision recorded
here.

That earlier reasoning was that a partial bottom row reads as a grid that continues, and that
scrolling to hide it would only slice the top row and the header instead. Both halves are true in
the app. Neither survives the marketing page, because the phone renders at roughly a third of life
size and the wall is a fixed 390x844 capture scaled down with it. The fourth row began at y=808 in
an 844-tall screen, so 35px of a 216px row showed, with the floating dock sitting over the sliver.
At full size that is a grid that continues; at 370px wide it is a row of clipped thumbnails against
the bottom bezel, which is what Aziz saw: "the trophy wall, the edges are cut off ... it's not
aligned correctly."

Scrolling could not fix it, since four rows of 228 against a 732 viewport always cut something.
Growing the phone could not either, because the capture is a fixed screen that scales
proportionally and takes the sliver with it. So `TRIM_ROW` removes the last row at capture time and
asserts its way there: eight tiles, four distinct row tops, exactly two hidden, and the remaining
grid must end above the screen edge or it throws. The last surviving row ends at 797 of 844 and
leaves clearance under it for the dock. Three complete rows ship. The horizontal gutters were never the problem and measure
symmetric at 16px in the canvas and 13 to 14px in the rendered frame.

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
second capture is magenta. So the flash button, framing corners, shutter, library button and tab bar
in the hero are the same pixels as the App Store panel. Nothing about the camera is a drawing that
could drift from the build, which is what keeps the hero inside Apple guideline 2.3.3.

The hero carried the OS status bar and the Dynamic Island for a while after the five explorer screens
had both stripped, so the page showed one phone with an island and five without. Aziz: "we need to
keep it uniform so just remove the notch from both or keep the notch on both." He chose removing.
`scripts/hero-chrome.mjs` owns that cut. It clears everything above row 176 of the 1240-wide capture
and asserts the layer's own alpha profile first, because the status band ends at 149 and the flash
button begins at 203, and a canvas change that moved the button up into that gap would otherwise
clip it off the hero silently.

Two things about that script are worth knowing before touching it. It operates on the captured PNG
rather than re-deriving the knockout, because the knockout was run as a one-off and left no script
on disk, only `tmp/scan-chrome-noshutter-1240.png`. Re-deriving it would mean guessing at a pipeline
nobody wrote down. And the gap assertion has already paid for itself: the profile was first read
every tenth row, which put the flash button at 210, and the assertion caught the 276 antialiased
pixels between 203 and 209 that the sampling had stepped over.

The knockout also settled a question worth writing down: the viewfinder photograph is full bleed at
94% of the screen with no status-bar band above it, and the approved v4 Scan package says in as many
words "No shelf, panel, scrim, grounding gradient, or merged pill". So there is nothing to darken
behind white chrome, and the only lever is which photograph goes in. Removing the status bar took the
worst of that away, since the white 9:41 and the status icons were the smallest, faintest marks on
the brightest part of the frame. The flash glyph and the framing corners are still white and still
sit on the top strip, so subjects are still chosen with a dark top. Two otherwise good candidates,
a Polaroid on cyan and Ray-Bans on pale grey, were rejected on it.

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

## Whose shoes these are

The fixture item used to be a licensed studio photograph of an Air Jordan 1 Low on a dark seamless,
cropped five ways. Aziz photographed his own pair on an iPhone 16 Pro, so Scan, Photo Review,
Listing Review, Publish and the Trophy Wall tile now show his Air Jordan 3 Retro, Summit White /
Fire Red / Black, US 10, style DN3707-100, on its box. Every one of those facts is legible on the box label in
`IMG_9832`, so the listing copy in the canvases is describable from the photographs rather than
recalled.

Sources live in `snaplist-appstore/source/fx/aziz/`. `scripts/aziz-jordan-crops.mjs` in that repo
holds the crop rects and regenerates every derived file. Three traps are recorded there.

All four originals carry EXIF orientation 6 and must be `.rotate()`d before any extract.

Listing Review paints its photos into a band about 1.5:1, so its files are cut to that aspect rather
than square. A square pair shot survived `cover` in that band as two toe boxes with the Jumpman
sliced off the top.

**One frame per source photograph.** There are four originals and the strip shows four frames, so
each frame comes from a different one. An earlier pass cut both the pair shot and a tongue close-up
out of `IMG_9832`; the strip then put two frontal white-shoe thumbnails next to each other and read
as the same photo twice, which Aziz caught. `IMG_9829` is a second lateral view, so a whole-shoe cut
from it lands almost on top of the `IMG_9831` profile. It earns its slot as the close detail
instead, the elephant print over the black midsole. A fifth frame means finding a fifth angle in the
sources, not cutting one of the four twice.

Photo Review and Listing Review carry the same four frames in the same order, and the Publish export
pack says four photos, so the photo count does not change as the item moves down the pipeline.

### Scan, and why its framing brackets are gone

Scan paints a white 9:41, a white flash glyph, white framing brackets and a white shutter ring
directly onto the viewfinder image, and the approved v4 Scan package bans a shelf, panel, scrim, or
grounding gradient, so the photograph is the only thing holding that chrome up. The licensed studio
plate it used to carry measured a mean luminance of 19 top to bottom. Aziz's photographs are
near-white at the top and near-black at the bottom: on the full-height crop the status band measures
218, the bracket band 220, and the bottom 500px under the shutter and dock measure 28.

So the bottom half carries white chrome and the top half does not, and the brackets straddle both.
Aziz's call, made after seeing those numbers: **drop the brackets and use his shoes.** The controls
that have to read are the shutter, the dock and the library button, and all three sit on the dark
half. The 9:41 and the status icons stay white on a light wall and are faint. That is a known cost,
taken deliberately, not an oversight.

Two things were checked before accepting it. A tighter crop does reach a dark top, 72 at `IMG_9830`
cy 0.70 w 0.26, but at that zoom the frame is mostly black box with a sliver of midsole, and a
camera pointed at nothing recognisable is worse than a faint status bar. Nothing was painted into
the plate to fix the contrast, because a burned-in gradient would depict a screen the app does not
render, which is the class of problem guideline 2.3.3 covers.

**The bracket removal is a capture-time override, not a canvas edit.** It lives in
`scripts/shot-marketing.mjs` as a style injected into the served copy, scoped to `data-dc-tpl` 22
through 25, which is the live phone. The canvas on disk still carries the approved v4.1.5 geometry
and still points at the licensed plate, so the App Store panel set built from that same file is
unaffected, and so are the twelve static geometry renderings, which use `data-dc-tpl` 338 through
341. Rerunning `scripts/aziz-jordan-crops.mjs` regenerates `scan-aziz-pair.png` beside the licensed
plate rather than over it.

The hero keeps its framing brackets, and that is correct rather than inconsistent. Every hero
subject is chosen with a dark top strip, so the brackets have something to read against there.

The sold matches beside the price used to be Air Jordan 1 photographs, correctly titled as Air
Jordan 1s. They are other sellers' listings, so they are supposed to be other photographs, but a set
of Air Jordan 1 comps sitting under the heading "Verified sold matches" on an Air Jordan 3 is a
wrong match set. They are now five genuine Air Jordan 3 photographs, cut by
`scripts/comp-jordan3-crops.mjs` from `source/fx/comp3/` at 4:3, which is the aspect the rail card
paints.

Two of those five contain a person: `comp-02` is the shoe worn with jeans and `comp-04` is a hand
holding one. The screen shows the first three, so the worn pair sat directly under the words
"Verified sold matches", which is the wrong thing for that heading to be pointing at. Aziz: "I think
it is better to put verified sold matches as the item itself, not someone wearing them." Unsplash
has exactly three Air Jordan 3 photographs in total and two of them are already in this set, so
there was no replacement to license. `comp-02` and `comp-05` are swapped at capture time instead,
which puts the tagged pair, the pair on its box and the pair on the blanket on screen and drops both
photographs with people in them to positions four and five. Each entry keeps its own price, date,
condition and size, so no figure is attached to the wrong photograph, and the range line reads the
shown three so it moved from $104-$135 to $98-$135 by itself. The order is not chronological either
way, because the rail is ranked by match quality rather than by sale date.

The source is Unsplash, the same place the Air Jordan 1 set came from. The Unsplash License permits
commercial use with no permission and no attribution required; the photographers are Jay Nuetey,
Taru Goyal, Daniel Cheney, Joel Muniz and Sysoda Chau, credited here anyway. Adobe Stock was checked
and rejected: branded resale photography there is editorial-use-only, which excludes App Store and
marketing use.

Always render a candidate before trusting its identification. One Unsplash photograph read as an Air
Jordan 3 in a square-cropped contact sheet and showed its Air Jordan 4 wing panel once the sheet
preserved the original aspect. Contact sheets that crop are not evidence of what a photograph shows.

### The identity line, and why the shot does not open on the corrected state

The Listing Review canvas starts on a deliberately weak identity, "Casual Sneaker · Mid top", and
keeps the good one, "Air Jordan 3 Retro · Summit white", behind the guided correction. That is right
for the package, whose job on that screen is to demonstrate the correction, and it needs something
wrong for the seller to fix. It is wrong for a marketing shot, where it read as the product failing
to recognise a shoe whose full name was already printed in the title directly above it. Aziz caught
it: "the title of the item is the actual thing ... but in the listing review, you just have casual
sneaker mid top."

The capture now opens on the identity the canvas itself calls correct. Only that one string moves.
Price, range, confidence and the sold matches are untouched, because they are keyed to the comps on
screen rather than to this line, and the canvas keeps both states so the correction flow still has
something to correct.

## The device frame

The frame is a drawing in `marketing.css`, and until Aziz put the page beside Cal AI it was a flat
10px slab of `--ink` with a 46px radius, which reads as a rounded rectangle. Their phone is one
`analyzed.webp`, a 1275 x 2600 alpha-cut render whose body measures 1253 x 2599. Three ratios were
taken off it and every number in the frame rules is derived from them:

| Measured | Of body width | At our 288px design width |
| --- | --- | --- |
| frame thickness | 3.83% | 11px, split 3 rail and 8 bezel |
| corner radius | 16.8% | 48px, screen radius 37 |
| button protrusion | 0.7% | 2px |

The part that matters is that the frame is **two tones**, not one: light titanium rail on the
outside, near-black bezel inside it. A single dark band stays flat at any thickness, because a real
phone edge catches light on its rail and goes black at the glass. It costs no extra element: the
bezel is an inset `box-shadow` and the rail is the gradient underneath it.

The explorer device writes those ratios as pixels because it is transform-scaled, so one set of
numbers survives every breakpoint. The hero frame computes them from its own width instead, because
it is `min(400px, 86vw)` and genuinely shrinks: fixed padding and a fixed radius would be 4.7% and
20.8% of a 322px body, giving the phone a chunky edge and over-round corners exactly where the
screen is smallest.

The three side buttons are what stop it reading as CSS. Two are pseudo-elements on the device and
the third is a single `span`, and their offsets are percentages of frame height so they survive the
`--phone-scale` steps and the hero's larger frame without being restated.

Neither frame draws a notch or an island. That matches Cal AI and is also forced: the shots carry
the app's own chrome, so anything drawn over them lands on app content. It sat on the Trophy Wall
title once.

Their phone renders at 300px wide, 350 at their large breakpoint. Ours renders 370 to 392. Close
enough to Aziz's "approximately the same size", and the explorer device is deliberately the smaller
of our two so the hero stays the lead visual.

The explorer device grew once, from 340 to 392 across its steps. Aziz read the Trophy Wall screen as
cramped, and it was the worst case of the five: a two-column grid of tiles inside a 314px screen. The
hero at 400 is the ceiling, because he had already chosen for it to lead, so the widest step is 392
rather than a proportional bump and the desktop gain is small. The steps were measured against the
live page at each width that responds to them, checking that nothing overflows and that the card
column beside the phone is not squeezed; it held 540px until the phone reached 384. Below about 410
the frame is a flex item narrower than its declared width and shrinks to the column instead, so the
last two steps were left alone rather than raised into no effect. The card stack takes its height
from the row and its width from `--phone-w` once stacked, so it grew with the phone on its own.

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
