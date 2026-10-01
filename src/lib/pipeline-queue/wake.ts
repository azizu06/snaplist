import "server-only";
import { isPublicHttpsOrigin } from "@/lib/public-origin";
import { describeErrorForLog } from "./log-safe-error";

/**
 * Best-effort wake signal only: the queue and existing cron own recovery.
 * The origin is operator configuration, never a request URL/Host header.
 * A separate HTTP invocation runs the existing leased worker; intake does
 * not process the item or acquire tenant-domain authority.
 */
export async function wakePipelineWorker(input: {
  origin: string | undefined;
  secret: string | undefined;
}): Promise<void> {
  try {
    const origin = input.origin?.trim();
    if (!origin || !input.secret) throw new Error("Worker wake is not configured.");
    const url = new URL(origin);
    const localOrigin = process.env.NODE_ENV !== "production"
      && url.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      && url.origin === origin;
    if (!isPublicHttpsOrigin(origin) && !localOrigin) {
      throw new Error("Worker wake origin is invalid.");
    }
    const response = await fetch(`${url.origin}/api/internal/pipeline-worker`, {
      method: "POST",
      headers: { authorization: `Bearer ${input.secret}`, "x-snaplist-worker-wake": "1" },
      redirect: "error",
      cache: "no-store",
      // Wait for admission only. The worker tracks processing with after() and
      // retains its own duration budget even if dispatch fails or times out.
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    if (!response.ok) {
      console.error(`[pipeline.worker.wake] http_status=${response.status}`);
    }
  } catch (error) {
    // Fetch errors can embed the origin/credential. Never log their text.
    console.error("[pipeline.worker.wake] dispatch_failed", describeErrorForLog(error));
  }
}
