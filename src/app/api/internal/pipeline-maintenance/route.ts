import { NextResponse } from "next/server";
import { logServerError } from "@/lib/api/errors";
import { runInternalPipelineMaintenance } from "@/lib/pipeline-operations/internal";

export const maxDuration = 300;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return !!secret && request.headers.get("authorization") === `Bearer ${secret}`;
}

/** Scheduler-neutral, fail-closed maintenance entry point. */
export async function POST(request: Request): Promise<NextResponse> {
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
