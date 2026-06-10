import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getEnv } from "@/lib/env";

/**
 * Service-role Supabase client. BYPASSES RLS — use only in trusted server-only code
 * paths (admin tasks, seeding, cron, the eBay account-deletion handler, tests).
 *
 * SECURITY GUARDS:
 *  - `import "server-only"` makes any attempt to import this from a Client Component
 *    a build error, so the service-role key can never be bundled into the browser.
 *  - Throws if SUPABASE_SERVICE_ROLE_KEY is absent rather than silently degrading.
 *  - Sessions are NOT persisted/auto-refreshed — this is a stateless privileged
 *    client, not a user session.
 *
 * NEVER expose the returned client (or its key) to any client-reachable response.
 */
export function createAdminClient() {
  const env = getEnv();
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is required to create the admin (service-role) client.",
    );
  }

  return createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );
}
