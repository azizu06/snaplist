import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getEnv } from "@/lib/env";

/**
 * Server-side Supabase client for the Next.js App Router (Server Components, Route
 * Handlers, Server Actions).
 *
 * SECURITY: uses the public anon key and the request's auth cookies, so every query
 * runs AS THE SIGNED-IN USER and is subject to RLS — the tenancy seam. It never
 * uses the service-role key. The anon key is safe server-side because RLS, not the
 * key, is what gates access.
 *
 * The cookie getAll/setAll handlers follow the current @supabase/ssr API. setAll is
 * wrapped in try/catch because it throws when called from a Server Component (where
 * cookies are read-only); session refresh then happens in middleware/route handlers
 * instead. This is the documented pattern.
 */
export async function createClient() {
  // Read the request cookie store BEFORE touching env: during `next build`'s
  // prerender pass, `cookies()` is what bails a route out to dynamic rendering.
  // Validating env first would throw inside the prerender worker on secret-less
  // builds (CI, Docker image build) before that bailout can happen.
  const cookieStore = await cookies();
  const env = getEnv();

  return createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Called from a Server Component — cookies are read-only here.
            // Safe to ignore: middleware/route handlers refresh the session.
          }
        },
      },
    },
  );
}
