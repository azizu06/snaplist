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

  it("falls back to title when brand/model are whitespace-only", () => {
    expect(itemLabel({ brand: "  ", model: " ", title: "Vintage lamp" }, "abcdef123456")).toBe(
      "Vintage lamp",
    );
  });

  it("falls back to a truncated id when title is also whitespace-only", () => {
    expect(itemLabel({ brand: " ", title: "   " }, "abcdef123456")).toBe("Item abcdef12");
  });

  it("trims a valid brand/model pair with incidental surrounding whitespace", () => {
    expect(itemLabel({ brand: " Sony ", model: " WH-1000XM4 " }, "abcdef123456")).toBe(
      "Sony WH-1000XM4",
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

  describe("generated listing title fallback (#1117)", () => {
    it("uses the listing title when attributes carry neither brand/model nor title", () => {
      expect(itemLabel({}, "abcdef123456", "Apple AirPods Pro 2nd Gen")).toBe(
        "Apple AirPods Pro 2nd Gen",
      );
    });

    it("keeps brand + model ahead of the listing title", () => {
      expect(
        itemLabel({ brand: "Apple", model: "AirPods Pro" }, "abcdef123456", "Long SEO title"),
      ).toBe("Apple AirPods Pro");
    });

    it("keeps the vision title ahead of the listing title", () => {
      expect(itemLabel({ title: "Wireless earbuds" }, "abcdef123456", "Long SEO title")).toBe(
        "Wireless earbuds",
      );
    });

    it("ignores a blank listing title and falls to the id stub", () => {
      expect(itemLabel({}, "abcdef123456", "   ")).toBe("Item abcdef12");
      expect(itemLabel({}, "abcdef123456", null)).toBe("Item abcdef12");
    });

    it("uses the listing title when attributes fail to parse", () => {
      expect(itemLabel(null, "abcdef123456", "Canon AE-1 Camera")).toBe("Canon AE-1 Camera");
    });
  });

  describe("resilience (#1117)", () => {
    const PROD_ATTRIBUTES = {
      specs: ["White charging case", "Silicone ear tips", "Charging-case status LED"],
      title: "White AirPods Pro-style Wireless Earbuds with Case",
      category: "true wireless earbuds with charging case",
      condition: "very-good",
    };

    it("labels the production attributes payload by its vision title", () => {
      expect(itemLabel(PROD_ATTRIBUTES, "ae304646-0000")).toBe(
        "White AirPods Pro-style Wireless Earbuds with Case",
      );
    });

    it("still reads title and brand+model when the schema parse fails", () => {
      const broken = { ...PROD_ATTRIBUTES, specs: "not-an-array", measurements: 7 };
      expect(itemLabel(broken, "ae304646-0000")).toBe(PROD_ATTRIBUTES.title);
      expect(itemLabel({ brand: "Apple", model: "AirPods Pro", specs: 3 }, "ae304646-0000")).toBe(
        "Apple AirPods Pro",
      );
    });

    it("falls through a failed parse to the listing title, then the id", () => {
      expect(itemLabel({ specs: 3 }, "ae304646-0000", "Listing title")).toBe("Listing title");
      expect(itemLabel({ specs: 3 }, "ae304646-0000")).toBe("Item ae304646");
    });
  });
});
