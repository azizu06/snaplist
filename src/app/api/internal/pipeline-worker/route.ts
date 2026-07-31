import { NextResponse } from "next/server";
import { logServerError } from "@/lib/api/errors";
import { createInternalPipelineWorker } from "@/lib/pipeline-queue/internal";

export const maxDuration = 300;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return !!secret && request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Scheduler-neutral, fail-closed worker entry point. Issue #162 may point hosted
 * Cron at this route later; this slice neither creates nor activates that schedule.
 *
 * Scheduler-neutral means both methods: Vercel Cron only ever issues GET, while
 * the Supabase pg_cron template in `supabase/templates/pipeline-operations-cron.sql`
 * POSTs through pg_net. Answering only one of them makes the other scheduler's
 * invocation a 405 that drains nothing. Authority is identical on both paths.
 */
async function handle(request: Request): Promise<NextResponse> {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json(
      { error: "Pipeline worker is not configured." },
      { status: 503 },
    );
  }
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const summary = await createInternalPipelineWorker().consume();
    return NextResponse.json(summary);
  } catch (error) {
    logServerError("pipeline.worker", error);
    return NextResponse.json({ error: "Pipeline worker failed." }, { status: 500 });
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
