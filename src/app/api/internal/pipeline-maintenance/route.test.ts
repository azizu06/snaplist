import { beforeEach, describe, expect, it, vi } from "vitest";

const run = vi.fn();
vi.mock("@/lib/pipeline-operations/internal", () => ({
  runInternalPipelineMaintenance: run,
}));

describe("POST /api/internal/pipeline-maintenance", () => {
  beforeEach(() => {
    vi.resetModules();
    run.mockReset();
    delete process.env.CRON_SECRET;
  });

  it("fails closed without configuration and rejects a wrong bearer", async () => {
    const { POST } = await import("./route");
    expect((await POST(new Request("http://localhost", { method: "POST" }))).status)
      .toBe(503);
    process.env.CRON_SECRET = "scheduler-secret";
    expect((await POST(new Request("http://localhost", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
    }))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs one bounded local maintenance cycle with the shared secret", async () => {
    process.env.CRON_SECRET = "scheduler-secret";
    run.mockResolvedValue({
      claimedStorageJobs: 0,
      deletedObjects: 0,
      failedObjects: 0,
      health: { queueDepth: 0, oldestJobAgeSeconds: 0 },
    });
    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost", {
      method: "POST",
      headers: { authorization: "Bearer scheduler-secret" },
    }));
    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledOnce();
  });

  it("returns a generic failure without leaking internal error text", async () => {
    process.env.CRON_SECRET = "scheduler-secret";
    run.mockRejectedValue(new Error("service role token and provider detail"));
    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost", {
      method: "POST",
      headers: { authorization: "Bearer scheduler-secret" },
    }));
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("Pipeline maintenance failed");
    expect(body).not.toContain("service role");
    expect(body).not.toContain("provider detail");
  });
});
