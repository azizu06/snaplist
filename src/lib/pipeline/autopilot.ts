import type { ConfidenceResult } from "../confidence/confidence";

/**
 * Confidence-gated publish-eligibility disposition + seller price override.
 * `autopilot*` identifiers are legacy persistence/API names; this module never
 * publishes or schedules marketplace work (issue #127).
 *
 * Two pure decisions live here so they are unit-testable with fake data and
 * shared by every consumer (persistence, review UI, eBay publish, and export):
 *
 *  1. WHERE does a freshly generated listing go? `autopilotEligible` (computed by
 *     the confidence composite: master switch AND score >= threshold) maps onto
 *     the `listings.status` lifecycle — eligible runs are QUEUED as ready for a
 *     seller-triggered publish, while everything else stays a DRAFT awaiting
 *     human review. The mapping consumes
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
 * - eligible (legacy switch ON and high confidence) → "queued" (ready to publish)
 * - not eligible (switch OFF, or score below threshold) → "draft" (review flow)
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
 * The write and read paths share the same cent-safe normalization contract.
 * `numeric` comes back through drivers/JSON as number OR string, and legacy
 * rows could carry junk — a bad override must degrade to the suggestion, never
 * to NaN on a listing or a $0 marketplace publish.
 */
export function effectivePrice(
  suggested: number | string | null | undefined,
  override: number | string | null | undefined,
): number | null {
  const usable = (candidate: number | string | null | undefined) => {
    try {
      return parsePriceOverride(candidate);
    } catch {
      return null;
    }
  };

  return usable(override) ?? usable(suggested);
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
  // Strings must LOOK like a plain decimal (optional exponent) before
  // Number() is trusted: Number("0x10") is 16 and Number("+12") is 12, which
  // would silently accept values that don't correspond to the typed digits.
  if (typeof text === "string" && !PRICE_SHAPE.test(text)) {
    throw new Error(
      `Invalid price override ${JSON.stringify(raw)}: must be a plain decimal number.`,
    );
  }
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
 * Parse an untrusted (form/JSON) COST-BASIS value at the write boundary (#101:
 * what the seller PAID for the item). Same shape discipline as
 * `parsePriceOverride` — blank means "clear" (→ null, an honest unknown, never
 * a fake $0), junk throws instead of silently clearing — with ONE semantic
 * difference: **$0 is a valid cost basis** (a free find / curb rescue is a real
 * zero the profit math must use), whereas a $0 sale price is rejected there.
 * Negative values are junk: you can't pay less than nothing for an item.
 */
export function parseCostBasis(raw: unknown): number | null {
  if (raw == null) return null;
  const text = typeof raw === "string" ? raw.trim() : raw;
  if (text === "") return null;
  if (typeof text === "string" && !PRICE_SHAPE.test(text)) {
    throw new Error(
      `Invalid cost basis ${JSON.stringify(raw)}: must be a plain decimal number.`,
    );
  }
  const n = typeof text === "number" ? text : Number(text);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `Invalid cost basis ${JSON.stringify(raw)}: must be zero or a positive number.`,
    );
  }
  // Same decimal-safe cent normalization as the price override; NaN from the
  // exact-math guard (too many whole digits) must reject, not persist.
  const cents = roundToCents(typeof text === "string" ? text : String(n));
  if (!Number.isFinite(cents) || cents < 0) {
    throw new Error(
      `Invalid cost basis ${JSON.stringify(raw)}: must be a finite amount.`,
    );
  }
  return cents;
}

/**
 * The string shapes a price override may take: plain decimal digits with an
 * optional fraction (leading or trailing dot allowed) and an optional
 * exponent. Anything else ("0x10", "+12", "Infinity") is rejected BEFORE
 * Number() gets a chance to reinterpret it.
 */
const PRICE_SHAPE = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

/**
 * Whole-dollar digits beyond this length would push the cents integer math
 * past Number.MAX_SAFE_INTEGER (≈9.007e15 cents) and silently misround —
 * the literal-digit guarantee would be a lie. 13 digits (≤ $9.99 trillion)
 * keeps the math exact with room to spare; no marketplace price is larger.
 */
const MAX_WHOLE_DIGITS = 13;

/**
 * Round a decimal-string price to cents using its literal digits (half-up),
 * avoiding binary-float tie errors. Falls back to numeric rounding only for
 * sub-one fractions ("\.5") and out-of-range exponents, where the caller's
 * finiteness/positivity checks still apply. Returns NaN (→ caller rejects)
 * when the magnitude would break the exact integer math.
 */
function roundToCents(text: string): number {
  const m = /^([0-9]+)(?:\.([0-9]+))?$/.exec(expandExponent(text));
  if (!m) {
    const n = Number(text);
    return Math.round(n * 100) / 100;
  }
  const whole = m[1];
  if (whole.replace(/^0+/, "").length > MAX_WHOLE_DIGITS) return NaN;
  const frac = (m[2] ?? "").padEnd(3, "0");
  // Integer math on the digit string: cents plus a half-up look at digit 3+.
  let centsInt = Number(whole) * 100 + Number(frac.slice(0, 2));
  if (Number(frac.slice(2, 3)) >= 5) centsInt += 1;
  return centsInt / 100;
}

/**
 * Expand exponent notation ("1.005e0", "2.5e2") into a plain decimal string
 * by shifting the decimal point textually, so accepted exponent inputs get
 * the same literal-digit half-up rounding instead of the binary-float
 * fallback. Non-exponent (or unexpandable) input is returned unchanged.
 */
function expandExponent(text: string): string {
  const m = /^([0-9]+)(?:\.([0-9]+))?[eE]([+-]?[0-9]+)$/.exec(text);
  if (!m) return text;
  const exp = Number(m[3]);
  // Out-of-range exponents fall back to numeric rounding; the caller's
  // finiteness check still rejects overflow.
  if (!Number.isInteger(exp) || Math.abs(exp) > 320) return text;
  let digits = m[1] + (m[2] ?? "");
  let point = m[1].length + exp; // index of the decimal point within digits
  if (point <= 0) {
    digits = "0".repeat(1 - point) + digits;
    point = 1;
  }
  if (point >= digits.length) digits = digits.padEnd(point, "0");
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}
