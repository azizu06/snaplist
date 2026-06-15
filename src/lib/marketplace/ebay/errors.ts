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
export class PublishValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishValidationError";
  }
}
