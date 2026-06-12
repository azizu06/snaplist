import { describe, expect, it } from "vitest";
import { classifyCallback } from "./callback-outcome";

/**
 * Contract tests for the eBay OAuth callback classifier (issue #17 hardening).
 * Pure pre-exchange branching: given the callback's query params and the CSRF
 * state cookie, decide ok / fail BEFORE any token call — and produce log
 * fields that make a production failure diagnosable from a single line.
 *
 * Order is load-bearing (mirrors the route's security ordering):
 *   1. eBay-reported errors (?error=...) — surfaced, never silently dropped
 *   2. CSRF state validation — before the code is ever trusted
 *   3. code presence
 */
describe("classifyCallback (eBay OAuth callback pre-exchange branching)", () => {
  const good = {
    error: null,
    errorDescription: null,
    code: "v1.1#code",
    state: "abc123",
    expectedState: "abc123",
  };

  it("passes a clean callback through as ok", () => {
    const out = classifyCallback(good);
    expect(out).toEqual({ kind: "ok", code: "v1.1#code" });
  });

  it("surfaces an eBay-reported error with its description", () => {
    const out = classifyCallback({
      ...good,
      error: "access_denied",
      errorDescription: "the user has denied your request",
    });
    expect(out.kind).toBe("ebay_error");
    if (out.kind !== "ebay_error") throw new Error("unreachable");
    expect(out.failMessage).toContain("access_denied");
    expect(out.failMessage).toContain("the user has denied your request");
    expect(out.logFields).toMatchObject({
      reason: "ebay_error",
      ebayError: "access_denied",
    });
  });

  it("surfaces an eBay-reported error even without a description", () => {
    const out = classifyCallback({ ...good, error: "server_error" });
    expect(out.kind).toBe("ebay_error");
    if (out.kind !== "ebay_error") throw new Error("unreachable");
    expect(out.failMessage).toContain("server_error");
  });

  it("eBay error wins over a missing code (decline sends error, no code)", () => {
    const out = classifyCallback({
      ...good,
      code: null,
      error: "access_denied",
    });
    expect(out.kind).toBe("ebay_error");
  });

  it("rejects a state mismatch and logs which side was missing", () => {
    const mismatch = classifyCallback({ ...good, state: "evil" });
    expect(mismatch.kind).toBe("state_mismatch");
    if (mismatch.kind !== "state_mismatch") throw new Error("unreachable");
    expect(mismatch.logFields).toMatchObject({
      reason: "state_mismatch",
      hadCookie: true,
      hadParam: true,
    });

    const noCookie = classifyCallback({ ...good, expectedState: null });
    expect(noCookie.kind).toBe("state_mismatch");
    if (noCookie.kind !== "state_mismatch") throw new Error("unreachable");
    expect(noCookie.logFields).toMatchObject({
      hadCookie: false,
      hadParam: true,
    });

    const noParam = classifyCallback({ ...good, state: null });
    expect(noParam.kind).toBe("state_mismatch");
    if (noParam.kind !== "state_mismatch") throw new Error("unreachable");
    expect(noParam.logFields).toMatchObject({
      hadCookie: true,
      hadParam: false,
    });
  });

  it("state is validated before the code is trusted (mismatch + code present)", () => {
    const out = classifyCallback({ ...good, state: "evil", code: "v1.1#code" });
    expect(out.kind).toBe("state_mismatch");
  });

  it("treats a clean callback without a code as cancelled", () => {
    const out = classifyCallback({ ...good, code: null });
    expect(out.kind).toBe("cancelled");
    if (out.kind !== "cancelled") throw new Error("unreachable");
    expect(out.logFields).toMatchObject({ reason: "cancelled" });
  });

  it("never echoes the state value or code into log fields", () => {
    const out = classifyCallback({ ...good, state: "evil" });
    if (out.kind !== "state_mismatch") throw new Error("unreachable");
    const serialized = JSON.stringify(out.logFields);
    expect(serialized).not.toContain("evil");
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("v1.1#code");
  });
});
