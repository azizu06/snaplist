import { handleIncludedOfferRequest } from "../../handler";

export const runtime = "nodejs";

/** Claim-scoped status read; a claim id alone never discloses another tenant. */
export function GET(request: Request): Promise<Response> {
  return handleIncludedOfferRequest(request);
}
