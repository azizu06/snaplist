import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runRepriceSweep } from "@/lib/reprice";
import { logServerError } from "@/lib/api/errors";

/**
 * Scheduled stale-inventory repricing sweep (issue #102).
 *
 * SCHEDULING: this repo deploys on Vercel, so the schedule lives in
 * `vercel.json` (`crons` → daily GET here); Vercel authenticates its cron
 * invocations with `Authorization: Bearer ${CRON_SECRET}` when that env var is
 * set. The route is scheduler-agnostic on purpose — a Supabase pg_cron +
 * pg_net job (the PRD's "Supabase cron") can POST the same header at the same
 * URL and nothing here changes. Batch size / staleness window / drift
 * threshold are env-tunable (REPRICE_*, see src/lib/reprice/policy.ts).
 *
 * AUTH: constant-time-ish bearer check against CRON_SECRET. With the secret
 * UNSET the route refuses to run (503) — a deploy can never expose an
 * unauthenticated job trigger. No user session exists here, so the sweep runs
 * on the service-role client (a documented trusted path, admin.ts); the sweep
 * itself pins user_id on every row it touches.
 */

export const maxDuration = 300;

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

async function handle(request: NextRequest): Promise<NextResponse> {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json(
      { error: "Repricing cron is not configured (CRON_SECRET unset)." },
      { status: 503 },
    );
  }
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const summary = await runRepriceSweep(createAdminClient());
    // Outcome details stay server-side (logged by the sweep); the response is
    // the operational summary the scheduler dashboard shows.
    return NextResponse.json({
      scanned: summary.scanned,
      suggested: summary.suggested,
      autoApplied: summary.autoApplied,
      unchanged: summary.unchanged,
      failed: summary.failed,
    });
  } catch (err) {
    logServerError("cron.reprice", err);
    return NextResponse.json({ error: "Reprice sweep failed." }, { status: 500 });
  }
}

/** Vercel cron invokes with GET. */
export async function GET(request: NextRequest) {
  return handle(request);
}

/** Supabase pg_cron / manual triggers may POST. */
export async function POST(request: NextRequest) {
  return handle(request);
}
