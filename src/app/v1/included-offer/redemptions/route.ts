import { handleIncludedOfferRequest } from "../handler";

export const runtime = "nodejs";

/** Opens or resumes the durable account/device claim for the included offer. */
export function POST(request: Request): Promise<Response> {
  return handleIncludedOfferRequest(request);
}
