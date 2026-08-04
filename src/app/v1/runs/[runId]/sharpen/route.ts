import { handleMobileRunRequest } from "../../handler";

export const runtime = "nodejs";

/**
 * Native bearer-authenticated guided identity correction ("Sharpen the
 * estimate"): reruns the shared pricing router and confidence composite for a
 * run the caller owns, and commits the coherent result under RLS.
 */
export function POST(request: Request): Promise<Response> {
  return handleMobileRunRequest(request);
}
