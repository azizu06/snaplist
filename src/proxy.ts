import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

/**
 * Auth proxy (Next.js 16 `proxy` convention — the renamed `middleware`), Clerk
 * era (issue #41). clerkMiddleware resolves the session from the request; we
 * gate the protected app surface — unauthenticated users hitting anything other
 * than the public routes are redirected to /login with a `next` return path.
 *
 * RLS (never this proxy) is what gates data access; this is UX-level routing.
 */
// /api/ebay/account-deletion is called server-to-server by eBay (no session);
// the route gates itself via eBay's signature verification (412 otherwise).
// /api/internal/pipeline-worker, /api/internal/pipeline-maintenance and
// /api/internal/included-offer-worker are called by a scheduler that holds no
// Clerk cookie — the same owner-only pg_cron template schedules all three.
// None may be redirected. Vercel Cron
// treats a 3xx as the final response for that invocation and stops; pg_net
// does the opposite and follows it, then records a 200 login page in
// net._http_response. Either way the invocation looks successful while the
// queue is never drained and retention never runs. Every one of these routes
// stays fail-closed on its own — 503 with CRON_SECRET unset, 401 without the
// matching bearer.
const isPublic = createRouteMatcher([
  "/",
  // Public marketing pages resolve without a session, so they must never
  // answer a redirect to /login (issue #191).
  "/pricing",
  "/privacy",
  "/terms",
  "/support",
  "/manifest.webmanifest",
  "/.well-known/apple-app-site-association",
  "/mobile/ebay/oauth",
  "/login(.*)",
  "/signup(.*)",
  "/api/health",
  "/api/app-attest",
  "/api/app-attest/",
  "/api/ebay/account-deletion",
  "/api/internal/pipeline-worker",
  "/api/internal/pipeline-maintenance",
  "/api/internal/included-offer-worker",
]);

export const proxy = clerkMiddleware(async (auth, request) => {
  // eBay arrives without a Clerk cookie; the route's signed state remains the
  // tenant and one-time callback authority.
  if (
    request.method === "GET"
    && request.nextUrl.pathname === "/v1/ebay/oauth/callback"
  ) {
    return NextResponse.next();
  }
  if (isPublic(request)) return NextResponse.next();

  const { userId } = await auth();
  if (!userId) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
});

export const config = {
  // Match everything except Next internals and static asset files.
  matcher: [
    // App Attest authenticates its exact evidence route inside the handler.
    // Native bearer routes authenticate inside their handlers. Keep the whole
    // /v1 surface outside cookie middleware so missing web configuration cannot
    // replace their own HTTP contracts with a login redirect.
    "/((?!_next/static|_next/image|favicon.ico|api/app-attest/?$|v1(?:/|$)|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|mp4|webm|mov)$).*)",
  ],
};
