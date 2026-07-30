import { handleMobileRunRequest } from "../../handler";

export const runtime = "nodejs";

/** Native bearer-authenticated, idempotent Listing Review save. */
export function PUT(request: Request): Promise<Response> {
  return handleMobileRunRequest(request);
}
