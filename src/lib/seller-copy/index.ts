/**
 * Objective seller-visible copy rules shared by lean-MVP launch surfaces.
 *
 * This contract deliberately checks only deterministic failures. It does not
 * rewrite seller-authored text or authoritative platform wording. Generated
 * listing/export text instead retries within its existing budget and falls
 * back to facts already validated for the item.
 */
export const STARTING_PRICE_COPY = "Starting price estimate";
export const NO_VERIFIED_SOLD_MATCHES_COPY = "No verified sold matches found.";

const COPY_VIOLATION_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: "typographic-dash", pattern: /[\u2013\u2014]/u },
  { code: "contrast-formula", pattern: /\bnot just\b/i },
  {
    code: "chatbot-opening",
    pattern: /^\s*(?:sure|certainly|absolutely|of course)[!,.\s]/i,
  },
  {
    code: "unsupported-promise",
    pattern:
      /\b(?:ships? fast|fast shipping|free shipping|shipping available|local pickup|limited time|must-?have|hurry|act now)\b/i,
  },
  {
    code: "internal-error",
    pattern:
      /\b(?:NoObjectGeneratedError|PostgrestError|PGRST\d+|SQLSTATE|stack trace|database error|provider error|queue|worker|lease)\b/i,
  },
];

const TITLE_CONNECTIVES = new Set([
  "a", "an", "the", "and", "or", "for", "with", "of", "in", "on", "by", "to", "condition",
]);
const TITLE_TOKEN_PATTERN = /[a-z0-9]+(?:[.\-][a-z0-9]+)*/g;

/** Return every objective copy-contract rule the supplied seller-visible text violates. */
export function sellerCopyViolations(text: string): string[] {
  return COPY_VIOLATION_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(
    ({ code }) => code,
  );
}

/**
 * Return objective violations in a generated marketplace title. Title words may
 * be facts only when they occur in the validated item core; ordinary connective
 * words remain allowed. This catches digit-free inventions such as "includes
 * charger" without guessing whether prose in an editable description is factual.
 */
export function sellerTitleViolations(
  title: string,
  coreValues: Array<string | undefined>,
): string[] {
  const violations = sellerCopyViolations(title);
  const allowedTokens = new Set(
    coreValues
      .flatMap((value) => {
        const core = safeSellerCoreValue(value)?.toLowerCase();
        return core
          ? [
              ...(core.match(TITLE_TOKEN_PATTERN) ?? []),
              ...(core.match(/[a-z0-9]+/g) ?? []),
            ]
          : [];
      }),
  );
  const hasUnsupportedFact = (title.toLowerCase().match(TITLE_TOKEN_PATTERN) ?? []).some(
    (token) => !allowedTokens.has(token) && !TITLE_CONNECTIVES.has(token),
  );
  if (hasUnsupportedFact) violations.push("unsupported-title-fact");
  return violations;
}

/** True only when a core value can safely appear in an app-built seller string unchanged. */
export function safeSellerCoreValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && sellerCopyViolations(trimmed).length === 0
    ? trimmed
    : undefined;
}
