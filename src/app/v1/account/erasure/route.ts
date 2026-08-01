import { handleAccountErasureRequest } from "./handler";

export const runtime = "nodejs";

/** Authenticated, strictly reverified, idempotent account erasure. */
export function POST(request: Request): Promise<Response> {
  return handleAccountErasureRequest(request);
}
