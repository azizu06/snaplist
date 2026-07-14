# eBay production go-live (issue #17)

Sandbox → production is **config-only** — the code paths are identical. This is
the ordered checklist for the flip. Sandbox setup itself is documented in
[ebay-sandbox.md](./ebay-sandbox.md).

## What changes at the flip

| Env var | Sandbox | Production |
| --- | --- | --- |
| `EBAY_BASE_URL` | `https://api.sandbox.ebay.com` (default) | `https://api.ebay.com` |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` | sandbox keyset | **production keyset** |
| `EBAY_RU_NAME` | sandbox RuName | **production RuName** |
| `EBAY_VERIFICATION_TOKEN` | unused | random 32–80 char token you mint |
| `EBAY_DELETION_ENDPOINT_URL` | unused | `https://<host>/api/ebay/account-deletion` |
| `EBAY_TOKEN_ENCRYPTION_KEY` | any | keep stable — rotating it orphans stored seller tokens |
| policy ids (`EBAY_*_POLICY_ID`, `EBAY_MERCHANT_LOCATION_KEY`) | sandbox seller's | production seller's |
| `EBAY_OAUTH_TOKEN` / `EBAY_REFRESH_TOKEN` | sandbox convenience | **unset** — production publishes use per-user OAuth |

The consent-screen host flips automatically with `EBAY_BASE_URL`
(`auth.sandbox.ebay.com` ↔ `auth.ebay.com`); nothing else derives state from
`NODE_ENV`.

## Ordered checklist

### 1. Account-deletion endpoint first (eBay gates production keys on it)

eBay requires a working Marketplace Account Deletion endpoint **before** it
issues production keys.

1. Generate a verification token: `openssl rand -hex 32` (32–80 chars,
   alphanumeric + `_-`).
2. Set `EBAY_VERIFICATION_TOKEN` and
   `EBAY_DELETION_ENDPOINT_URL=https://<host>/api/ebay/account-deletion` in the
   deployed environment and redeploy.
3. In the eBay developer portal → **Alerts & Notifications** → Marketplace
   Account Deletion: enter the endpoint URL + the same token, hit **Save/Test**.
   eBay sends `GET ?challenge_code=...`; the route answers the SHA-256
   challenge. (The URL must match `EBAY_DELETION_ENDPOINT_URL` byte-for-byte.)

What the endpoint does once live: verifies each notice's `x-ebay-signature`
against eBay's notification public key (unverifiable → 412 so eBay retries),
then erases the eBay user's stored OAuth connection and logs
`ebay.account_deletion` for compliance.

### 2. Request the production keyset

Developer portal → Application Keys → **Production**. Production keysets
require the deletion endpoint above to be saved and passing. Note all three
values: App ID (client id), Cert ID (client secret), and create a **RuName**
(User Tokens → "Get a Token from eBay via Your Application") whose
**auth-accepted URL** is `https://<host>/api/ebay/callback`.

### 3. Flip the environment

Set in Vercel (Production):

```
EBAY_BASE_URL=https://api.ebay.com
EBAY_CLIENT_ID=<production App ID>
EBAY_CLIENT_SECRET=<production Cert ID>
EBAY_RU_NAME=<production RuName>
EBAY_TOKEN_ENCRYPTION_KEY=<openssl rand -base64 32; then never rotate casually>
EBAY_MARKETPLACE_ID=EBAY_US
EBAY_FULFILLMENT_POLICY_ID=...   # the real seller's business policies
EBAY_PAYMENT_POLICY_ID=...
EBAY_RETURN_POLICY_ID=...
EBAY_MERCHANT_LOCATION_KEY=...
```

and remove `EBAY_OAUTH_TOKEN` / `EBAY_REFRESH_TOKEN` (sandbox-only crutches —
with them unset, publishing *requires* a per-user connection, which is the
correct production posture).

### 4. Connect the seller account

Settings → **Connect eBay** → approve on eBay's consent screen. Tokens are
stored AES-256-GCM-encrypted (`ebay_connections`, RLS-scoped); the seller can
disconnect any time. Publishes now run under the seller's own identity — the
`EbayTokenProvider` seam swaps per-user tokens in without touching the adapter.
The same per-user provider resolves authenticated pre-sale messaging tokens;
connections created before the `commerce.message` scope was added must
reconnect before messaging is enabled.

### 5. First production publish

Upload a real item, save a distinctive seller price override, then review → **Publish to eBay**.
Verify the live offer uses the override rather than the logged suggestion and that the prediction
log remains unchanged. Then end the listing from Seller Hub if it was only a smoke test.

## Known constraint: single production seller

Business policies and the merchant location are env-configured
(`EBAY_*_POLICY_ID`, `EBAY_MERCHANT_LOCATION_KEY`) and **belong to the eBay
account that created them**. Production publishing is therefore correct for
the one seller whose policies are in the env — which is exactly the #17
go-live story. If a *second* seller connects, their publishes would submit the
first seller's policy ids and eBay would reject the offer. True multi-seller
support means discovering each connection's policies via the Sell Account API
(`sell.account` scope) at connect time and injecting them per publish — tracked
as a follow-up issue.

## Security notes

- Seller refresh/access tokens are encrypted at rest (AES-256-GCM,
  `src/lib/crypto/secretbox.ts`); the key lives only in the environment.
  Losing/rotating `EBAY_TOKEN_ENCRYPTION_KEY` invalidates stored connections —
  sellers just reconnect, nothing else breaks.
- The OAuth flow carries a single-use CSRF `state` in an httpOnly cookie; the
  callback validates it before the code is exchanged.
- Deletion notices are acted on **only** after ECDSA signature verification
  against eBay's published key (cached per `kid`). Failures return 412/500 so
  eBay's retry machinery — not silence — owns the gap.
