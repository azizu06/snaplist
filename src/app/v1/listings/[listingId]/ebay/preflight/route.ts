import { handleMobileEbayPublishRequest } from "../../../../mobile-ebay-publish-composition";

export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return handleMobileEbayPublishRequest(request);
}
