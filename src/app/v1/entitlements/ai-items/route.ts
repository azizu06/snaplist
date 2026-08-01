import { createMobileApiHandler } from "@/lib/mobile-api";
import {
  clerkPrincipal,
  configuredSubscriptionBridge,
  unavailableWorker,
} from "../../mobile-api-composition";

export const runtime = "nodejs";

/**
 * Composed per request because the subscription bridge needs the service-role
 * client, whose absence must degrade to the handler's honest 503 instead of an
 * import-time crash.
 */
export function GET(request: Request): Promise<Response> {
  return createMobileApiHandler({
    authenticate: clerkPrincipal,
    subscriptionBridge: configuredSubscriptionBridge(),
    worker: unavailableWorker("AI-item entitlement"),
  })(request);
}
