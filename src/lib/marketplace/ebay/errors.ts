/**
 * A user-actionable publish failure — a precondition the seller can fix (no price,
 * no photo, unsupported marketplace currency, missing title/description, wrong
 * platform, not found). Its `message` is SAFE to show to the client.
 *
 * This is the deliberate counterpart to a plain `Error` from `publishListingToEbay`,
 * which wraps INTERNAL detail (Supabase/adapter/upstream) that must be redacted to a
 * generic message at the client boundary (CWE-209, #57). Callers surface
 * `PublishValidationError.message` and redact everything else.
 *
 * Lives in its own module so both `publish.ts` and `map.ts` can throw it without an
 * import cycle.
 */

import { EbayApiError } from "./types";
export class PublishValidationError extends Error {
  /**
   * `cause` carries the INTERNAL failure behind a seller-safe message (for
   * example the eBay Account API error behind "could not read your policies").
   * It is for server-side logging and classification only — never surfaced.
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PublishValidationError";
  }
}

/**
 * The ONE actionable message every publish surface (server action, API route,
 * activity feed) shows for an eBay auth failure. The seller's fix is always the
 * same — reconnect in Settings — so the copy is a constant, not per-caller prose.
 */
export const EBAY_RECONNECT_MESSAGE =
  "eBay connection expired — reconnect eBay in Settings and try again.";

/**
 * eBay's "Access denied — insufficient permissions to fulfill the request",
 * the `ACCESS`-domain entry that actually means the token lacks the scope.
 */
const EBAY_INSUFFICIENT_SCOPE_ERROR_ID = 1100;

/**
 * Is this publish failure an eBay AUTH failure — an expired/invalid token the
 * seller fixes by reconnecting eBay in Settings? Three shapes qualify:
 *  - a Sell API call rejected with HTTP 401 (invalid/expired access token),
 *  - the refresh-token grant rejected with the OAuth `invalid_grant` error
 *    (eBay returns that as HTTP 400 from the token endpoint — the refresh token
 *    itself expired or was revoked), or
 *  - a Sell API call rejected with HTTP 403 because the token's granted scopes
 *    do not cover it. Policy discovery (#47) reads the Sell Account API under
 *    `sell.account.readonly`; a connection minted before that scope joined
 *    `EBAY_OAUTH_SCOPES` still holds a token without it, and reconnecting is
 *    the only fix. Recognised by the OAuth `insufficient_scope` code or by an
 *    eBay `ACCESS`-domain entry carrying `errorId` 1100 ("Access denied",
 *    insufficient permissions) — fields, never message prose. The domain alone
 *    is too broad: eBay also uses `ACCESS` for refusals a reconnect cannot fix
 *    (the application blocked, the marketplace not enabled for the account),
 *    and re-consent for those rotates `connection_generation`, wipes the
 *    seller's policy bindings, and lands them on the same refusal.
 * Everything else (validation payloads, 5xx, non-eBay errors) is NOT auth and
 * keeps its own message. Pure and unit-tested — the seam both publish entry
 * points classify through so their copy can never drift.
 */
export function isEbayAuthError(err: unknown): boolean {
  if (!(err instanceof EbayApiError)) return false;
  if (err.status === 401) return true;
  if (typeof err.body !== "object" || err.body === null) return false;
  const body = err.body as { error?: unknown; errors?: unknown };
  if (body.error === "invalid_grant") return true;
  if (err.status !== 403) return false;
  if (body.error === "insufficient_scope") return true;
  return (
    Array.isArray(body.errors)
    && body.errors.some((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const { domain, errorId } = entry as {
        domain?: unknown;
        errorId?: unknown;
      };
      return domain === "ACCESS" && errorId === EBAY_INSUFFICIENT_SCOPE_ERROR_ID;
    })
  );
}
