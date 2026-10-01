<h1 align="center">SnapList</h1>

<p align="center"><b>Turn the stuff you own into listings worth posting.</b></p>

<p align="center">
  Snap a few photos, add a quick voice note, and get an editable resale listing with a starting price.<br>
  Spend less time researching and writing. Keep the final say on what goes out.
</p>

<p align="center"><b>Built for RevenueCat Shipaton 2026 · Next Gen track</b><br>Native iPhone app · Meet Scout, your listing companion</p>

<p align="center">
  <img src="docs/readme/phone-to-list.jpg" width="220" alt="SnapList on a real iPhone: Scout holds a parcel above a keyboard ready to review in To list.">
  &nbsp;
  <img src="docs/readme/phone-listing-review.jpg" width="220" alt="Real iPhone listing review: editable keyboard price, title, description and condition, with no verified sold matches found.">
  &nbsp;
  <img src="docs/readme/phone-flips.jpg" width="220" alt="Real iPhone Flips screen: Scout invites you to scan your first item, above the three-button dock.">
</p>

<p align="center"><sub>Real app, real iPhone. To list → review → Flips.<br><a href="docs/readme/README.md">Screenshot notes</a>.</sub></p>

## From photo to flip

1. **Snap it.** Take one to five photos. Add an optional voice note of up to fifteen seconds for details the camera might miss.
2. **Get a draft.** AI identifies the item and writes a title, description, condition, and item details. Everything stays editable.
3. **Check the price.** SnapList researches comparable eBay sales and shows the matches it can verify. If reliable matches are unavailable, you still get a clearly labeled starting estimate. Set your own price at any time.
4. **Keep going.** Start the next item while earlier items process in parallel. **To list** keeps the ones waiting for review together, so you can work through several items without waiting between each one.
5. **Choose where it goes.** Review and confirm a direct eBay publish. For Facebook Marketplace, Mercari, or Depop, take the prepared text and photos into the marketplace and finish posting there yourself.
6. **See your Flips.** Finished items collect in a chronological view. An export marked prepared or shared stays distinct from an eBay publish; neither is a claim that the item sold.

The first usable listing comes **before signup or a paywall**. Try the result on your own item before deciding to keep listing.

## RevenueCat powers SnapList Pro

Scout meets you at a packing counter when you want more AI listings. The plan appears on a taped packing slip: price, renewal terms, Subscribe, and Restore, with Terms and Privacy close at hand.

<p align="center"><img src="docs/readme/scout-pro.jpg" width="290" alt="SnapList Pro on a real iPhone: Scout at a packing counter, a monthly plan on a taped slip, Subscribe, Restore, Terms and Privacy."><br><sub>Scout’s packing-counter paywall. <a href="docs/readme/README.md">Screenshot notes</a>.</sub></p>

| Free first item | SnapList Pro |
| --- | --- |
| One complete AI listing, including one guided identity correction for the same photos. Review and edit the result before committing to a subscription. | Continue with new AI items through a monthly allowance. The second complete AI item run requires Pro. |

**RevenueCat handles the Apple subscription flow:** the iOS app loads the configured offering and localized product price, purchases through its SDK, and supports restoring purchases. The same integration connects the subscription to the signed-in SnapList account.

**The server confirms access.** RevenueCat subscription events update the verified Pro entitlement and billing period. A successful purchase screen alone cannot unlock AI credits. The app has confirming and pending states, and can resume the saved item once access is verified.

**Credits count useful results.** A credit settles when an editable, priced draft is saved. Technical retries and recovery reuse it; a failure before that point restores it. Pro’s monthly allowance is configurable while real usage costs are measured.

The integration is implemented and covered by purchase/restore fixtures and server contract tests.

## Built for the parts that matter

- **An iPhone experience, not a web form.** SwiftUI capture, optional voice context, compact editable fields, and Scout keep the work close to the item in your hand.
- **Work that survives interruption.** The TypeScript backend saves progress between identification, pricing, and writing. A recovered job continues from saved work instead of starting every AI call again.
- **Evidence you can question.** Sold results pass an item matcher before they support a price. Confidence comes from identification and pricing evidence. When research falls short, the app says so.
- **Your edits reach the marketplace.** One shared price rule carries your chosen price into eBay and export packs. Publish confirmation is protected against duplicate requests.
- **Private by design.** Supabase database policies isolate each seller's items; photos and voice notes use private storage. Guest access is tied to Apple's App Attest, with an encrypted result recoverable for 24 hours.

[Explore the implementation, tests, and measured benchmarks](docs/developer-guide.md).

## See it in action

**Demo video: coming soon.** This repository is the Shipaton showcase; an App Store release is not available yet.

To explore locally, open [`ios/SnapList.xcodeproj`](ios/SnapList.xcodeproj) in Xcode and follow the [iOS setup guide](ios/README.md). The [developer guide](docs/developer-guide.md#getting-started) covers the API, local Supabase, and verification commands.

## For builders

[Developer setup & architecture](docs/developer-guide.md) · [Product requirements](PRD.md) · [Documentation index](docs/README.md) · [Screenshot provenance](docs/readme/README.md)

[Apache License 2.0](LICENSE)
