import { describe, expect, it } from "vitest";
import { itemLabel } from "./item-label";

/** The fallback chain that keeps the dashboard and ⌘K search showing the
 * same name for the same item: "brand model" → title → truncated id. */
describe("itemLabel", () => {
  it("prefers brand + model when both are present", () => {
    expect(itemLabel({ brand: "Sony", model: "WH-1000XM4", title: "Headphones" }, "abcdef123456")).toBe(
      "Sony WH-1000XM4",
    );
  });

  it("falls back to title when brand and model are both absent", () => {
    expect(itemLabel({ title: "Noise-cancelling headphones" }, "abcdef123456")).toBe(
      "Noise-cancelling headphones",
    );
  });

  it("falls back to title when brand/model are empty strings", () => {
    expect(itemLabel({ brand: "", model: "", title: "Vintage lamp" }, "abcdef123456")).toBe(
      "Vintage lamp",
    );
  });

  it("uses only the model when brand is absent", () => {
    expect(itemLabel({ model: "WH-1000XM4" }, "abcdef123456")).toBe("WH-1000XM4");
  });

  it("falls back to a truncated id when nothing else is available", () => {
    expect(itemLabel({}, "abcdef123456")).toBe("Item abcdef12");
  });

  it("falls back to a truncated id for attributes that fail to parse", () => {
    expect(itemLabel(null, "abcdef123456")).toBe("Item abcdef12");
    expect(itemLabel("not an object", "abcdef123456")).toBe("Item abcdef12");
  });
});
