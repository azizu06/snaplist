import { createMobileApiHandler } from "@/lib/mobile-api";
import { unavailableWorker } from "../mobile-api-composition";

export const runtime = "nodejs";

const handler = createMobileApiHandler({
  // `/v1/health` is the one unauthenticated mobile path, so this route composes
  // no verification capability at all. The handler never reaches it for this
  // pathname; anything else routed here fails closed rather than passing
  // unverified.
  async authenticate() {
    throw new Error("The health route holds no authentication capability.");
  },
  worker: unavailableWorker("health"),
});

/** Unauthenticated native reachability and API-version probe. */
export function GET(request: Request): Promise<Response> {
  return handler(request);
}
