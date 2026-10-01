import { afterEach, describe, expect, it, vi } from "vitest";
import { wakePipelineWorker } from "./wake";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("worker wake HTTP capability", () => {
  it("does not dispatch when the origin or internal secret is missing", async () => {
    const dispatch = vi.fn();
    vi.stubGlobal("fetch", dispatch);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await wakePipelineWorker({ origin: undefined, secret: "local-secret" });
    await wakePipelineWorker({ origin: "https://snaplist.example", secret: undefined });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    "https://user:password@snaplist.example", "https://snaplist.example/another-path",
    "https://snaplist.example?redirect=elsewhere", "http://example.com", "https://127.0.0.1",
  ])("rejects an unsafe configured origin: %s", async (origin) => {
    const dispatch = vi.fn();
    vi.stubGlobal("fetch", dispatch);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await wakePipelineWorker({ origin, secret: "local-secret" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("contains a network failure and logs no credential or response text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("local-secret private URL")));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(wakePipelineWorker({ origin: "https://snaplist.example", secret: "local-secret" })).resolves.toBeUndefined();
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/local-secret|private URL/);
  });

  it("leaves recovery to cron after a non-success response without logging its body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private worker error", { status: 500 })));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await wakePipelineWorker({ origin: "https://snaplist.example", secret: "local-secret" });
    expect(log).toHaveBeenCalledWith("[pipeline.worker.wake] http_status=500");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private worker error");
  });
});
