import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { getUserId } from "@/lib/auth";
import { buildAuthorizeUrl } from "@/lib/marketplace/ebay";

/**
 * Start the per-user eBay OAuth flow (issue #17): mint a CSRF state, remember
 * it in an httpOnly cookie, and send the seller to eBay's consent screen.
 * eBay redirects back to /api/ebay/callback (the URL registered against the
 * keyset's RuName in the developer portal).
 */

export const STATE_COOKIE = "ebay_oauth_state";

export async function GET(request: NextRequest) {
  const userId = await getUserId();
  if (!userId) {
    return NextResponse.redirect(new URL("/login?next=/settings", request.url));
  }

  const state = randomBytes(16).toString("base64url");
  let authorizeUrl: string;
  try {
    authorizeUrl = buildAuthorizeUrl(process.env, state);
  } catch (err) {
    const message = err instanceof Error ? err.message : "eBay OAuth misconfigured.";
    return NextResponse.redirect(
      new URL(`/settings?error=${encodeURIComponent(message)}`, request.url),
    );
  }

  const cookieStore = await cookies();
  cookieStore.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/ebay",
    maxAge: 600,
  });

  return NextResponse.redirect(authorizeUrl);
}
