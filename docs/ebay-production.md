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
| `SUPABASE_SERVICE_ROLE_KEY` | current `sb_secret_...` | current `sb_secret_...`; required by tenant-bound completion and cron RPCs |
| policy ids (`EBAY_*_POLICY_ID`, `EBAY_MERCHANT_LOCATION_KEY`) | optional exact-operator fallback only | **unset**; each connected seller's verified binding |
| `EBAY_OAUTH_TOKEN` / `EBAY_REFRESH_TOKEN` | sandbox convenience | **unset** — production publishes use per-user OAuth |
| `EBAY_MESSAGING_SANDBOX_OPERATOR_*` | optional one-tenant fallback | **unset** — never allowed in production |
| `CRON_SECRET` | optional for local/manual checks | required before enabling scheduled inbox sync |

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
then atomically erases every matched seller or buyer data set: OAuth credentials,
message trees, notifications, unresolved questions, sync state, fallback bindings,
and private identity provenance. Generation tombstones prevent erased identity
from being rebound by stale work. The route then logs only the matched-tenant
count under `ebay.account_deletion` for compliance.

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
SUPABASE_SERVICE_ROLE_KEY=<current sb_secret_... value>
EBAY_MARKETPLACE_ID=EBAY_US
CRON_SECRET=<openssl rand -hex 32; required before scheduled inbox sync>
```

and remove `EBAY_OAUTH_TOKEN`, `EBAY_REFRESH_TOKEN`, and both
`EBAY_MESSAGING_SANDBOX_OPERATOR_*` values (Sandbox-only crutches —
with them unset, publishing *requires* a per-user connection, which is the
correct production posture). Also remove `EBAY_FULFILLMENT_POLICY_ID`,
`EBAY_PAYMENT_POLICY_ID`, `EBAY_RETURN_POLICY_ID`, and
`EBAY_MERCHANT_LOCATION_KEY`; production refuses shared seller policy/location
fallback.

### 4. Connect the seller account

Settings → **Connect eBay** → approve on eBay's consent screen. Tokens are
stored AES-256-GCM-encrypted (`ebay_connections`, RLS-scoped); the seller can
disconnect any time. Publishes now run under the seller's own identity — the
`EbayTokenProvider` seam swaps per-user tokens in without touching the adapter.
Policy/location discovery stores the seller's selected marketplace tuple on the
same connection generation. A normal publish is rejected before any eBay write
unless that exact binding is still ready when dispatch begins.
The same per-user provider resolves authenticated pre-sale messaging tokens;
connections created before the `commerce.message` scope was added must
reconnect before messaging is enabled.

Disconnect refuses while a provider dispatch is active. Once it succeeds, it
deletes the encrypted grant, advances the tenant's eBay account generation,
clears sync/reconciliation state for the retired generation, and marks any
still-actionable imported questions `provider_unavailable`; reconnecting cannot
resume a stale send under the replacement account.

### 5. Redacted production-readiness validation

The #389 readiness check is metadata-only: report whether required app
configuration and a seller-owned binding are present without printing tokens,
policy ids, location keys, seller identity, or other provider values. It must
not exchange a token or call an eBay endpoint. A live production canary remains
separately owner-authorized under #390/#391; do not turn this checklist into one.

Production messaging remains owner-controlled under #17. Enable the five-minute
Supabase inbox cron from the Sandbox messaging runbook and run a real two-user
message only after the production keyset, deletion subscription, scopes,
policies, and owner approval are all confirmed; until then use the Sandbox
messaging runbook.

## Per-connection publish authority

Business policies and merchant locations belong to the eBay account that
created them. SnapList therefore resolves each normal seller's offer from the
verified marketplace binding stored on that seller's current connection
generation. The selected tuple is pinned to the publish claim and rechecked
before provider dispatch; missing, stale, cross-marketplace, or foreign values
perform no eBay write. Process-wide seller ids are never a production fallback.

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
