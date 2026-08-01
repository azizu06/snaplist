import { NextResponse } from "next/server";
import { logServerError } from "@/lib/api/errors";
import { createConfiguredIncludedOfferFence } from "@/lib/included-offer-fence/configured";

export const maxDuration = 300;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return !!secret && request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Advances the single-writer redemption queue by one head claim.
 *
 * Deliberately separate from the pipeline worker: this queue exists to
 * serialize Apple's query-and-set window, which has no compare-and-set, so
 * exactly one claim may hold a clear-device observation at a time. Draining it
 * faster by running several of these concurrently would defeat the fence — the
 * durable writer lease is what actually enforces it, and this entry point is
 * scheduler-neutral for the same reason the pipeline worker is.
 */
async function handle(request: Request): Promise<NextResponse> {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json(
      { error: "The included-offer worker is not configured." },
      { status: 503 },
    );
  }
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const { worker } = createConfiguredIncludedOfferFence();
    const advanced = await worker.advance();
    return NextResponse.json(advanced);
  } catch (error) {
    logServerError("included-offer.worker", error);
    return NextResponse.json(
      { error: "The included-offer worker failed." },
      { status: 500 },
    );
  }
}

/** Vercel Cron invokes with GET. */
export async function GET(request: Request): Promise<NextResponse> {
  return handle(request);
}

/** Supabase pg_cron / pg_net and manual runbook triggers POST. */
export async function POST(request: Request): Promise<NextResponse> {
  return handle(request);
}
