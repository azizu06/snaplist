import { afterEach, describe, expect, it, vi } from "vitest";
import { logServerError, serverErrorJson } from "./errors";

afterEach(() => vi.restoreAllMocks());

/**
 * Issue #57 (OWASP audit, CWE-209): API error responses must never echo the raw
 * internal error text — Supabase/Postgres strings leak schema and RLS hints.
 */
describe("serverErrorJson", () => {
  it("returns a generic client message and never leaks the raw error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const internal =
      'duplicate key value violates unique constraint "messages_reply_to_key" DETAIL: schema secret';
    const res = serverErrorJson("inbox.send", new Error(internal), "Failed to send reply.");

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Failed to send reply." });
    expect(JSON.stringify(body)).not.toContain("constraint");
    expect(JSON.stringify(body)).not.toContain("schema secret");
  });

  it("logs the real error server-side for debugging", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("real postgres detail");
    logServerError("inbox.simulate", err);
    expect(spy).toHaveBeenCalledWith("[inbox.simulate]", err);
  });
});
