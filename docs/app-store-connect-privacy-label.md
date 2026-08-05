# App Store Connect privacy label

Use these answers for native App Privacy while PostHog funnel analytics is enabled.
Review again if native analytics contract or bundled SDK changes.

| Data type | Collected | Purpose | Linked to user | Used for tracking |
| --- | --- | --- | --- | --- |
| User ID | Yes | Analytics | Yes | No |
| Product Interaction | Yes | Analytics | Yes | No |

`User ID` is Clerk identifier sent only to alias already-anonymous PostHog profile after account
claim. `Product Interaction` is six typed funnel events. No seller content, photo, voice,
free-text, price, IDFA, or advertising identifier is sent. SnapList does not link this data with
third-party data for advertising or advertising measurement, and does not share it with data
brokers, so tracking is **No**.

App manifest declares app-owned Clerk alias and `UserDefaults` use. PostHog iOS 3.66.1 already
ships its own manifest for product interaction and other usage data, so app manifest does not
duplicate those SDK entries. SnapList disables PostHog automatic lifecycle, screen,
element-interaction, replay, error, feature-flag, survey, and network-telemetry capture; App Store
label above therefore covers only explicit native funnel contract.
