import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { getUserId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  exchangeAuthorizationCode,
  fetchEbayIdentity,
  saveEbayConnection,
} from "@/lib/marketplace/ebay";
import { STATE_COOKIE } from "../connect/route";

/**
 * eBay OAuth callback (issue #17). eBay sends the seller's browser here (the
 * URL registered against the keyset's RuName) with ?code=...&state=...
 *
 * Order of checks matters: the state cookie comparison happens BEFORE the code
 * is ever used, so a forged callback (CSRF) can't bind an attacker's eBay
 * account to a victim's SnapList session. The connection row is written with
 * the request's USER-SCOPED client — RLS, not route logic, pins it to the
 * signed-in seller.
 */
export async function GET(request: NextRequest) {
  const fail = (message: string) =>
    NextResponse.redirect(
      new URL(`/settings?error=${encodeURIComponent(message)}`, request.url),
    );

  const userId = await getUserId();
  if (!userId) {
    return NextResponse.redirect(new URL("/login?next=/settings", request.url));
  }

  const cookieStore = await cookies();
  const expectedState = cookieStore.get(STATE_COOKIE)?.value;
  cookieStore.delete(STATE_COOKIE); // single-use either way

  const state = request.nextUrl.searchParams.get("state");
  const code = request.nextUrl.searchParams.get("code");

  if (!expectedState || !state || state !== expectedState) {
    return fail("eBay connection failed: state mismatch — please try again.");
  }
  if (!code) {
    // Seller clicked "decline" on the consent screen, or eBay errored.
    return fail("eBay connection was cancelled before completing.");
  }

  try {
    const grant = await exchangeAuthorizationCode(code, process.env);
    const identity = await fetchEbayIdentity(grant.accessToken, process.env);
    const supabase = await createClient();
    await saveEbayConnection(supabase, userId, grant, identity);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "eBay connection failed.";
    return fail(message);
  }

  return NextResponse.redirect(new URL("/settings?ebay=connected", request.url));
}
