import { NextResponse } from "next/server";
import type { LogFields } from "@/lib/observability";
import { reportServerError } from "@/lib/sentry";

/**
 * Never return a raw error message to an API client. Supabase/Postgres and
 * third-party error strings can embed column names, constraint details, type-cast
 * failures, or RLS hints — verbose-error reconnaissance (CWE-209, issue #57). The
 * real error is logged SERVER-SIDE; the client gets a generic message.
 *
 * Centralized as the single chokepoint so client responses stay opaque by
 * convention. The real error is recorded via `reportServerError` (#62): a
 * structured `ok:false` log line plus a Sentry capture when a DSN is configured.
 */
export function logServerError(
  context: string,
  err: unknown,
  fields?: LogFields,
): void {
  reportServerError(context, err, fields);
}

/** Log the real error server-side and return a GENERIC 500 JSON response. */
export function serverErrorJson(
  context: string,
  err: unknown,
  clientMessage: string,
): NextResponse {
  logServerError(context, err);
  return NextResponse.json({ error: clientMessage }, { status: 500 });
}
