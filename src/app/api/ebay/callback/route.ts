import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { getUserId } from "@/lib/auth";
import { logEvent } from "@/lib/observability";
import { createClient } from "@/lib/supabase/server";
import {
  exchangeAuthorizationCode,
  fetchEbayIdentity,
  saveEbayConnection,
  EbayApiError,
} from "@/lib/marketplace/ebay";
import { classifyCallback } from "@/lib/marketplace/ebay/callback-outcome";
import { STATE_COOKIE } from "../connect/route";

/**
 * eBay OAuth callback (issue #17). eBay sends the seller's browser here (the
 * URL registered against the keyset's RuName) with ?code=...&state=... — or
 * with ?error=...&error_description=... when consent fails or is declined.
 *
 * Branching (eBay error → CSRF state → code) lives in the pure, contract-
 * tested `classifyCallback`; the state comparison happens BEFORE the code is
 * ever used, so a forged callback (CSRF) can't bind an attacker's eBay account
 * to a victim's SnapList session. The connection row is written with the
 * request's USER-SCOPED client — RLS, not route logic, pins it to the
 * signed-in seller.
 *
 * Every exit emits one structured `ebay.callback` line (no tokens, no state
 * values, no codes) so a production failure is diagnosable from logs alone.
 */
export async function GET(request: NextRequest) {
  const fail = (message: string) =>
    NextResponse.redirect(
      new URL(`/settings?error=${encodeURIComponent(message)}`, request.url),
    );

  const userId = await getUserId();
  if (!userId) {
    logEvent("ebay.callback", { ok: false, reason: "no_session" });
    return NextResponse.redirect(new URL("/login?next=/settings", request.url));
  }

  const cookieStore = await cookies();
  const expectedState = cookieStore.get(STATE_COOKIE)?.value ?? null;
  cookieStore.delete(STATE_COOKIE); // single-use either way

  const outcome = classifyCallback({
    error: request.nextUrl.searchParams.get("error"),
    errorDescription: request.nextUrl.searchParams.get("error_description"),
    code: request.nextUrl.searchParams.get("code"),
    state: request.nextUrl.searchParams.get("state"),
    expectedState,
  });

  if (outcome.kind !== "ok") {
    logEvent("ebay.callback", { ok: false, ...outcome.logFields });
    return fail(outcome.failMessage);
  }

  try {
    const grant = await exchangeAuthorizationCode(outcome.code, process.env);
    const identity = await fetchEbayIdentity(grant.accessToken, process.env);
    const supabase = await createClient();
    await saveEbayConnection(supabase, userId, grant, identity);
    logEvent("ebay.callback", {
      ok: true,
      reason: "connected",
      hasIdentity: Boolean(identity?.userId ?? identity?.username),
      scopes: grant.scopes.length,
    });
  } catch (err) {
    // The OAuth exchange/identity steps throw EbayApiError with an author-controlled,
    // user-actionable message — safe to surface. saveEbayConnection throws a plain
    // Error wrapping the raw Supabase upsert error (column/constraint/RLS detail),
    // which must NOT reach the client via the redirect param (CWE-209, #57).
    if (err instanceof EbayApiError) {
      logEvent("ebay.callback", { ok: false, reason: "exchange_failed", message: err.message });
      return fail(err.message);
    }
    logEvent("ebay.callback", {
      ok: false,
      reason: "persist_failed",
      error: err instanceof Error ? err.message : String(err),
    });
    return fail("Couldn't save your eBay connection. Please try again.");
  }

  return NextResponse.redirect(new URL("/settings?ebay=connected", request.url));
}
