import { afterEach, describe, expect, it, vi } from "vitest";
import { logServerError, serverErrorJson } from "./errors";

afterEach(() => vi.restoreAllMocks());

/**
 * Issue #57 (OWASP audit, CWE-209): API error responses must never echo the raw
 * internal error text — Supabase/Postgres strings leak schema and RLS hints.
 */
describe("serverErrorJson", () => {
  it("returns a generic client message and never leaks the raw error", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {}); // silence the structured log line
    const internal =
      'duplicate key value violates unique constraint "messages_reply_to_key" DETAIL: schema secret';
    const res = serverErrorJson("inbox.send", new Error(internal), "Failed to send reply.");

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Failed to send reply." });
    expect(JSON.stringify(body)).not.toContain("constraint");
    expect(JSON.stringify(body)).not.toContain("schema secret");
  });

  it("records the real error server-side (structured) for debugging", () => {
    // #62: logServerError now emits a structured ok:false line via reportServerError
    // (and reports to Sentry when a DSN is set) instead of a bare console.error.
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logServerError("inbox.simulate", new Error("real postgres detail"));
    const line = JSON.parse(spy.mock.calls[0][0] as string);
    expect(line).toMatchObject({
      event: "inbox.simulate",
      ok: false,
      error: "real postgres detail",
    });
  });
});
