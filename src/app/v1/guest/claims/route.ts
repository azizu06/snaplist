import { logServerError } from "@/lib/api/errors";
import { createInternalGuestRecoveryCapabilities } from "@/lib/guest-recovery/internal";
import { createMobileApiHandler } from "@/lib/mobile-api";
import {
  clerkPrincipal,
  unavailableWorker,
  verifyGuestClaimHandoff,
} from "../../mobile-api-composition";

export const runtime = "nodejs";

/**
 * The recovery service is intentionally composed per request. A missing
 * server-only Supabase capability becomes the handler's 503, never an
 * import-time failure for this App Router endpoint.
 */
function configuredGuestClaimRecovery() {
  try {
    return createInternalGuestRecoveryCapabilities().claim;
  } catch (error) {
    logServerError("mobile-api.guest-claim.compose", error);
    return undefined;
  }
}

/** Claims a verified App Attest handoff into the authenticated Clerk account. */
export function POST(request: Request): Promise<Response> {
  return createMobileApiHandler({
    authenticate: clerkPrincipal,
    claimGuestRecovery: configuredGuestClaimRecovery(),
    verifyGuestClaimHandoff,
    worker: unavailableWorker("guest claim"),
  })(request);
}
