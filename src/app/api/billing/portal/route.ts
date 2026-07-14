import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUserId } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/abuse";
import {
  createStripeBillingAdapter,
  createSupabaseEntitlementStore,
  resolveStripeConfig,
  stripeConfigured,
} from "@/lib/billing";
import { serverErrorJson } from "@/lib/api/errors";

/**
 * Open the Stripe Billing Portal for the signed-in user (issue #64) — manage /
 * upgrade / cancel. POST → `{ url }`. The settings "Manage billing" button targets
 * this. 400 when the user has no Stripe customer yet (never subscribed); 503 when
 * Stripe isn't configured. Test mode.
 */
export async function POST(request: NextRequest) {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const limited = await enforceRateLimit(request, userId);
  if (limited) return limited;

  if (!stripeConfigured()) {
    return NextResponse.json({ error: "Billing is not available yet." }, { status: 503 });
  }

  try {
    const customerId = await createSupabaseEntitlementStore(
      createAdminClient(),
    ).customerIdForUser(userId);
    if (!customerId) {
      return NextResponse.json(
        { error: "No billing account yet — subscribe first." },
        { status: 400 },
      );
    }

    const adapter = await createStripeBillingAdapter(resolveStripeConfig());
    const { url } = await adapter.createPortalSession({
      customerId,
      returnUrl: `${request.nextUrl.origin}/settings`,
    });
    return NextResponse.json({ url }, { status: 200 });
  } catch (err) {
    return serverErrorJson("billing.portal", err, "Could not open the billing portal.");
  }
}
