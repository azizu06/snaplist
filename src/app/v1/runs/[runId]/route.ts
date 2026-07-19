import { handleMobileRunRequest } from "../handler";

export const runtime = "nodejs";

/** Native bearer-authenticated durable-run detail. */
export function GET(request: Request): Promise<Response> {
  return handleMobileRunRequest(request);
}
