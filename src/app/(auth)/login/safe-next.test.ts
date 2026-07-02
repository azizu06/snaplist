import { describe, expect, it } from "vitest";

import { safeNext } from "./safe-next";

describe("safeNext", () => {
  it("passes through same-origin absolute paths", () => {
    expect(safeNext("/dashboard")).toBe("/dashboard");
    expect(safeNext("/review/abc?tab=price")).toBe("/review/abc?tab=price");
    expect(safeNext("/")).toBe("/");
  });

  it("falls back for non-strings and relative/absolute URLs", () => {
    expect(safeNext(undefined)).toBe("/upload");
    expect(safeNext(42)).toBe("/upload");
    expect(safeNext("")).toBe("/upload");
    expect(safeNext("dashboard")).toBe("/upload");
    expect(safeNext("https://attacker.example")).toBe("/upload");
  });

  it("rejects protocol-relative URLs", () => {
    expect(safeNext("//evil.example")).toBe("/upload");
    expect(safeNext("//evil.example/phish")).toBe("/upload");
  });

  it("rejects the backslash equivalence class browsers normalize to //", () => {
    // WHATWG URL parsing treats \ as / in http(s), so a Location of
    // /\evil.example resolves to https://evil.example — same open redirect.
    expect(safeNext("/\\evil.example")).toBe("/upload");
    expect(safeNext("/\\/evil.example")).toBe("/upload");
    expect(safeNext("\\/evil.example")).toBe("/upload");
    expect(safeNext("\\\\evil.example")).toBe("/upload");
  });
});
