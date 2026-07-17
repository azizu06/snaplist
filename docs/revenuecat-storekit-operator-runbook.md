# RevenueCat / StoreKit operator runbook

Issue #173 implements the offline-testable bridge. It does not make RevenueCat or a device the
AI-item quota authority: verified lifecycle is translated into the existing #168 StoreKit period,
and run #2 still gates inside the database reservation transaction.

## Current activation gate

Do not create placeholder products or identifiers. Activation remains blocked until all of these are
canonical and current:

- the App Store Connect app and bundle identifier;
- the approved SnapList Pro StoreKit product identifier and subscription duration;
- issue #189's approved monthly AI-item allowance;
- a deployed HTTPS endpoint for the RevenueCat webhook;
- confirmation that the existing RevenueCat plan exposes webhook delivery and HMAC signing without
  any provider plan change;
- App Store agreements, tax, and banking state handled by the owner.

An annual StoreKit product must not be attached until product and engineering explicitly define how
an annual subscription produces monthly credit periods. The current ledger correctly treats the
verified StoreKit subscription period as one reset window; silently calling an annual window
“monthly” would be misleading.

As of the #173 implementation, no RevenueCat project, app, product, entitlement, offering, webhook,
customer, transfer, refund, or purchase was created or mutated. The authenticated account's sole
accessible project was previously audited as empty, so it can be renamed/reused later if a fresh
read confirms it is still empty and the provider supports the change safely.

## Hosted configuration sequence

Perform these steps only after the activation gate is satisfied, recording the provider object IDs
in the protected operator handoff rather than source control:

1. Re-read the RevenueCat account. If the sole generic project is still empty, rename and reuse it;
   otherwise stop and reconcile ownership before creating another project.
2. Add the iOS app with the canonical App Store bundle identifier. Capture its RevenueCat app ID and
   public Apple SDK key. Never use a Test Store key in a release build.
3. Import or map the canonical App Store subscription product. Do not invent a product ID, duration,
   trial, price, or locale.
4. Create the approved SnapList Pro entitlement and attach only the canonical product.
5. Create the approved offering/package mapping. A custom SwiftUI paywall may read this metadata;
   do not enable RevenueCatUI or freeze visual design in provider configuration.
6. Set restore behavior to keep purchases with the original App User ID. SnapList configures the SDK
   only after Clerk authentication, with the Clerk subject as the RevenueCat App User ID. Transfers
   are not used to move quota: RevenueCat transfer payloads omit the subscription/customer identity
   needed for safe tenant selection, and the server rejects mismatched customer/transaction pairs.
7. After an HTTPS deployment exists, configure one sandbox-tested webhook for the provider-neutral
   `/v1/webhooks/revenuecat` contract (the current Next adapter is
   `/api/webhooks/revenuecat`). Configure both the exact `Authorization` value and RevenueCat HMAC
   signing secret. Keep the 300-second timestamp tolerance and raw-body verification.
8. Set the server environment values below. Do not put real values in `.env.example`, source, a PR,
   logs, or chat.
9. Run a sandbox purchase/restore lifecycle only in the separately approved live-acceptance step.
   Verify the provider event, binding row, #168 period, first included run, run-#2 StoreKit
   reservation, grace behavior, and duplicate delivery before enabling production delivery.

Required server environment:

- `REVENUECAT_WEBHOOK_SIGNING_SECRET`
- `REVENUECAT_WEBHOOK_AUTHORIZATION`
- `REVENUECAT_APP_ID`
- `REVENUECAT_ENTITLEMENT_ID`
- `REVENUECAT_MONTHLY_PRODUCT_ID`
- `REVENUECAT_IOS_PUBLIC_SDK_KEY`
- optional `REVENUECAT_OFFERING_ID`
- `SNAPLIST_PRO_MONTHLY_AI_ITEM_ALLOWANCE`

Leaving every value unset is the supported offline/unconfigured state. Partial server configuration
is rejected. Missing native SDK key returns an unconfigured client response and makes no provider
request. The server and native client both accept only the exact configured monthly product ID; do
not map an annual product to the entitlement until a separately approved monthly-ledger semantic
exists for annual billing.

## Lifecycle and replay policy

| Verified input | Ledger result |
| --- | --- |
| Initial purchase, renewal, uncancellation | Active period; a renewal advances only with a new period identity |
| Cancellation / unsubscribe | Current paid-through period stays active; renewal is shown canceled |
| Verified grace | Same period becomes grace and keeps its remaining credits |
| Billing issue without grace | Billing retry; no new reservation; its companion billing-error cancellation is ignored so delivery order cannot erase verified grace |
| Expiration | Expired; no new reservation |
| Developer revocation or support refund | Terminal revoked/refunded state |
| Product change, subscription extension, refund reversal | Explicit reconciliation required; preserve the last verified period remainder but do not mint or advance credit |
| Transfer event | Ignored because RevenueCat omits subscription/customer identity; provider restore behavior must stay **Keep with original App User ID** |
| Duplicate or older event | Idempotently ignored; it cannot reset or reopen a period |
| Unknown App User ID or original transaction mismatch | Fail closed; no tenant is selected from aliases or client data |

RevenueCat retries are safe because the bridge verifies raw-body HMAC and timestamp before parsing,
then deduplicates the provider event ID and delegates to #168's monotonic period event ledger.

## Legacy Stripe reconciliation

Binding a seller with a current `active` or `trialing` Stripe mirror records that status separately
and sets `transition_state = required`. The bridge will not create StoreKit allowance until an
operator verifies that the Stripe source is no longer granting paid access and the App Store
original transaction belongs to the same Clerk seller. Only then may the narrow service-role RPC
`reconcile_revenuecat_billing_source(user_id, expected_original_transaction_id)` be invoked. Never
call it from the client or infer equivalence from email, aliases, or RevenueCat CustomerInfo. The RPC
refuses to reconcile while the verified Stripe mirror is still current. If Stripe later becomes
current again, the subscription lifecycle write immediately restores `required`, marks the StoreKit
period ambiguous, and blocks reservation authority until another explicit reconciliation.

## Disable / rollback

Disable webhook delivery at RevenueCat, remove the RevenueCat server environment values, and deploy
the inert configuration. This stops new native verification without deleting settled credits,
drafts, bindings, or audit events. Data cleanup and provider-object deletion require a separate,
reviewed retention/account-deletion change.
