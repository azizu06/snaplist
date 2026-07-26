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

  // Fail the server before it can serve anything if the LLM provider was not
  // chosen (#501). The registry refuses to resolve an unset LLM_PROVIDER outside
  // local development, so this only surfaces that refusal at boot instead of at
  // the first seller request. Checked before Sentry so a misconfigured deploy
  // stops immediately rather than initializing around a broken config.
  const { llmProviderConfigError } = await import("./lib/llm/registry");
  const providerError = llmProviderConfigError();
  if (providerError) throw new Error(providerError);

  const { initSentry } = await import("./lib/sentry");
  await initSentry();
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
