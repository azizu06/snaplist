# Marketing screen images: where they come from

`public/marketing/screens/*.webp` are the phone screens on the marketing page. They replaced the
drawn CSS phones in #859 / PR #860. This file records what each one shows, how it was produced, and
which claims in them are not real product output, so a later change does not have to re-derive any
of it from the binaries.

## What each file shows

| File | Section | Content |
| --- | --- | --- |
| `scan.webp` | hero and Scan | camera view framing an Air Jordan 3 |
| `photo-review.webp` | Photo Review | three-photo strip for a graded Charizard card, with the optional voice note row |
| `listing-review.webp` | Listing Review | title, condition, price recommendation, sold matches |
| `publish.webp` | Publish | assisted export and share, second-half publish screen |
| `trophy-wall.webp` | Trophy Wall | chronological item states |

Photo Review is deliberately the Charizard set rather than the shoe, because that set is the one
carrying the voice note popup the section describes. Photo three in that set is a photograph of a
real card back, not a composite of the front.

## How they are produced

The captures are not simulator screenshots. They come from the App Store panel pipeline at
`~/Developer/snaplist-appstore/rebuild.sh`, which screenshots the local HTML prototypes under
`canvases/` and writes 1560x3376 panels into `captures/appstore-sb/`.

Each marketing shot is then derived from its panel:

1. crop 219px off the top, which is 6.48% of 3376 and removes the panel's headline band
2. resize to 620x1255 (`scan.webp` lands at 620x1256 from rounding)
3. `cwebp -q 82`

Regenerating one means rerunning `rebuild.sh`, redoing that crop and resize, and replacing the
`.webp`. Do not retouch a `.webp` directly. The panel is the source, and an edited derivative
silently diverges from the App Store submission set built from the same panel.

## Known honesty gap

`listing-review.webp` shows $118 with three sold matches between $104 and $135. Those numbers are
prototype fixture data, not a real pricing run, and they are on a public page. The correct fix is a
genuine run captured fresh, not an edited number in the image. Flagged in PR #860 and repeated here
so the next person to touch this directory sees it before they treat the figure as product truth.

The screens themselves depict shipping UI. Apple guideline 2.3.3 forbids showing interface the app
does not have, so any future screen added here has to come from a build that actually renders it.
