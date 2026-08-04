const OAUTH_RESULTS = new Set([
  "connected",
  "declined",
  "cancelled",
  "expired",
  "wrong_tenant",
  "invalid_state",
  "in_progress",
  "failed",
]);

/**
 * Returns the signed server callback result to iOS 17.0-17.3, whose
 * ASWebAuthenticationSession supports only a callback URL scheme. Newer iOS
 * releases intercept the HTTPS callback before this route is requested.
 */
export function GET(request: Request): Response {
  const result = new URL(request.url).searchParams.get("result");
  const destination = new URL("snaplist://ebay/oauth");
  destination.searchParams.set(
    "result",
    result && OAUTH_RESULTS.has(result) ? result : "failed",
  );

  return new Response(null, {
    status: 303,
    headers: { location: destination.toString() },
  });
}
