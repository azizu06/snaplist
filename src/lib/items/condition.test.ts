import { describe, expect, it } from "vitest";
import {
  canonicalizeCondition,
  isItemCondition,
  isPricedItemCondition,
  normalizeConditionAlias,
} from "./condition";

/**
 * #798: a model-authored "Good" (wrong case) reached persistence uncanonicalized
 * and made an item's review permanently unopenable. These three functions are
 * the boundary that fix that class of bug, so their edge cases matter.
 */
describe("normalizeConditionAlias", () => {
  it("lowercases and trims", () => {
    expect(normalizeConditionAlias("Good")).toBe("good");
    expect(normalizeConditionAlias("  Good  ")).toBe("good");
  });

  it("collapses dashes and underscores to single spaces", () => {
    expect(normalizeConditionAlias("Like_New")).toBe("like new");
    expect(normalizeConditionAlias("very--good")).toBe("very good");
  });

  it("collapses repeated internal whitespace", () => {
    expect(normalizeConditionAlias("for   parts")).toBe("for parts");
  });
});

describe("canonicalizeCondition", () => {
  it("maps the known aliases to their canonical hyphenated form", () => {
    expect(canonicalizeCondition("Like New")).toBe("like-new");
    expect(canonicalizeCondition("very_good")).toBe("very-good");
    expect(canonicalizeCondition("For-Parts")).toBe("for-parts");
  });

  it("passes already-canonical values through unchanged", () => {
    expect(canonicalizeCondition("good")).toBe("good");
    expect(canonicalizeCondition("acceptable")).toBe("acceptable");
  });

  it("passes an out-of-taxonomy value through normalized but unmapped", () => {
    expect(canonicalizeCondition("Open Box")).toBe("open box");
  });
});

describe("isItemCondition", () => {
  it("accepts every value in the full taxonomy, including for-parts", () => {
    expect(isItemCondition("for-parts")).toBe(true);
    expect(isItemCondition("good")).toBe(true);
  });

  it("rejects values outside the taxonomy", () => {
    expect(isItemCondition("open box")).toBe(false);
    expect(isItemCondition("")).toBe(false);
  });
});

describe("isPricedItemCondition", () => {
  it("accepts every priced condition", () => {
    for (const condition of [
      "new",
      "like-new",
      "very-good",
      "good",
      "acceptable",
      "fair",
      "poor",
    ]) {
      expect(isPricedItemCondition(condition)).toBe(true);
    }
  });

  it("excludes for-parts, which has no pricing factor", () => {
    expect(isPricedItemCondition("for-parts")).toBe(false);
  });
});
