import { handleMobileItemSubmissionRequest } from "./handler";

export const runtime = "nodejs";

/** Authenticated native multipart item submission. */
export function POST(request: Request): Promise<Response> {
  return handleMobileItemSubmissionRequest(request);
}
