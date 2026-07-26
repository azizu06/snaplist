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
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { initSentry, captureError } = await import("./lib/sentry");
  await initSentry();

  // Reject startup if the LLM provider was not chosen (#501). The registry
  // refuses to resolve an unset LLM_PROVIDER outside local development; raising
  // it here surfaces the refusal when the server starts rather than on the first
  // seller request.
  //
  // How hard this stops depends on the host, so do not treat it as THE fence.
  // Under `next start` it fails `prepare()` and every route then 500s for the
  // life of the process. On Vercel, registration is not awaited, so this only
  // surfaces as an unhandled rejection and requests keep serving. Either way the
  // guarantee that holds everywhere is `resolveProvider` throwing when a model is
  // resolved — see ADR-0002. Sentry is initialized FIRST so the config failure
  // reaches alerting instead of only the platform's raw logs.
  const { llmProviderConfigError } = await import("./lib/llm/registry");
  const providerError = llmProviderConfigError();
  if (providerError) {
    const error = new Error(providerError);
    captureError(error, { phase: "instrumentation.register" });
    throw error;
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
