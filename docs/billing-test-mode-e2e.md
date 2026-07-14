# Stripe billing lifecycle — bounded test-mode E2E (#152)

This runbook proves one seller lifecycle without live charges, dashboard changes,
or buyer-payment behavior. Run it only against local SnapList with **Stripe test
mode** credentials already supplied by the operator. It creates at most one
abandoned Checkout session and one test-mode subscription for a single test user.

## Before starting

1. Do not run this against a live `sk_live_` key or a live Price. The following
   check deliberately prints no credential values:

   ```sh
   case "${STRIPE_SECRET_KEY:-}" in
     sk_test_*) ;;
     *) echo "Refusing: STRIPE_SECRET_KEY must be a Stripe test-mode key." >&2; exit 1 ;;
   esac
   test -n "${STRIPE_PRICE_PRO:-}" || {
     echo "Refusing: STRIPE_PRICE_PRO is required." >&2
     exit 1
   }
   ```

2. Keep the Stripe CLI signing secret local and untracked. Start a local listener:

   ```sh
   stripe listen \
     --forward-to http://127.0.0.1:3000/api/webhooks/stripe \
     --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.payment_failed
   ```

   Copy the listener's signing secret into the already-untracked `.env.local` as
   `STRIPE_WEBHOOK_SECRET`, then restart `pnpm dev`. Do not paste it into this
   document, shell history, issue, PR, or chat.

3. Start the app with `pnpm dev`, sign in as one disposable local test seller, and
   open **Settings → Plan & billing**.

## One bounded lifecycle

1. Select **Upgrade to Seller Pro**, reach Stripe Checkout, then leave it without
   payment and return to Settings. This is the abandoned-Checkout leg.
2. Select **Upgrade to Seller Pro** again. The app must reuse the same Customer
   mapping **and the same unexpired Checkout session**; it must not create a second
   Customer, Checkout session, or Subscription.
3. Complete that Checkout with Stripe's documented test payment method.
   Wait for the forwarded signed events. Settings should show **Seller Pro** and
   the paid daily allowance only after the Subscription is `active` or `trialing`.
4. Select **Manage billing**. It must open the Stripe Billing Portal for the same
   Customer; it must not open another subscription Checkout.
5. Cancel in that test-mode Portal and wait for `customer.subscription.updated` or
   `customer.subscription.deleted`. Refresh Settings: entitlement must return to
   Free. Do not manually edit the Supabase row.

## Assertions and cleanup

- The Customer map is server-only (`billing_customers`); a signed-in browser
  cannot read or write it.
- `checkout.session.completed` is never enough by itself to grant Seller Pro. The
  webhook retrieves the current Subscription and reconciles a current non-terminal
  Subscription for the Customer, so an incomplete Subscription stays Free, a late
  terminal event cannot displace a newer active subscription, and delayed events
  converge on current state.
- A historical completed Checkout that has no durable Customer map remains retryable
  for manual reconciliation. Never assign it from `client_reference_id` or metadata.
- Stop the local listener and app when finished. The canceled test Customer stays
  mapped intentionally: a later test-mode retry demonstrates the stable-Customer
  contract. No live customer, payment, dashboard configuration, or buyer flow is
  touched.

For deterministic offline coverage of the same seams, run:

```sh
pnpm exec vitest run \
  src/lib/billing/lifecycle.test.ts \
  src/lib/billing/webhook.test.ts \
  src/lib/billing/entitlement.test.ts
```
