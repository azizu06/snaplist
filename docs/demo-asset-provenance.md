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
already used by this catalog's other image sets (e.g. `FirstValueJacket.imageset`).
No color, geometry, or wordmark text was altered.
