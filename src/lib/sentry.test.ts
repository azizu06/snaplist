import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureError,
  initSentry,
  isSentryEnabled,
  reportServerError,
} from "./sentry";

/**
 * Issue #62: Sentry is OPTIONAL and DSN-gated. These tests pin the OFFLINE-SAFE
 * contract — with no SENTRY_DSN nothing initializes, nothing throws, and the
 * structured `ok:false` log line is still emitted. (The active-DSN reporting path
 * is integration-only — it would init the real SDK — and is out of scope here.)
 */

afterEach(() => vi.restoreAllMocks());

describe("sentry (DSN-gated)", () => {
  it("does not initialize without a DSN, and stays inert", async () => {
    expect(await initSentry({})).toBe(false);
    expect(isSentryEnabled()).toBe(false);
    // captureError is a safe no-op when Sentry is not configured.
    expect(() => captureError(new Error("boom"), { context: "test" })).not.toThrow();
  });

  it("reportServerError still emits a structured ok:false log line (no throw)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    reportServerError("upload.process", new Error("vision exploded"), { itemId: "i1" });
    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(log.mock.calls[0][0] as string);
    expect(line).toMatchObject({
      event: "upload.process",
      ok: false,
      error: "vision exploded",
      itemId: "i1",
    });
  });

  it("extracts the message from a Supabase-style { message } error object", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    reportServerError("review.save.item", { message: "duplicate key value", code: "23505" });
    const line = JSON.parse(log.mock.calls[0][0] as string);
    expect(line.error).toBe("duplicate key value");
  });
});
