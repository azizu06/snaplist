import { logServerError } from "@/lib/api/errors";
import { createMobileApiHandler } from "@/lib/mobile-api";
import { createConfiguredSupabasePushDeviceTokenStore } from "@/lib/push-device-tokens/store";
import { guestOrClerkPrincipal, unavailableWorker } from "../mobile-api-composition";

export const runtime = "nodejs";

/**
 * Composed per request rather than at module scope: an unconfigured deployment
 * must answer 503 on this one route, not crash every route in the file at
 * import time. Returning undefined is how the handler learns to decline.
 */
function configuredDeviceTokenStore() {
  const supabaseURL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey =
    process.env.SUPABASE_PUBLISHABLE_KEY?.trim()
    || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!supabaseURL || !anonKey) return undefined;
  return createConfiguredSupabasePushDeviceTokenStore({ anonKey, supabaseURL });
}

export function POST(request: Request): Promise<Response> {
  return createMobileApiHandler({
    // A guest reaches a first submission before anyone else does, and the
    // registration is stored under the guest identity the database re-keys on
    // account claim, so this route must accept both kinds of caller.
    authenticate: guestOrClerkPrincipal,
    deviceTokens: configuredDeviceTokenStore(),
    reportError: logServerError,
    worker: unavailableWorker("device tokens"),
  })(request);
}
