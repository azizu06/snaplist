import { after } from "next/server";
import { wakePipelineWorker } from "@/lib/pipeline-queue/wake";
import { handleMobileItemSubmissionRequest } from "./handler";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Authenticated native multipart item submission. */
export async function POST(request: Request): Promise<Response> {
  const response = await handleMobileItemSubmissionRequest(request);
  if (response.status === 202) {
    after(() => wakePipelineWorker({
      origin: process.env.SNAPLIST_PUBLIC_ORIGIN,
      secret: process.env.CRON_SECRET,
    }));
  }
  return response;
}
