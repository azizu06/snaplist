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

  it("rejects the control characters WHATWG URL parsing strips before resolving", () => {
    // Browsers strip ASCII tab/LF/CR from a Location before parsing, so
    // "/\t/evil.example" navigates to //evil.example — cross-origin.
    expect(safeNext("/\t/evil.example")).toBe("/upload");
    expect(safeNext("/\n/evil.example")).toBe("/upload");
    expect(safeNext("/\r/evil.example")).toBe("/upload");
    // Still-encoded forms are rejected too (defense in depth for callers
    // passing a value that hasn't been query-decoded yet).
    expect(safeNext("/%09/evil.example")).toBe("/upload");
    expect(safeNext("/%0a/evil.example")).toBe("/upload");
    expect(safeNext("/%0d/evil.example")).toBe("/upload");
  });
});
