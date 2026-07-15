import { beforeEach, describe, expect, it, vi } from "vitest";

const consume = vi.fn();
vi.mock("@/lib/pipeline-queue/internal", () => ({
  createInternalPipelineWorker: () => ({ consume }),
}));

describe("POST /api/internal/pipeline-worker", () => {
  beforeEach(() => {
    vi.resetModules();
    consume.mockReset();
    delete process.env.CRON_SECRET;
  });

  it("fails closed when the internal secret is not configured", async () => {
    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/internal/pipeline-worker", { method: "POST" }));
    expect(response.status).toBe(503);
    expect(consume).not.toHaveBeenCalled();
  });

  it("rejects a request without the scheduler bearer secret", async () => {
    process.env.CRON_SECRET = "worker-secret";
    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/internal/pipeline-worker", { method: "POST" }));
    expect(response.status).toBe(401);
    expect(consume).not.toHaveBeenCalled();
  });

  it("runs the bounded consumer and returns only aggregate counts", async () => {
    process.env.CRON_SECRET = "worker-secret";
    consume.mockResolvedValue({ claimed: 2, succeeded: 1, retrying: 1, failed: 0, skipped: 0 });
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/internal/pipeline-worker", {
        method: "POST",
        headers: { authorization: "Bearer worker-secret" },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      claimed: 2,
      succeeded: 1,
      retrying: 1,
      failed: 0,
      skipped: 0,
    });
    expect(consume).toHaveBeenCalledOnce();
  });
});
