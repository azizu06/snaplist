import { beforeAll, describe, expect, it, vi } from "vitest";

// The capture harness is intentionally plain Node ESM so it can run without a
// TypeScript loader. Vitest can import it directly for its deterministic QA seam.
const fsMock = vi.hoisted(() => ({
  accessSync: vi.fn(() => {
    throw new Error("browser resolution must not run while importing pure capture assertions");
  }),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, accessSync: fsMock.accessSync };
});

let assertCaptureLayout: typeof import("../../remotion/scripts/capture-real-ui.mjs").assertCaptureLayout;

beforeAll(async () => {
  ({ assertCaptureLayout } = await import(
    "../../remotion/scripts/capture-real-ui.mjs"
  ));
});

describe("browserless assertion imports", () => {
  it("does not resolve Chrome while importing the pure QA exports", () => {
    expect(assertCaptureLayout).toBeTypeOf("function");
    expect(fsMock.accessSync).not.toHaveBeenCalled();
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
