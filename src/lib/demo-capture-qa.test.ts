import { describe, expect, it } from "vitest";

// The capture harness is intentionally plain Node ESM so it can run without a
// TypeScript loader. Vitest can import it directly for its deterministic QA seam.
import {
  assertCaptureLayout,
  assertMobileInboxLayout,
} from "../../remotion/scripts/capture-real-ui.mjs";

const validMetrics = {
  viewportWidth: 390,
  scrollWidth: 390,
  rows: [{ left: 0, right: 390, width: 390 }],
  control: { left: 286, right: 374, width: 88 },
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

describe("assertCaptureLayout", () => {
  const focused = {
    viewportWidth: 390,
    viewportHeight: 844,
    scrollWidth: 390,
    scrollHeight: 1800,
    target: { left: 12, right: 378, top: 180, bottom: 620, width: 366, height: 440 },
    activeTheme: "dark",
  };

  it("accepts a visible, non-collapsed real-app focus target", () => {
    expect(() => assertCaptureLayout(focused, "mobile price", true, "dark")).not.toThrow();
  });

  it.each([
    ["page overflow", { ...focused, scrollWidth: 420 }],
    ["collapsed target", { ...focused, target: { ...focused.target, height: 0 } }],
    ["offscreen target", { ...focused, target: { ...focused.target, top: 900, bottom: 980 } }],
    ["missing target", { ...focused, target: null }],
  ])("rejects %s", (_label, metrics) => {
    expect(() => assertCaptureLayout(metrics, "mobile price", true)).toThrow(
      /overflow|collapsed|outside|missing/,
    );
  });

  it("rejects a capture whose mounted theme drifted", () => {
    expect(() =>
      assertCaptureLayout({ ...focused, activeTheme: "light" }, "mobile price", true, "dark"),
    ).toThrow(/theme mismatch/);
  });
});
