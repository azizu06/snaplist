import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserId, getUserEmail } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/abuse";
import {
  createStripeBillingAdapter,
  resolveStripeConfig,
  stripeConfigured,
} from "@/lib/billing";
import { serverErrorJson } from "@/lib/api/errors";

/**
 * Start a Stripe Checkout for the Pro subscription (issue #64). POST → `{ url }`
 * (the hosted Checkout page). Auth + rate-limited. Test mode: with Stripe unset the
 * route returns 503 so the UI degrades to the `/pricing` CTA. Redirects derive from
 * the request origin — no app-URL env needed.
 */
export async function POST(request: NextRequest) {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const limited = await enforceRateLimit(request, userId);
  if (limited) return limited;

  if (!stripeConfigured()) {
    return NextResponse.json({ error: "Billing is not available yet." }, { status: 503 });
  }
  const config = resolveStripeConfig();
  if (!config.pricePro) {
    return NextResponse.json({ error: "No Pro plan is configured." }, { status: 503 });
  }

  try {
    // Reuse the user's Stripe customer if the webhook has already mirrored one
    // (RLS read-own); otherwise the adapter creates one.
    const supabase = await createClient();
    const { data } = await supabase
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", userId)
      .maybeSingle();
    const existingCustomerId =
      (data as { stripe_customer_id?: string } | null)?.stripe_customer_id ?? undefined;

    const adapter = await createStripeBillingAdapter(config);
    const email = (await getUserEmail()) ?? undefined;
    const customerId = await adapter.ensureCustomer({ userId, email, existingCustomerId });

    const origin = request.nextUrl.origin;
    const { url } = await adapter.createCheckoutSession({
      userId,
      customerId,
      priceId: config.pricePro,
      successUrl: `${origin}/settings?billing=success`,
      cancelUrl: `${origin}/settings?billing=cancelled`,
      customerEmail: email,
    });
    return NextResponse.json({ url }, { status: 200 });
  } catch (err) {
    return serverErrorJson("billing.checkout", err, "Could not start checkout.");
  }
}
