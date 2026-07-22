import { handleMobileEbayOauthRequest } from "../handler";

export const runtime = "nodejs";

/** Authenticated creation of a tenant-bound eBay Sandbox OAuth session. */
export function POST(request: Request): Promise<Response> {
  return handleMobileEbayOauthRequest(request);
}
