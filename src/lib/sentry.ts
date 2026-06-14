import { logEvent, type LogFields } from "./observability";

/**
 * Sentry error tracking (issue #62), layered on the structured logger (#18). It is
 * an OPTIONAL, DSN-GATED sink: with no `SENTRY_DSN` it is fully inert, so dev and
 * the offline test suite never touch it and the app runs without a Sentry account.
 *
 * `@sentry/node` is loaded ONLY via a dynamic import inside `initSentry` (called
 * once, server-side, from `instrumentation.ts`). It is never a static import, so it
 * can never reach a client bundle (the `node:`-deps-in-the-browser failure class).
 * `captureError` is synchronous and uses the module cached at init — a no-op until
 * a DSN is configured.
 *
 * Field discipline mirrors `observability.ts`: log IDENTIFIERS and SIGNALS, never
 * photo contents, listing copy, tokens, or anything a user typed.
 */

type SentryModule = typeof import("@sentry/node");

let sentry: SentryModule | null = null;
let enabled = false;

/**
 * Initialize Sentry once if a DSN is configured. Returns whether it is now active.
 * Idempotent. Async because it dynamically imports the SDK (keeping it out of every
 * static graph). Call from `instrumentation.ts` `register()` on the Node runtime.
 */
export async function initSentry(
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  if (enabled) return true;
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return false; // DSN-gated: no DSN -> inert
  sentry = await import("@sentry/node");
  sentry.init({
    dsn,
    environment: env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV || "development",
    // Errors only for now — performance tracing is a separate, costlier opt-in.
    tracesSampleRate: 0,
  });
  enabled = true;
  return true;
}

/** Report an exception to Sentry when configured; a safe no-op otherwise. */
export function captureError(error: unknown, context?: Record<string, unknown>): void {
  if (!enabled || !sentry) return;
  sentry.captureException(error, context ? { extra: context } : undefined);
}

/** True once a DSN has initialized Sentry. Exported for tests / health checks. */
export function isSentryEnabled(): boolean {
  return enabled;
}

/**
 * The unified server-side error chokepoint: emit a structured `ok:false` log line
 * AND report to Sentry (when configured). Use this in `catch` blocks across API
 * routes, server actions, and server components so every handled internal failure
 * is both greppable in logs and grouped/alerted in Sentry — without ever leaking
 * raw detail to the client (the caller still returns/redirects a generic message).
 */
export function reportServerError(
  context: string,
  error: unknown,
  fields: LogFields = {},
): void {
  logEvent(context, { ok: false, error: errorMessage(error), ...fields });
  captureError(error, { context, ...fields });
}

/** Best-effort message extraction — handles Error, Supabase-style `{ message }`, and primitives. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    error !== null &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}
