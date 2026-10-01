# Showcase screenshot provenance

All four showcase images are captures of the running SwiftUI app, resized and re-encoded for the repository. No UI was composited or retouched. Each source and final image was visually inspected before committing; captures with account details were excluded.

| Image | Capture | What it demonstrates |
| --- | --- | --- |
| `phone-to-list.jpg` | iPhone 16 Pro, iOS 27.0, normal signed Release at `56ed76107a143e4d85962bdf3afee5b93fd5695a`; phone worker capture `06-to-list-ready-dock.png` | A retained keyboard item ready for review and the Scout/dock layout. |
| `phone-listing-review.jpg` | Same phone/build; `02-review-workflow-done-restored.png` | Compact editable review fields. The $90 value has **no verified sold matches**, as the screen states. |
| `phone-flips.jpg` | Same phone/build; `14-final-neutral-flips.png` | The empty finished-items destination and Scout; no sold/published history is implied. |
| `scout-pro.png` | iPhone 17 Pro simulator, iOS 26.5; paywall worker capture `paywall-h-offer-baseline.png`, from the merged H paywall work | The actual Scout paywall in its saved-item context, with fixture photos/product metadata. **$9.99 is fixture data**, not a public price commitment or a purchase receipt. |

The phone sources were supplied by the phone worker under `ios/Artifacts/input-keyboard-followup/phone-visual-56ed7610/`; the simulator source was supplied under `ios/Artifacts/` by the paywall worker. These local source artifacts remain ignored. This README task did not operate the phone or make a purchase.

The three phone images retain the iPhone Mirroring frame, status bar, and pointer/focus decoration. They are stored at 560 px high; the paywall is 780 px high. Only item content and a one-letter avatar are visible in the phone selections; no name, email, address, account ID, notification, or credential is displayed.

The older `listing-review.png` and `trophy-wall.png` filenames remain for the historical simulator evidence described in the [developer guide](../developer-guide.md#screenshot-provenance). Those fixture matches are not live sales research and are not the current hero images.
