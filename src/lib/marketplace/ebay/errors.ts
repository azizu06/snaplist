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
 * Is this publish failure an eBay AUTH failure — an expired/invalid token the
 * seller fixes by reconnecting eBay in Settings? Two shapes qualify:
 *  - a Sell API call rejected with HTTP 401 (invalid/expired access token), or
 *  - the refresh-token grant rejected with the OAuth `invalid_grant` error
 *    (eBay returns that as HTTP 400 from the token endpoint — the refresh token
 *    itself expired or was revoked).
 * Everything else (validation payloads, 5xx, non-eBay errors) is NOT auth and
 * keeps its own message. Pure and unit-tested — the seam both publish entry
 * points classify through so their copy can never drift.
 */
export function isEbayAuthError(err: unknown): boolean {
  if (!(err instanceof EbayApiError)) return false;
  if (err.status === 401) return true;
  if (typeof err.body !== "object" || err.body === null) return false;
  return (err.body as { error?: unknown }).error === "invalid_grant";
}
