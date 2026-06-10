import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Auth-session proxy (Next.js 16 `proxy` convention — the renamed `middleware`).
 * Supabase SSR canonical pattern. Runs on every matched request to:
 *   1. Refresh the user's session cookies (so Server Components see a live session).
 *   2. Gate the protected app surface — unauthenticated users hitting anything other
 *      than the public routes (/login, /auth/*, /api/health, the landing page) are
 *      redirected to /login.
 *
 * It reads NEXT_PUBLIC_* directly (not getEnv()) so the proxy doesn't depend on
 * server-only required vars like OPENAI_API_KEY — mirrors src/lib/supabase/client.ts.
 * It uses the public ANON key only; RLS (never the key) is what gates data access.
 *
 * Do NOT add code between createServerClient and getUser() — a subtle mistake there
 * causes random sign-outs (documented Supabase footgun). The proxy runtime is
 * nodejs (Next 16 proxy does not support edge), which is fine here.
 */
const PUBLIC_PATHS = ["/login", "/auth", "/api/health"];

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPublic =
    pathname === "/" ||
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Must return supabaseResponse as-is so refreshed cookies reach the browser.
  return supabaseResponse;
}

export const config = {
  // Match everything except Next internals and static asset files.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
