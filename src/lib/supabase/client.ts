import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser Supabase client. Uses ONLY the public anon key + public URL — never the
 * service-role key (which would bypass RLS and must never reach the browser).
 *
 * RLS isolates tenants: every query made through this client runs as the
 * signed-in user, so it can only ever see/modify that user's rows.
 *
 * Reads NEXT_PUBLIC_* values directly from the inlined env (these are the only
 * values bundled into client code). The server reads via `getEnv()` in env.ts.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
