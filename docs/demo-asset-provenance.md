# Demo asset provenance

Issue #136 replaces SnapList's primary marketing and real-app capture inventory
with a locally hosted reseller-first set. Every selected source below is a
regular (non-Unsplash+) photograph whose source page states **Free to use under
the Unsplash License**. The project does not fetch these assets from Unsplash at
runtime.

- License: [Unsplash License](https://unsplash.com/license)
- Local transform: downloaded at a source-provided high resolution, auto-oriented,
  converted to sRGB, center-cropped to 1600×1600, metadata stripped, and encoded
  as WebP at quality 82.
- Attribution is not required by the license, but author and source links are
  retained here so the public demo has an auditable record.
- Titles and catalog attributes are limited to what the source page and image
  visibly support. Prices are clearly demo used-market asking prices, not claims
  about the photographed unit's actual sale history.

## Selected primary set

| Local asset | Catalog story | Source and author | Downloaded | License / attribution |
| --- | --- | --- | --- | --- |
| `public/demo/reseller/ps5.webp` | Sony PlayStation 5 console with DualSense controller | [Photo](https://unsplash.com/photos/a-playstation-5-console-with-its-controller--8xeF0LeUtI) by User_Pascal | 5855×3903 JPEG | Unsplash License; credit: User_Pascal / Unsplash |
| `public/demo/reseller/dualsense.webp` | Sony PlayStation 5 DualSense wireless controller | [Photo](https://unsplash.com/photos/playstation-5-dualsense-controller-on-a-red-surface-yc5Z3xNlyUw) by User_Pascal | 5871×3914 JPEG | Unsplash License; credit: User_Pascal / Unsplash |
| `public/demo/reseller/camera.webp` | Sony mirrorless camera body with three lenses | [Photo](https://unsplash.com/photos/flat-lay-photography-of-black-sony-dslr-camera-on-black-surface-IVaKksEZmZA) by Conor Luddy | 2400×3001 JPEG | Unsplash License; credit: Conor Luddy / Unsplash |
| `public/demo/reseller/iphone-15.webp` | Apple iPhone 15, blue | [Photo](https://unsplash.com/photos/an-iphone-rests-under-sunlight-its-camera-visible-vGYC2m8BlH8) by Jeri van der Mooren | 2400×1804 JPEG | Unsplash License; credit: Jeri van der Mooren / Unsplash |
| `public/demo/reseller/airpods-max.webp` | Apple AirPods Max, space gray | [Photo](https://unsplash.com/photos/a-pair-of-headphones--lnvREpbLu0) by Jason Zhang | 2400×1350 JPEG | Unsplash License; credit: Jason Zhang / Unsplash |
| `public/demo/reseller/keychron.webp` | Keychron mechanical keyboard, black and orange | [Photo](https://unsplash.com/photos/black-and-orange-computer-keyboard-KYw1eUx1J7Y) by Stefen Tan | 2400×2401 JPEG | Unsplash License; credit: Stefen Tan / Unsplash |
| `public/demo/reseller/charizard.webp` | Holographic Charizard Pokémon trading card | [Photo](https://unsplash.com/photos/pokemon-trading-card-on-gray-textile-OB756zZDYi0) by Steven Cordes | 5504×8256 JPEG | Unsplash License; credit: Steven Cordes / Unsplash |
| `public/demo/reseller/air-jordan-pair.webp` | White Air Jordan sneakers, pair | [Photo](https://unsplash.com/photos/cB5a5WJU_Oc) by Fujiphilm | 2400×3198 JPEG | Unsplash License; credit: Fujiphilm / Unsplash |
| `public/demo/reseller/switch-2.webp` | Nintendo Switch 2 handheld console | [Photo](https://unsplash.com/photos/a-nintendo-switch-sits-ready-for-gameplay-W7bGIDR1f6s) by Petar | 6000×4000 JPEG | Unsplash License; credit: Petar / Unsplash |
| `public/demo/reseller/galaxy-watches.webp` | Samsung Galaxy Watch Ultra and Watch 7 pair | [Photo](https://unsplash.com/photos/a-person-holding-a-smart-watch-in-their-hands-FVnt2Djs8_E) by Daniel Romero | 4444×2500 JPEG | Unsplash License; credit: Daniel Romero / Unsplash |

## Selection audit

The selected files were inspected as 184×184 mobile cards and 300×300 desktop
cards, then checked again inside the actual landing and Guide layouts. They were
chosen because the product remains identifiable in both crops, the original has
enough resolution for the 1440px landing page, and the set tells one coherent
shippable electronics / gaming / collectibles / streetwear resale story.

The following previous high-salience assets were retired from the runtime demo
catalog and removed in issue #248. Four benchmark-only images remain outside
the runtime catalog because native pricing tests reference them directly:

- `public/demo/book.jpg`
- `public/demo/camera.jpg`
- `public/demo/headphones.jpg`
- `public/demo/macbook.jpg`

An additional candidate, `NCMSwdnje0Y` by The Drink Break, was downloaded and
inspected but rejected: its dark close-up reads as a generic filter at small card
sizes and is not strong enough to support a premium lens listing. It is not
stored in the repository.

The portrait PS5 candidate `ads33nL7V4k` by Nik was also rendered through the
real 390px upload/review UI before rejection. Its centered square crop showed a
large blank console panel and clipped the controller, so the selected
`-8xeF0LeUtI` frame communicates the complete console/controller bundle more
clearly in the product's actual media component.

The generated review artifact listed in the #136 PR includes side-by-side
old/local-candidate and selected-final contact sheets plus this provenance table.

## Marketplace destination marks (issue #898)

The Share to other marketplaces screen (`AssistedExportView.swift`) identifies
Facebook Marketplace, Mercari, and Depop by their own marks instead of a generic
placeholder glyph plus black text. Facebook, Mercari, and Depop are trademarks of
Meta Platforms, Inc., Mercari, Inc., and Depop Ltd. respectively. Displaying a
destination's own mark to tell a seller which third-party app SnapList prepared
their listing for is nominative fair use: it identifies the destination, not an
endorsement or affiliation claim, and SnapList does not modify the marks beyond
format conversion and resizing.

| Local asset | Destination row | Source | License / rationale |
| --- | --- | --- | --- |
| `Assets.xcassets/MarketplaceMarkFacebook.imageset/facebook-marketplace.png` | Facebook Marketplace | [2023 Facebook icon.svg](https://commons.wikimedia.org/wiki/File:2023_Facebook_icon.svg), Wikimedia Commons | Commons-listed public domain (simple logo, below the threshold of originality); Facebook is a trademark of Meta Platforms, Inc. Facebook Marketplace has no standalone app icon of its own — Marketplace is a tab inside the Facebook app — so the Facebook mark is what a seller actually recognizes for this destination. |
| `Assets.xcassets/MarketplaceMarkMercari.imageset/mercari.png` | Mercari | [Mercari logo 2018.svg](https://commons.wikimedia.org/wiki/File:Mercari_logo_2018.svg), Wikimedia Commons | Commons-listed public domain (simple wordmark); Mercari is a trademark of Mercari, Inc. |
| `Assets.xcassets/MarketplaceMarkDepop.imageset/depop.png` | Depop | [Depop logo.svg](https://commons.wikimedia.org/wiki/File:Depop_logo.svg), Wikimedia Commons | Commons-listed public domain (simple wordmark); Depop is a trademark of Depop Ltd. |

Local transform: downloaded as SVG, rasterized with `rsvg-convert` at the
source viewBox's aspect ratio (240×240 for the Facebook mark, 800×175 for the
Mercari wordmark, 800×206 for the Depop wordmark), and stored as a single
`universal` 1x PNG in the asset catalog, matching the single-scale convention
used by this catalog's other mark image sets (e.g. `MarketplaceMarkDepop.imageset`).
No color, geometry, or wordmark text was altered. This sentence named
`FirstValueJacket.imageset` until #887 deleted it; the marks are the remaining
single-scale sets, and the onboarding photographs below ship real 1x, 2x, and 3x.

## Native onboarding item set

Issue #887 replaces the three First-Value onboarding photographs. The desk lamp,
denim jacket, and plain white sneaker they replace shipped with no license record
anywhere in the repository. Their replacements are drawn from the same Unsplash
pool as the marketing set above and get the same treatment: every source below is
a regular (non-Unsplash+) photograph whose source page states **Free to use under
the Unsplash License**. The app does not fetch these at runtime; they compile into
`ios/SnapList/Resources/Assets.xcassets`.

- License: [Unsplash License](https://unsplash.com/license)
- Local transform: requested from the source at its full published resolution in
  sRGB, square-cropped to the box recorded below, resized to 600×600, 1200×1200,
  and 1800×1800 with a Lanczos filter, metadata stripped, and encoded as
  progressive JPEG at quality 88. All three scales come from one crop, so the
  1x/2x/3x slots cannot drift apart.
- Each imageset ships real `1x`, `2x`, and `3x` files. The three assets being
  replaced declared 2x and 3x slots and supplied only a 600px 1x file, so the
  254pt ONB-06 hero was drawn from an image upscaled roughly twofold.
- Attribution is not required by the license. Author and source links are kept
  here so the app has the same auditable record the public demo has.

#### Depicted trademarks, which the Unsplash License does not cover

The Unsplash License grants rights in the photograph, not in what the photograph
shows. Two of these assets picture third-party products:

- `FirstValueController` and the four `FirstValueControllerSold*` comps show a
  Sony DualSense. The onboarding copy names it as the item a seller is listing,
  which is nominative use of a product name to identify that product. This is the
  same posture as the marketing set, which already ships `dualsense.webp` from
  the same source photograph.
- `FirstValueTradingCard` shows a Pokémon card. Its ONB-01 tile is large enough
  that the card art, the Pokémon wordmark, and the `©2016 Pokémon` line are all
  readable on a 3x screen; the ONB-05 row at 62pt is not. Verified by capture, not
  assumed. The ONB-05 row also names it "Charizard card", which is again
  nominative use of a product name to identify the item, the same wording a
  reseller would put in a listing title. The same photograph is already shipped by
  the marketing site under #136.

Recording this because the license alone does not settle it. If a human decides
the depicted mark is not acceptable in shipped onboarding, `FirstValueTradingCard`
is the one asset to swap. It is decorative, carries no price fixture, and appears
on two screens, so replacing it is a one-asset change rather than a reshoot of
the set.

| Local asset | Shown as | Source and author | Source pixels | Square crop | License / attribution |
| --- | --- | --- | --- | --- | --- |
| `FirstValueController` | The seller's own item, on every onboarding screen | [Photo](https://unsplash.com/photos/white-and-black-game-controller-qF-ZZzybOqQ) by Krzysztof Hepner | 4000×6000 | 4000px at 0,100 | Unsplash License; credit: Krzysztof Hepner / Unsplash |
| `FirstValueHeadphones` | ONB-01 tile, ONB-05 work row | [Photo](https://unsplash.com/photos/a-pair-of-headphones--lnvREpbLu0) by Jason Zhang | 4032×2268 | 2268px at 882,0 | Unsplash License; credit: Jason Zhang / Unsplash |
| `FirstValueTradingCard` | ONB-01 tile, ONB-05 work row | [Photo](https://unsplash.com/photos/pokemon-trading-card-on-gray-textile-OB756zZDYi0) by Steven Cordes | 5504×8256 | 4000px at 1357,3449 | Unsplash License; credit: Steven Cordes / Unsplash |
| `FirstValueControllerSold1` | ONB-03 sold comp, $66 | [Photo](https://unsplash.com/photos/a-white-video-game-controller-Iz4N0nXmmRU) by Daniel ZH | 6000×4000 | 4000px at 1000,0 | Unsplash License; credit: Daniel ZH / Unsplash |
| `FirstValueControllerSold2` | ONB-03 sold comp, $62 | [Photo](https://unsplash.com/photos/playstation-5-dualsense-controller-on-a-red-surface-yc5Z3xNlyUw) by User_Pascal | 5871×3914 | 3914px at 1331,0 | Unsplash License; credit: User_Pascal / Unsplash |
| `FirstValueControllerSold3` | ONB-03 sold comp, $55 | [Photo](https://unsplash.com/photos/a-close-up-of-a-video-game-controller-oCQdAzy6u8I) by chris panas | 5464×8192 | 4000px at 1005,4192 | Unsplash License; credit: chris panas / Unsplash |
| `FirstValueControllerSold4` | ONB-03 sold comp, $49 | [Photo](https://unsplash.com/photos/a-video-game-console-sitting-on-top-of-a-wooden-table-IAAxRtlmD9w) by Amanz | 4240×2384 | 1800px at 732,584 | Unsplash License; credit: Amanz / Unsplash |

### Why these items

The onboarding screens carry one item all the way through, from its photographs
to its sold comps to its finished listing, so that item also has to carry the
price fixture. A DualSense controller retails at $69.99 new and resells used in
the $40 to $66 range, which is the band the screens already showed. A PS5, an
iPhone 15, or AirPods Max would have made the existing $49 to $66 range, the $40
to $70 chart axis, and the $58 suggestion untrue, and rewriting those numbers was
not what the issue asked for. The set also reuses the source photo the marketing
site already ships as `public/demo/reseller/dualsense.webp`, so the item a seller
meets in onboarding is one they can also see on the site.

Which photograph plays which part changed once, on the owner's direction. The
seller's own item was first the red-field photograph (`yc5Z3xNlyUw`). On ONB-06
that fills a 254pt hero with a saturated red that fights the White Seller Utility
palette, so the roles were swapped: the light gray sweep (`qF-ZZzybOqQ`) is now
the seller's item across every screen, and the red-field photograph moved into the
$62 comp, where it appears once at 36pt. Nothing was sourced or recolored; the two
files traded imagesets. The swap also improved the ONB-02 crops, because the gray
photograph fills its frame while the red one sat the controller in open background,
which is what made a close crop land on nothing.

The other two are the ONB-01 tiles and the ONB-05 work rows, where the job is to
be recognizable next to the controller rather than to be priced. Headphones and a
holographic Charizard read as three different categories at a glance and stay
legible at the 62pt row and the narrow ONB-01 tile.

### Selection audit

Every candidate was inspected as a square center crop at 36pt, the size of an
ONB-03 sold comp, and again at the 254pt ONB-06 hero and the 1:3 ONB-01 tile crop,
because the same file has to survive all three. Rejected candidates:

- `BS3XsRztEGo` and `WO4DxFdA3dY` crop so tightly that the controller loses its
  silhouette. Both read as a gray shape at 36pt.
- `9AmKnNZw3GA` and `59MGmlUiqwA` are DualShock 4 controllers, not DualSense.
- `_z9Rk2FGpnw` and `CYpPNooT1NA` sit the controller small in a dark frame, so it
  disappears at row size.
- `E8GfAQwGXj8` shows three controller generations at once, which reads as a lot
  rather than as one seller's listing.
- `LJ_ZOq9fiEQ` is a good photograph but shares its photographer, table, and
  lighting with `Iz4N0nXmmRU`. Using both would have put the same listing in the
  comp row twice, which is the problem #887 exists to fix.
- `ads33nL7V4k` was already rejected for the marketing set in #136 and was not
  reconsidered.

The four comps that shipped come from four photographers on four surfaces, a dark
wood table, a light gray sweep, a blue bokeh background, and a console shelf, so
the row reads as four sellers rather than one photograph transformed four ways.
