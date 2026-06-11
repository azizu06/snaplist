import { describe, expect, it } from "vitest";
import { computeConfidence } from "../confidence/confidence";
import { effectivePrice, initialListingStatus, parsePriceOverride } from "./autopilot";

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
    expect(() => parsePriceOverride("abc")).toThrow(/positive number/);
    expect(() => parsePriceOverride("0")).toThrow(/positive number/);
    expect(() => parsePriceOverride(-3)).toThrow(/positive number/);
    expect(() => parsePriceOverride("Infinity")).toThrow(/positive number/);
  });
});
