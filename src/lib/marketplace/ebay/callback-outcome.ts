import type { LogFields } from "@/lib/observability";

/**
 * Pure pre-exchange branching for the eBay OAuth callback (issue #17
 * hardening). The route was un-diagnosable in production: eBay's own
 * ?error=... reports were silently dropped, and every failure collapsed into
 * an unlogged redirect. This classifier decides the outcome BEFORE any token
 * call and carries the log fields that make one structured line enough to
 * debug.
 *
 * Branch order is security-ordered, mirroring the route:
 *   1. eBay-reported error (?error=) — decline/server errors arrive this way
 *   2. CSRF state validation — before the code is ever trusted
 *   3. code presence
 *
 * Log-field discipline: booleans and eBay's machine-readable error code only.
 * Never the state values or the authorization code (logs must stay
 * secret-free).
 */

export interface CallbackParams {
  /** eBay's OAuth error code (?error=access_denied etc.), if any. */
  error: string | null;
  /** eBay's human-readable ?error_description, if any. */
  errorDescription: string | null;
  code: string | null;
  state: string | null;
  /** The CSRF state minted at /api/ebay/connect (httpOnly cookie). */
  expectedState: string | null;
}

export type CallbackOutcome =
  | { kind: "ok"; code: string }
  | { kind: "ebay_error"; failMessage: string; logFields: LogFields }
  | { kind: "state_mismatch"; failMessage: string; logFields: LogFields }
  | { kind: "cancelled"; failMessage: string; logFields: LogFields };

export function classifyCallback(params: CallbackParams): CallbackOutcome {
  const { error, errorDescription, code, state, expectedState } = params;

  if (error) {
    const detail = errorDescription ? `: ${errorDescription}` : "";
    return {
      kind: "ebay_error",
      failMessage: `eBay returned an error (${error}${detail}). Please try connecting again.`,
      logFields: {
        reason: "ebay_error",
        ebayError: error,
        ebayErrorDescription: errorDescription ?? undefined,
      },
    };
  }

  if (!expectedState || !state || state !== expectedState) {
    return {
      kind: "state_mismatch",
      failMessage:
        "eBay connection failed: state mismatch. Please try again.",
      logFields: {
        reason: "state_mismatch",
        hadCookie: Boolean(expectedState),
        hadParam: Boolean(state),
      },
    };
  }

  if (!code) {
    return {
      kind: "cancelled",
      failMessage: "eBay connection was cancelled before completing.",
      logFields: { reason: "cancelled" },
    };
  }

  return { kind: "ok", code };
}
