import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logEvent } from "@/lib/observability";
import { reportServerError } from "@/lib/sentry";
import {
  createStripeBillingAdapter,
  createSupabaseEntitlementStore,
  handleStripeEvent,
  resolveStripeConfig,
  stripeConfigured,
} from "@/lib/billing";

// Node runtime: the Stripe SDK + signature verification need Node crypto and the
// RAW request body (read via request.text(), unparsed) — mirrors the eBay
// account-deletion webhook.
export const runtime = "nodejs";

/**
 * Stripe webhook (issue #64). No auth — instead the payload is SIGNATURE-VERIFIED
 * against STRIPE_WEBHOOK_SECRET before a byte is trusted. Verified events mirror
 * the user's entitlement into Supabase (service role). Handling is idempotent
 * (dedupe on event id + state-upsert), so Stripe's at-least-once redelivery is safe.
 *
 * Status contract (so Stripe's retry behaves):
 *  - 400 — missing/invalid signature (don't retry a forged body);
 *  - 503 — billing not configured (no secret) — shouldn't happen in a live deploy;
 *  - 500 — transient processing/DB error → Stripe RETRIES (not silently dropped);
 *  - 200 — processed, duplicate, or intentionally ignored.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text().catch(() => "");
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature header." }, { status: 400 });
  }

  if (!stripeConfigured() || !process.env.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Billing webhook not configured." }, { status: 503 });
  }

  const adapter = await createStripeBillingAdapter(resolveStripeConfig());

  // 1. Verify the signature BEFORE trusting the payload. A bad signature is a 400.
  let event;
  try {
    event = adapter.constructEvent(rawBody, signature);
  } catch (err) {
    logEvent("billing.webhook.bad_signature", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  // 2. Apply idempotently. A transient failure is a 500 so Stripe retries — the
  //    handler is safe to re-run (dedupe + state upsert).
  try {
    const store = createSupabaseEntitlementStore(createAdminClient());
    const result = await handleStripeEvent(event, store, adapter);
    logEvent("billing.webhook.handled", {
      type: event.type,
      processed: result.processed,
      ...(result.reason ? { reason: result.reason } : {}),
    });
    return NextResponse.json({ received: true }, { status: 200 });
  } catch (err) {
    reportServerError("billing.webhook", err, { type: event.type });
    return NextResponse.json({ error: "Webhook processing failed." }, { status: 500 });
  }
}
