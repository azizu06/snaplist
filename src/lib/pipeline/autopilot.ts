import type { ConfidenceResult } from "../confidence/confidence";

/**
 * Confidence-gated autopilot disposition + seller price override (issue #12).
 *
 * Two pure decisions live here so they are unit-testable with fake data and
 * shared by every consumer (persistence, review UI, future publish):
 *
 *  1. WHERE does a freshly generated listing go? `autopilotEligible` (computed by
 *     the confidence composite: master switch AND score >= threshold) maps onto
 *     the `listings.status` lifecycle — eligible runs are QUEUED for auto-post,
 *     everything else stays a DRAFT awaiting human review. The mapping consumes
 *     the already-decided gate rather than re-deriving it from score/threshold,
 *     so there is exactly ONE place (computeConfidence) that owns the gate rule.
 *
 *  2. WHAT price do downstream consumers use? The seller's persisted
 *     `price_override` wins over the pipeline's suggestion whenever it is a
 *     usable price; otherwise the suggestion stands.
 */

/** The two initial listing dispositions the gate can produce. */
export type ListingDisposition = "queued" | "draft";

/**
 * Map the confidence gate decision to the listing's initial status.
 * - eligible (autopilot ON and high confidence) → "queued" (auto-post pipeline)
 * - not eligible (autopilot OFF, or score below threshold) → "draft" (review queue)
 */
export function initialListingStatus(
  confidence: Pick<ConfidenceResult, "autopilotEligible">,
): ListingDisposition {
  return confidence.autopilotEligible ? "queued" : "draft";
}

/**
 * The price every downstream consumer must use: the seller's override when one
 * is set and usable, else the pipeline's suggestion.
 *
 * "Usable" = a finite number > 0. The write path (the review action) validates
 * before persisting, but the read path defends independently: `numeric` comes
 * back through drivers/JSON as number OR string, and legacy rows could carry
 * junk — a bad override must degrade to the suggestion, never to NaN on a
 * listing or a $0 auto-post.
 */
export function effectivePrice(
  suggested: number,
  override: number | string | null | undefined,
): number {
  const o = typeof override === "string" ? Number(override) : override;
  if (typeof o === "number" && Number.isFinite(o) && o > 0) return o;
  return suggested;
}

/**
 * Parse an untrusted (form/JSON) price-override value at the write boundary.
 * Returns the normalized price, or null when the input means "clear the
 * override" (empty/blank), or throws on a value that is present but not a
 * usable price — silently coercing junk to null would CLEAR a seller's
 * existing override on a typo.
 */
export function parsePriceOverride(raw: unknown): number | null {
  if (raw == null) return null;
  const text = typeof raw === "string" ? raw.trim() : raw;
  if (text === "") return null;
  const n = typeof text === "number" ? text : Number(text);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `Invalid price override ${JSON.stringify(raw)}: must be a positive number.`,
    );
  }
  // Normalize to cents — eBay-style marketplaces don't take sub-cent prices,
  // and it keeps the numeric column tidy. Rounding is DECIMAL-safe: naive
  // `Math.round(n * 100)` misrounds half-cent decimals ("1.005" * 100 is
  // 100.4999… in binary, rounding to 1.00 instead of 1.01), so string inputs
  // round on their literal decimal digits and numeric inputs go through a
  // shortest-round-trip decimal rendering first.
  const cents = roundToCents(typeof text === "string" ? text : String(n));
  // Validate AFTER normalization: a sub-cent input like 0.004 rounds to a 0
  // override that effectivePrice() rejects while the UI still labels it
  // "your override", and an overflow (1e307 * 100 → Infinity) would JSON-
  // serialize to null and silently CLEAR an existing override.
  if (!Number.isFinite(cents) || cents < 0.01) {
    throw new Error(
      `Invalid price override ${JSON.stringify(raw)}: must be a finite price of at least 0.01.`,
    );
  }
  return cents;
}

/**
 * Round a decimal-string price to cents using its literal digits (half-up),
 * avoiding binary-float tie errors. Falls back to numeric rounding for
 * exotic-but-valid forms (exponent notation), where the overflow check in the
 * caller still applies.
 */
function roundToCents(text: string): number {
  const m = /^([0-9]+)(?:\.([0-9]+))?$/.exec(text);
  if (!m) {
    const n = Number(text);
    return Math.round(n * 100) / 100;
  }
  const whole = m[1];
  const frac = (m[2] ?? "").padEnd(3, "0");
  // Integer math on the digit string: cents plus a half-up look at digit 3+.
  let centsInt = Number(whole) * 100 + Number(frac.slice(0, 2));
  if (Number(frac.slice(2, 3)) >= 5) centsInt += 1;
  return centsInt / 100;
}
