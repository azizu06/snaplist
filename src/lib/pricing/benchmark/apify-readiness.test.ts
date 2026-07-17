import { describe, expect, it } from "vitest";
import {
  APIFY_BALANCED_CONDITION_FIXTURES,
  evaluateApifyBalancedConditions,
  formatApifyBalancedConditionReport,
} from "./apify-readiness";

describe("Apify balanced-condition readiness evaluation", () => {
  it("keeps every launch condition equally represented", () => {
    expect(APIFY_BALANCED_CONDITION_FIXTURES.map(({ condition }) => condition)).toEqual([
      "new",
      "open-box",
      "like-new",
      "refurbished",
      "used-good",
      "used-fair",
      "parts",
    ]);
    expect(new Set(APIFY_BALANCED_CONDITION_FIXTURES.map(({ rows }) => rows.length))).toEqual(
      new Set([5]),
    );
  });

  it("normalizes Actor-shaped rows and measures the shared matcher with zero provider calls", () => {
    const summary = evaluateApifyBalancedConditions();

    expect(summary).toMatchObject({
      schemaVersion: 1,
      providerRequests: 0,
      balanced: true,
      conditionCount: 7,
      inputRows: 35,
      normalizedRows: 28,
      normalizationRejectRows: 7,
      anchorRows: 14,
      corroborationRows: 7,
      rejectedRows: 7,
      expectedValidComparableRows: 14,
      validAnchorRows: 14,
      anchorPrecision: 1,
      validComparableRecall: 1,
      twoAnchorCoverage: 1,
      classificationAccuracy: 1,
    });
    expect(summary.conditions.every(({ twoAnchorUsable }) => twoAnchorUsable)).toBe(true);
  });

  it("formats aggregate-only output with no fixture rows or source identifiers", () => {
    const summary = evaluateApifyBalancedConditions();
    const report = formatApifyBalancedConditionReport(summary);
    const serialized = JSON.stringify(summary);

    expect(report).toContain("Provider requests: **0**");
    expect(report).toContain("Open Box");
    expect(report).not.toContain("Fixture Orbit");
    expect(report).not.toContain("ebay.com/itm");
    expect(serialized).not.toContain("Fixture Orbit");
    expect(serialized).not.toContain("ebay.com/itm");
  });
});
