import { NextResponse } from "next/server";
import { logServerError } from "@/lib/api/errors";
import { runInternalPipelineMaintenance } from "@/lib/pipeline-operations/internal";

export const maxDuration = 300;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return !!secret && request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Scheduler-neutral, fail-closed maintenance entry point.
 *
 * Scheduler-neutral means both methods, for the same reason the worker route
 * answers both: Vercel Cron only ever issues GET, while the owner-only pg_cron
 * template in `supabase/templates/pipeline-operations-cron.sql` POSTs through
 * pg_net. Answering only one of them makes the other scheduler's invocation a
 * 405 that runs no retention. Authority is identical on both paths.
 */
async function handle(request: Request): Promise<NextResponse> {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json(
      { error: "Pipeline maintenance is not configured." },
      { status: 503 },
    );
  }
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    return NextResponse.json(await runInternalPipelineMaintenance());
  } catch (error) {
    logServerError("pipeline.maintenance", error);
    return NextResponse.json(
      { error: "Pipeline maintenance failed." },
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
