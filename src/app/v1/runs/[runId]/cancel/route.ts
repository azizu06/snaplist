import { handleMobileRunRequest } from "../../handler";

export const runtime = "nodejs";

/** Native bearer-authenticated, idempotent cancellation of the same durable run. */
export function POST(request: Request): Promise<Response> {
  return handleMobileRunRequest(request);
}
