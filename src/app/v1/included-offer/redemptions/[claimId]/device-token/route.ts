import { handleIncludedOfferRequest } from "../../../handler";

export const runtime = "nodejs";

/**
 * The bounded rendezvous. Carries a fresh ephemeral DeviceCheck token and fresh
 * App Attest proof; the token is used for one Apple call and never persisted.
 */
export function POST(request: Request): Promise<Response> {
  return handleIncludedOfferRequest(request);
}
