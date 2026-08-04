import { describe, expect, it } from "vitest";
import {
  NO_VERIFIED_SOLD_MATCHES_COPY,
  safeSellerCoreValue,
  sellerCopyViolations,
  sellerTitleViolations,
  STARTING_PRICE_COPY,
} from "./index";

describe("seller-visible copy contract (#243)", () => {
  it.each([
    ["en dash", "Sony \u2013 headphones", "typographic-dash"],
    ["em dash", "Sony \u2014 headphones", "typographic-dash"],
    ["contrast formula", "Not just headphones.", "contrast-formula"],
    ["chatbot opening", "Sure! Here is your listing.", "chatbot-opening"],
    ["shipping promise", "Ships fast with tracking.", "unsupported-promise"],
    ["urgency claim", "Limited time offer.", "unsupported-promise"],
    ["raw provider error", "PostgrestError: PGRST116", "internal-error"],
  ])("rejects %s", (_label, copy, violation) => {
    expect(sellerCopyViolations(copy)).toContain(violation);
  });

  it("keeps exact no-evidence copy and ordinary verified facts", () => {
    expect(sellerCopyViolations(STARTING_PRICE_COPY)).toEqual([]);
    expect(sellerCopyViolations(NO_VERIFIED_SOLD_MATCHES_COPY)).toEqual([]);
    expect(safeSellerCoreValue("Sony WH-1000XM4")).toBe("Sony WH-1000XM4");
  });

  it("rejects a digit-free accessory claim that is absent from the factual core", () => {
    expect(
      sellerTitleViolations("Sony WH-1000XM4 Includes Charger", [
        "Sony",
        "WH-1000XM4",
        "headphones",
      ]),
    ).toContain("unsupported-title-fact");
  });
});
