import { describe, expect, it } from "vitest";
import { computeConfidence } from "../confidence/confidence";
import { effectivePrice, initialListingStatus, parseCostBasis, parsePriceOverride } from "./autopilot";

/**
 * Confidence-gated autopilot disposition + price override — pure-logic unit
 * tests with fake data (issue #12). No I/O, no Supabase: the gate mapping and
 * the price-resolution rule must be provable offline.
 */

describe("initialListingStatus", () => {
  it("queues an autopilot-eligible run for auto-post", () => {
    expect(initialListingStatus({ autopilotEligible: true })).toBe("queued");
  });

  it("keeps a non-eligible run as a review draft", () => {
    expect(initialListingStatus({ autopilotEligible: false })).toBe("draft");
  });

  it("HIGH-confidence signals with autopilot ON gate to queued (end-to-end with the real composite)", () => {
    // ISBN tier + fully resolved identification = the strongest possible run.
    const confidence = computeConfidence(
      {
        tier: "isbn",
        compAgreement: 0.9,
        identification: {
          brandResolved: true,
          modelResolved: true,
          barcodeDecoded: true,
          categoryUnambiguous: true,
        },
      },
      { autopilotEnabled: true },
    );
    expect(confidence.band).toBe("high");
    expect(confidence.autopilotEligible).toBe(true);
    expect(initialListingStatus(confidence)).toBe("queued");
  });

  it("LOW-confidence signals queue for review even with autopilot ON", () => {
    const confidence = computeConfidence(
      {
        tier: "llm_only",
        compAgreement: 0.2,
        identification: {
          brandResolved: false,
          modelResolved: false,
          barcodeDecoded: false,
          categoryUnambiguous: false,
        },
      },
      { autopilotEnabled: true },
    );
    expect(confidence.band).toBe("low");
    expect(confidence.autopilotEligible).toBe(false);
    expect(initialListingStatus(confidence)).toBe("draft");
  });

  it("autopilot OFF queues EVERYTHING for review, even the strongest run", () => {
    const confidence = computeConfidence(
      {
        tier: "isbn",
        compAgreement: 1,
        identification: {
          brandResolved: true,
          modelResolved: true,
          barcodeDecoded: true,
          categoryUnambiguous: true,
        },
      },
      { autopilotEnabled: false },
    );
    // The signals are high-confidence — the master switch alone forces review.
    expect(confidence.band).toBe("high");
    expect(confidence.autopilotEligible).toBe(false);
    expect(initialListingStatus(confidence)).toBe("draft");
  });
});

describe("effectivePrice", () => {
  it("uses the override when set", () => {
    expect(effectivePrice(100, 80)).toBe(80);
  });

  it("uses the suggestion when there is no override", () => {
    expect(effectivePrice(100, null)).toBe(100);
    expect(effectivePrice(100, undefined)).toBe(100);
  });

  it("accepts a numeric-string override (numeric columns round-trip as strings in some drivers)", () => {
    expect(effectivePrice(100, "85.50")).toBe(85.5);
  });

  it("degrades junk overrides to the suggestion (never NaN / $0 downstream)", () => {
    expect(effectivePrice(100, Number.NaN)).toBe(100);
    expect(effectivePrice(100, "not-a-price")).toBe(100);
    expect(effectivePrice(100, 0)).toBe(100);
    expect(effectivePrice(100, -5)).toBe(100);
    expect(effectivePrice(100, Number.POSITIVE_INFINITY)).toBe(100);
  });
});

describe("parsePriceOverride", () => {
  it("parses a positive price and rounds to cents", () => {
    expect(parsePriceOverride("25.5")).toBe(25.5);
    expect(parsePriceOverride(12)).toBe(12);
    expect(parsePriceOverride("19.999")).toBe(20);
  });

  it("treats blank/missing input as 'clear the override'", () => {
    expect(parsePriceOverride(null)).toBeNull();
    expect(parsePriceOverride(undefined)).toBeNull();
    expect(parsePriceOverride("")).toBeNull();
    expect(parsePriceOverride("   ")).toBeNull();
  });

  it("rejects non-numeric and non-positive values loudly (a typo must not clear an override)", () => {
    expect(() => parsePriceOverride("abc")).toThrow(/plain decimal/);
    expect(() => parsePriceOverride("0")).toThrow(/positive number/);
    expect(() => parsePriceOverride(-3)).toThrow(/positive number/);
    expect(() => parsePriceOverride("Infinity")).toThrow(/plain decimal/);
  });

  it("rejects strings Number() would reinterpret away from their literal digits", () => {
    // Number("0x10") is 16 and Number("+12") is 12 — accepting them would
    // persist a price that doesn't correspond to what was typed.
    expect(() => parsePriceOverride("0x10")).toThrow(/plain decimal/);
    expect(() => parsePriceOverride("+12")).toThrow(/plain decimal/);
    expect(() => parsePriceOverride("1,000")).toThrow(/plain decimal/);
    // Plain decimal shapes still pass, including dot-led and dot-trailed.
    expect(parsePriceOverride(".5")).toBe(0.5);
    expect(parsePriceOverride("12.")).toBe(12);
  });
});

