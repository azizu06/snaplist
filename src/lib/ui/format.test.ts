import { describe, expect, it } from "vitest";
import { sentenceCase } from "./format";

/** Normalizes case-inconsistent pipeline/LLM output ("good" vs "Good") at the
 * display seam without mutating stored data. */
describe("sentenceCase", () => {
  it("capitalizes only the first letter", () => {
    expect(sentenceCase("good")).toBe("Good");
    expect(sentenceCase("like new")).toBe("Like new");
  });

  it("leaves already-capitalized values and interior casing intact", () => {
    expect(sentenceCase("USB-C")).toBe("USB-C");
    expect(sentenceCase("iPhone")).toBe("iPhone");
  });

  it("trims surrounding whitespace before capitalizing", () => {
    expect(sentenceCase("  good  ")).toBe("Good");
  });

  it("returns null for null, undefined, and whitespace-only input", () => {
    expect(sentenceCase(null)).toBeNull();
    expect(sentenceCase(undefined)).toBeNull();
    expect(sentenceCase("   ")).toBeNull();
  });
});
