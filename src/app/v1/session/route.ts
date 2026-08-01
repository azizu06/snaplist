import { createMobileApiHandler } from "@/lib/mobile-api";
import { clerkPrincipal, unavailableWorker } from "../mobile-api-composition";

export const runtime = "nodejs";

const handler = createMobileApiHandler({
  authenticate: clerkPrincipal,
  worker: unavailableWorker("session"),
});

/** Native bearer-authenticated echo of the verified Clerk identity. */
export function GET(request: Request): Promise<Response> {
  return handler(request);
}
