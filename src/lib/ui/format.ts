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
 * empty/missing input. A leading word that already carries meaningful casing
 * (e.g. "USB-C", "iPhone") is preserved verbatim instead of being forced —
 * even when that word appears later in an otherwise-lowercase value, as in
 * "good iPhone case" → "Good iPhone case".
 */
export function sentenceCase(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Only the LEADING word decides whether casing is "meaningful" (e.g.
  // "USB-C", "iPhone") versus plain lowercase to force-capitalize. Checking
  // the whole string here would wrongly skip the leading word whenever an
  // unrelated later word happens to carry a capital, e.g. "good iPhone case"
  // must still become "Good iPhone case", not stay "good iPhone case".
  const leadingWord = trimmed.split(/\s/, 1)[0];
  if (/[A-Z]/.test(leadingWord)) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}