describe("parsePriceOverride — sub-cent inputs", () => {
  it("rejects values that round down to zero instead of persisting a broken override", () => {
    expect(() => parsePriceOverride(0.004)).toThrow(/at least 0.01/);
    expect(() => parsePriceOverride("0.004")).toThrow(/at least 0.01/);
  });

  it("accepts values that round to a valid cent amount", () => {
    expect(parsePriceOverride(0.006)).toBe(0.01);
    expect(parsePriceOverride("12.345")).toBe(12.35);
  });
});

describe("parsePriceOverride — decimal rounding and overflow", () => {
  it("rounds half-cent decimal strings on their literal digits, not binary floats", () => {
    expect(parsePriceOverride("1.005")).toBe(1.01); // naive n*100 gives 100.4999… → 1.00
    expect(parsePriceOverride("2.675")).toBe(2.68);
    expect(parsePriceOverride("19.999")).toBe(20);
  });

  it("rejects values whose cent normalization overflows to Infinity", () => {
    expect(() => parsePriceOverride(1e307)).toThrow(/finite/);
    expect(() => parsePriceOverride("1e307")).toThrow(/finite/);
  });

  it("rejects magnitudes that would silently break the exact integer cent math", () => {
    // Number(whole) * 100 past MAX_SAFE_INTEGER misrounds the literal digits
    // ("999999999999999.99" would round UP a full cent) — reject, never lie.
    expect(() => parsePriceOverride("999999999999999.99")).toThrow(/finite/);
    expect(() => parsePriceOverride("99999999999999.99")).toThrow(/finite/);
    // The largest in-range magnitude still rounds exactly.
    expect(parsePriceOverride("9999999999999.99")).toBe(9999999999999.99);
  });
});

describe("parsePriceOverride — exponent notation", () => {
  it("applies the same literal-digit half-up rounding to exponent strings", () => {
    expect(parsePriceOverride("1.005e0")).toBe(1.01); // binary fallback gave 1.00
    expect(parsePriceOverride("1005e-3")).toBe(1.01);
    expect(parsePriceOverride("2.5e2")).toBe(250);
  });
});

describe("parseCostBasis", () => {
  it("blank / null means 'clear' → null (unknown cost, never a fake $0)", () => {
    expect(parseCostBasis(null)).toBeNull();
    expect(parseCostBasis(undefined)).toBeNull();
    expect(parseCostBasis("")).toBeNull();
    expect(parseCostBasis("   ")).toBeNull();
  });

  it("accepts $0 — a free find is a REAL zero cost (unlike a $0 price)", () => {
    expect(parseCostBasis("0")).toBe(0);
    expect(parseCostBasis(0)).toBe(0);
    expect(parseCostBasis("0.00")).toBe(0);
  });

  it("normalizes to cents with the same literal-digit half-up rounding", () => {
    expect(parseCostBasis("12.5")).toBe(12.5);
    expect(parseCostBasis("1.005")).toBe(1.01);
    expect(parseCostBasis(19.99)).toBe(19.99);
  });

  it("throws on junk instead of silently clearing a recorded cost", () => {
    expect(() => parseCostBasis("abc")).toThrow(/cost basis/i);
    expect(() => parseCostBasis("0x10")).toThrow(/decimal/);
    expect(() => parseCostBasis("+12")).toThrow(/decimal/);
    expect(() => parseCostBasis(Number.NaN)).toThrow(/zero or a positive/);
  });

  it("rejects negatives — you can't pay less than nothing", () => {
    expect(() => parseCostBasis("-5")).toThrow(/decimal/);
    expect(() => parseCostBasis(-5)).toThrow(/zero or a positive/);
  });

  it("rejects overflow / exact-math-breaking magnitudes like the price parser", () => {
    expect(() => parseCostBasis("1e307")).toThrow(/finite/);
    expect(() => parseCostBasis("99999999999999.99")).toThrow(/finite/);
  });
});
