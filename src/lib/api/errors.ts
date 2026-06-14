import { NextResponse } from "next/server";

/**
 * Never return a raw error message to an API client. Supabase/Postgres and
 * third-party error strings can embed column names, constraint details, type-cast
 * failures, or RLS hints — verbose-error reconnaissance (CWE-209, issue #57). The
 * real error is logged SERVER-SIDE; the client gets a generic message.
 *
 * Centralized as the single chokepoint so client responses stay opaque by
 * convention; the structured-logging / Sentry sink replaces `console.error` in #62.
 */
export function logServerError(context: string, err: unknown): void {
  // eslint-disable-next-line no-console -- server-side diagnostics; #62 swaps the sink.
  console.error(`[${context}]`, err);
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
