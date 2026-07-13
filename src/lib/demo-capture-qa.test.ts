import { describe, expect, it } from "vitest";

// The capture harness is intentionally plain Node ESM so it can run without a
// TypeScript loader. Vitest can import it directly for its deterministic QA seam.
import { assertMobileInboxLayout } from "../../remotion/scripts/capture-real-ui.mjs";

const validMetrics = {
  viewportWidth: 432,
  scrollWidth: 432,
  rows: [{ left: 0, right: 432, width: 432 }],
  control: { left: 320, right: 416, width: 96 },
};

describe("assertMobileInboxLayout", () => {
  it("accepts a viewport-contained inbox", () => {
    expect(() => assertMobileInboxLayout(validMetrics, "mobile inbox")).not.toThrow();
  });

  it.each([
    ["document overflow", { ...validMetrics, scrollWidth: 433 }],
    [
      "conversation row overflow",
      { ...validMetrics, rows: [{ left: 0, right: 433, width: 433 }] },
    ],
    [
      "header control overflow",
      { ...validMetrics, control: { left: 400, right: 440, width: 40 } },
    ],
  ])("rejects %s", (_label, metrics) => {
    expect(() => assertMobileInboxLayout(metrics, "mobile inbox")).toThrow(
      /overflow|escapes viewport/,
    );
  });
});
