# eBay adapter: sandbox setup & the production flip (issue #14)

SnapList publishes listings to eBay through one adapter seam
(`src/lib/marketplace/ebay`). Everything provider-specific lives behind the
`EbayAdapter` interface; the rest of the app (publish service, API route, UI)
never sees eBay HTTP. **Sandbox ↔ production is config-only** — `EBAY_BASE_URL`
plus credentials/policy ids. No code change.

## What the adapter does

`HttpEbayAdapter.publishListing()` runs the documented Sell Inventory flow:

1. `PUT /sell/inventory/v1/inventory_item/{sku}` — upsert the product
   (SKU = the SnapList listing row UUID, so re-publishing is idempotent).
2. `POST /sell/inventory/v1/offer` — create the offer (price, category,
   business policies). If the offer already exists (errorId 25002, e.g. a
   previous publish failed halfway), the existing offer is updated in place.
3. `POST /sell/inventory/v1/offer/{offerId}/publish` — go live; returns the
   eBay `listingId`.

The outcome is persisted on the `listings` row (`ebay_listing_id`,
`ebay_offer_id`, `ebay_status`; migration `20260610192000_listings_ebay_publish.sql`)
and shown on `/listings/[listingId]` (and via `GET /api/ebay/publish?listingId=`).

Publish triggers:

- UI: the "Publish to eBay" button on `/listings/[listingId]`.
- API: `POST /api/ebay/publish` with `{ "listingId": "<uuid>" }` (cookie-authed).

Both triggers call the shared `publishListingToEbayAndNotify` service, so persistence
and the activity-feed notifications (success and failure) behave identically from either
entry point; an idempotent retry of an already-published listing does not re-notify.

Before any external call, the publish service atomically claims one coherent review snapshot
(listing copy, condition, photos, and effective price) using the item's review revision and listing
run id. Concurrent review edits/regeneration or another active publish make the claim fail closed;
a 15-minute claim lease permits safe retry after an abandoned attempt. Once authoritative eBay ids
or publishing/published state exist, review correction, Sharpen, ordinary review edits, and dashboard
status changes cannot rewrite that listing as a draft.

## Tests are offline — always

The entire test suite runs against `MockEbayAdapter` (and a fake `fetch` for
the HTTP adapter's contract tests). No eBay credential is ever needed to run
`pnpm test`, and no live eBay call is ever made by tests.

## Sandbox setup (one-time)

1. **Developer account** — register at <https://developer.ebay.com>, create an
   app, and note the **sandbox** App ID (client id) and Cert ID (client secret).
2. **Sandbox seller** — create a sandbox test user
   (Developer console → "Sandbox user registration") and complete its seller
   onboarding at <https://sandbox.ebay.com>.
3. **Auth (pick one):**
   - *Quick loop:* mint a **user access token** in the developer console
     ("User Tokens" → Get a Token from eBay via Your Application, sandbox) and
     set `EBAY_OAUTH_TOKEN`. Tokens live ~2 hours; fine for manual testing.
   - *Durable:* run the authorization-code flow once for the sandbox seller
     (scope `sell.inventory`), keep the **refresh token** (valid ~18 months),
     and set `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_REFRESH_TOKEN`. The
     adapter exchanges it for access tokens automatically and caches them.
4. **Business policies + location** — on the sandbox seller account create a
   fulfillment, payment, and return policy (Seller Hub → Business policies, or
   the Account API) and an inventory location (`POST
   /sell/inventory/v1/location/{key}` or Seller Hub). Set:
   `EBAY_FULFILLMENT_POLICY_ID`, `EBAY_PAYMENT_POLICY_ID`,
   `EBAY_RETURN_POLICY_ID`, `EBAY_MERCHANT_LOCATION_KEY`.
5. Optionally set `EBAY_DEFAULT_CATEGORY_ID` to a leaf category for your test
   items (defaults to eBay's generic "Everything Else > Other" until real
   category resolution lands).

All of these go in `.env.local` (see `.env.example`). The adapter reads them
lazily at publish time and fails with a readable error naming exactly what is
missing — nothing breaks at import/boot when they're absent.

> **Status note:** this environment has no sandbox credentials in `.env.local`,
> so a live sandbox publish has not been executed yet; the code path is
> complete and contract-tested offline. Live verification happens with the
> credential work in **#17** (per-user OAuth + production flip).

## The production flip (config-only)

| Variable | Sandbox | Production |
| --- | --- | --- |
| `EBAY_BASE_URL` | `https://api.sandbox.ebay.com` (default) | `https://api.ebay.com` |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` | sandbox keyset | production keyset |
| `EBAY_OAUTH_TOKEN` / `EBAY_REFRESH_TOKEN` | sandbox seller token | real seller token (per-user in #17) |
| Policy ids + `EBAY_MERCHANT_LOCATION_KEY` | sandbox seller's | real seller's |
| `EBAY_VERIFICATION_TOKEN` / `EBAY_DELETION_ENDPOINT_URL` | blank | required (account-deletion endpoint) |

Per-user OAuth (issue #17) swaps the `EbayTokenProvider` implementation handed
to `HttpEbayAdapter` — the adapter and everything above it are unchanged.
