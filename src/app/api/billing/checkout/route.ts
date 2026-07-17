import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUserId, getUserEmail } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/abuse";
import {
  createStripeBillingAdapter,
  createSupabaseEntitlementStore,
  resolveStripeConfig,
  startCheckout,
  stripeConfigured,
} from "@/lib/billing";
import { serverErrorJson } from "@/lib/api/errors";
import { getPostHogClient } from "@/lib/posthog-server";

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
    const adapter = await createStripeBillingAdapter(config);
    const email = (await getUserEmail()) ?? undefined;
    const origin = request.nextUrl.origin;
    const result = await startCheckout({
      userId,
      email,
      priceId: config.pricePro,
      successUrl: `${origin}/settings?billing=success`,
      cancelUrl: `${origin}/settings?billing=cancelled`,
      adapter,
      // This trusted server route has already authenticated `userId`; all Customer
      // map writes stay service-role-only and never become a client mutation path.
      store: createSupabaseEntitlementStore(createAdminClient()),
    });
    if (result.destination === "checkout_in_progress") {
      return NextResponse.json(
        { error: "Checkout is already being started. Please try again in a moment." },
        { status: 409 },
      );
    }
    const posthog = getPostHogClient();
    posthog.capture({
      distinctId: userId,
      event: "checkout_started",
      properties: { price_id: config.pricePro },
    });
    await posthog.flush();
    return NextResponse.json({ url: result.url }, { status: 200 });
  } catch (err) {
    return serverErrorJson("billing.checkout", err, "Could not start checkout.");
  }
}
