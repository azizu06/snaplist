import { handleMobileEbayOauthRequest } from "../handler";

export const runtime = "nodejs";

/** Provider redirect that completes one opaque, signed mobile OAuth session. */
export function GET(request: Request): Promise<Response> {
  return handleMobileEbayOauthRequest(request);
}
