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
// /dev is the screenshot preview harness — its pages hard-404 in production
// (see src/app/dev/preview), so whitelisting it here is dev-only in effect.
// /api/ebay/account-deletion is called server-to-server by eBay (no session);
// the route gates itself via eBay's signature verification (412 otherwise).
const isPublic = createRouteMatcher([
  "/",
  "/tour",
  "/features",
  "/pricing",
  "/about",
  "/login(.*)",
  "/api/health",
  "/api/ebay/account-deletion",
  "/dev(.*)",
]);

export const proxy = clerkMiddleware(async (auth, request) => {
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
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|mp4|webm|mov)$).*)",
  ],
};
