import { handleMobileRunRequest } from "./handler";

export const runtime = "nodejs";

/** Native bearer-authenticated, snapshot-stable durable-run collection. */
export function GET(request: Request): Promise<Response> {
  return handleMobileRunRequest(request);
}
