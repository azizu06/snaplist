/**
 * Next.js instrumentation (issue #62). `register()` initializes Sentry once at
 * server boot (DSN-gated → a no-op without `SENTRY_DSN`); `onRequestError`
 * captures every UNHANDLED error thrown while serving a request or rendering a
 * Server Component. Together with `reportServerError` in catch blocks, that covers
 * both handled and unhandled failures.
 *
 * Both hooks are guarded to the Node runtime and dynamically import the Sentry
 * module, so nothing here is bundled for the Edge runtime or the client.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initSentry } = await import("./lib/sentry");
    await initSentry();
  }
}

export async function onRequestError(
  error: unknown,
  request: { path?: string; method?: string },
  context: { routePath?: string; routeType?: string },
): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { captureError } = await import("./lib/sentry");
  // Field discipline: identifiers only — NEVER headers (auth), body, or query.
  captureError(error, {
    path: request?.path,
    method: request?.method,
    routePath: context?.routePath,
    routeType: context?.routeType,
  });
}
