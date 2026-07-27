# eBay adapter: sandbox setup & the production flip (issue #14)

SnapList publishes listings to eBay through one adapter seam
(`src/lib/marketplace/ebay`). Everything provider-specific lives behind the
`EbayAdapter` interface; the rest of the app (publish service, API route, UI)
never sees eBay HTTP. **Sandbox ↔ production is config-only** — `EBAY_BASE_URL`
plus credentials/policy ids. No code change.

Pre-sale buyer questions and text replies/follow-ups use the same credential
boundary through a separate marketplace-messaging adapter. Its two-user
operator procedure is in [ebay-messaging-sandbox.md](./ebay-messaging-sandbox.md).

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

The amount sent through the adapter is the item's **effective price**: a valid, positive,
cent-normalized `items.price_override` when the seller set one, otherwise the latest
`prediction_logs.price` suggestion. Publishing never rewrites the recommendation log; an invalid
legacy override is ignored and safely falls back to the suggestion.

Before any external call, the publish service atomically claims one coherent review snapshot
(listing copy, condition, photos, and effective price) using the item's review revision and listing
run id. Concurrent review edits/regeneration or another active publish make the claim fail closed;
a 15-minute claim lease permits safe retry after an abandoned attempt. Once authoritative eBay ids
or publishing/published state exist, review correction, Sharpen, ordinary review edits, and dashboard
status changes cannot rewrite that listing as a draft. Seller-price edits and applied reprices advance
the same review revision, and the database rejects a price-override change while a publish claim is
active, so eBay cannot receive a stale or half-updated amount.

## Tests are offline — always

The entire test suite runs against `MockEbayAdapter`,
`MockMarketplaceMessagingAdapter`, and fake `fetch` implementations for HTTP
contract tests. No eBay credential is needed for `pnpm test`, and tests never
call live eBay.

## Sandbox setup (one-time)

1. **Developer account** — register at <https://developer.ebay.com>, create an
   app, and note the **sandbox** App ID (client id) and Cert ID (client secret).
2. **Sandbox seller** — create a sandbox test user
   (Developer console → "Sandbox user registration") and complete its seller
   onboarding at <https://sandbox.ebay.com>.
3. **Auth (prefer the connected-seller path):**
   - Set the Sandbox `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, and `EBAY_RU_NAME`
     for the legacy Settings callback. Register a separate Sandbox RuName whose
     auth-accepted URL is `https://<host>/v1/ebay/oauth/callback` and set it as
     `EBAY_MOBILE_RU_NAME`; the mobile route fails closed if this is absent. Also
     set the HTTPS app universal link as `EBAY_MOBILE_OAUTH_RETURN_URL`; it
     must contain neither credentials nor a fragment. Set one stable
     `EBAY_TOKEN_ENCRYPTION_KEY`. In Settings, choose **Connect
     eBay** and authorize the Sandbox seller. The flow requests inventory,
     identity/account-read, the traditional base, and `commerce.message` scopes;
     the encrypted per-user grant is used for publish, reprice, and messaging.
   - *Operator fallback:* mint a short-lived Sandbox user token and set
     `EBAY_OAUTH_TOKEN`, or set `EBAY_REFRESH_TOKEN` with the client keypair. Also
     set `EBAY_MESSAGING_SANDBOX_OPERATOR_USER_ID` to the one allowed Clerk
     tenant and `EBAY_MESSAGING_SANDBOX_OPERATOR_SELLER_ID` to that token's
     stable eBay seller ID. The fallback works only with the exact
     `https://api.sandbox.ebay.com` origin, is generation-bound in the database,
     and is denied to every other tenant and all production origins.
4. **Business policies + location** — on the sandbox seller account create a
   fulfillment, payment, and return policy (Seller Hub → Business policies, or
   the Account API) and an inventory location (`POST
   /sell/inventory/v1/location/{key}` or Seller Hub). For a connected seller,
   SnapList discovers and stores the selected marketplace values on that
   seller's current connection generation; publish remains blocked until that
   binding is ready. Set `EBAY_FULFILLMENT_POLICY_ID`,
   `EBAY_PAYMENT_POLICY_ID`, `EBAY_RETURN_POLICY_ID`, and
   `EBAY_MERCHANT_LOCATION_KEY` only for the exact operator fallback described
   above. Those shared values are refused for every other tenant and every
   production origin.
5. Optionally set `EBAY_DEFAULT_CATEGORY_ID` to a leaf category for your test
   items (defaults to eBay's generic "Everything Else > Other" until real
   category resolution lands).

App credentials and any explicitly chosen operator-fallback values go in
`.env.local` (see `.env.example`). Connected-seller policy/location selections
live on the RLS-owned connection row, not in shared environment configuration.
Use a current
`sb_secret_...` value for `SUPABASE_SERVICE_ROLE_KEY`; tenant-bound transactional
writes reject legacy JWT-style service-role keys. The adapters read eBay config
lazily at provider-call time and fail with a readable error when it is missing —
nothing breaks at import/boot when credentials are absent.

> **Status note:** provider actions remain operator-only. Publishing and
> messaging are contract-tested offline; record any owner-run Sandbox result
> explicitly. Production activation remains in **#17**.

## The production flip (config-only)

| Variable | Sandbox | Production |
| --- | --- | --- |
| `EBAY_BASE_URL` | `https://api.sandbox.ebay.com` (default) | `https://api.ebay.com` |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` | sandbox keyset | production keyset |
| `EBAY_OAUTH_TOKEN` / `EBAY_REFRESH_TOKEN` | operator fallback or per-user setup | **unset**; per-user connection only |
| `EBAY_MESSAGING_SANDBOX_OPERATOR_*` | optional one-tenant fallback binding | **unset** |
| Policy ids + `EBAY_MERCHANT_LOCATION_KEY` | optional exact-operator fallback only | **unset**; each connected seller's verified binding |
| `EBAY_VERIFICATION_TOKEN` / `EBAY_DELETION_ENDPOINT_URL` | blank | required (account-deletion endpoint) |

Per-user OAuth swaps the `EbayTokenProvider` implementation handed to the HTTP
adapters — the provider and everything above it are unchanged.
