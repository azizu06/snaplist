# App Store Connect privacy label

Answers for App Privacy in App Store Connect.

**This table is derived from `ios/SnapList/PrivacyInfo.xcprivacy`, not maintained
alongside it.** The manifest is the declaration the build enforces; this file is
the copy a human types into Apple's form. When the two disagree the submitted
label is wrong, and Apple catches that after the submission rather than before
it. `src/lib/privacy-label/contract.test.ts` fails if they ever diverge — a
collected type with no row, a row the manifest does not declare, or any cell
that answers a question differently from the manifest.

To change the label, change the manifest and re-derive the row. Do not edit a
cell here on its own.

| Data type | Collected | Purpose | Linked to user | Used for tracking |
| --- | --- | --- | --- | --- |
| Photos or Videos | Yes | App Functionality | Yes | No |
| Audio Data | Yes | App Functionality | Yes | No |
| Other User Content | Yes | App Functionality | Yes | No |
| Email Address | Yes | App Functionality | Yes | No |
| User ID | Yes | App Functionality, Analytics | Yes | No |
| Device ID | Yes | App Functionality, Analytics | Yes | No |
| Purchase History | Yes | App Functionality | Yes | No |
| Product Interaction | Yes | Analytics | Yes | No |
| Crash Data | Yes | App Functionality | No | No |

## How each name was derived

Apple spells an App Store Connect data-type name and its manifest constant with
the same words: `NSPrivacyCollectedDataTypeAudioData` is `Audio Data`. Every
name above is that constant with the `NSPrivacyCollectedDataType` prefix removed
and the words separated; every purpose is the same rule applied to
`NSPrivacyCollectedDataTypePurpose`. One constant needs the separation done by
hand — `NSPrivacyCollectedDataTypePhotosorVideos` spells the "or" in lower case,
so splitting on capitals alone would produce "Photosor Videos".

The test compares both sides with case and spacing folded away, so a
misremembered name ("Photo Library") fails while the spacing above does not
matter to it.

App Store Connect groups these types under category headings. This file
deliberately does not reproduce that grouping: it cannot be derived from the
manifest, so a remembered one would be the same class of error this file exists
to prevent. Search the form by the data-type name instead.

## What each row is

- **Photos or Videos** — the one to five item photos the seller submits. They are
  uploaded to private per-tenant Storage and read by the vision and listing
  models.
- **Audio Data** — the optional voice note, at most fifteen seconds. It is
  uploaded, transcribed, and then deleted; the transcript follows the item.
- **Other User Content** — the drafted listing itself: title, description, item
  specifics, condition, and the seller's edits to them.
- **Email Address** — the account identity held by Clerk, and a launch-waitlist
  address if the seller gives one.
- **User ID** — the Clerk user id. It is the `user_id` every domain table's RLS
  policy compares against, which is App Functionality, and it also aliases the
  already-anonymous PostHog profile after an account claim, which is Analytics.
- **Device ID** — the App Attest-backed device identity that carries the guest
  allowance (ADR-0008), and PostHog's per-install identifier.
- **Purchase History** — whether a SnapList Pro subscription is active. Apple
  handles the payment; SnapList never sees a card.
- **Product Interaction** — the fixed set of typed funnel events sent to PostHog.
  Automatic lifecycle, screen, element-interaction, replay, error, feature-flag,
  and network-telemetry capture are all disabled, and event properties are
  filtered against an allowlist, so no seller content, price, or free text is
  sent.
- **Crash Data** — Sentry crash reports, with listing contents scrubbed. This is
  the one row that is **not** linked to the seller.

## Tracking

Every row answers **No**. SnapList does not link any of this data with
third-party data for advertising or advertising measurement and does not share
it with data brokers. `NSPrivacyTracking` is `false` and `NSPrivacyTrackingDomains`
is empty; `ios/SnapListTests/PrivacyDisclosureTests.swift` pins both.

PostHog iOS 3.66.1 ships its own privacy manifest covering its internal usage
data. The label above covers what SnapList collects.
