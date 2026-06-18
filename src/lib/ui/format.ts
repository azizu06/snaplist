/**
 * Display formatting helpers for free-text values that reach the UI.
 *
 * Pipeline/LLM output is case-inconsistent ("good" vs "Good", "like new" vs
 * "Like New"). Rather than mutate stored data, normalize at the seam where a
 * value is shown so columns and chips read professionally.
 */

/**
 * Sentence-case a value: trim, then uppercase the first letter and leave the
 * rest as-is (so "good" → "Good", "like new" → "Like new"). Returns null for
 * empty/missing input. The rest of the string is preserved verbatim, which
 * keeps real casing like "USB-C" or "iPhone" intact when it leads.
 */
export function sentenceCase(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}
