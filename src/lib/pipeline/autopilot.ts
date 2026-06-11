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
  // and it keeps the numeric column tidy. Validate the ROUNDED value: a
  // sub-cent input like 0.004 would otherwise persist a 0 override that
  // effectivePrice() rejects while the UI still labels it "your override".
  const cents = Math.round(n * 100) / 100;
  if (cents < 0.01) {
    throw new Error(
      `Invalid price override ${JSON.stringify(raw)}: must be at least 0.01.`,
    );
  }
  return cents;
}
