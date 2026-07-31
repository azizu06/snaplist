import { beforeEach, describe, expect, it, vi } from "vitest";

const consume = vi.fn();
vi.mock("@/lib/pipeline-queue/internal", () => ({
  createInternalPipelineWorker: () => ({ consume }),
}));

describe("GET /api/internal/pipeline-worker", () => {
  beforeEach(() => {
    vi.resetModules();
    consume.mockReset();
    delete process.env.CRON_SECRET;
  });

  // Vercel Cron only ever issues GET, so a POST-only worker answers 405 and
  // the queue never drains. The scheduler-neutral contract is that GET carries
  // exactly the same authority as the documented POST.
  it("runs the bounded consumer for an authorized scheduler GET", async () => {
    process.env.CRON_SECRET = "worker-secret";
    consume.mockResolvedValue({ claimed: 1, succeeded: 1, retrying: 0, failed: 0, skipped: 0 });
    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/internal/pipeline-worker", {
        headers: { authorization: "Bearer worker-secret" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      claimed: 1,
      succeeded: 1,
      retrying: 0,
      failed: 0,
      skipped: 0,
    });
    expect(consume).toHaveBeenCalledOnce();
  });

  // The auth proxy no longer redirects this path, so the route's own guard is
  // the only thing standing in front of the worker on the GET path too.
  it("fails closed on a scheduler GET when the internal secret is not configured", async () => {
    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/internal/pipeline-worker"));

    expect(response.status).toBe(503);
    expect(consume).not.toHaveBeenCalled();
  });

  it("rejects a scheduler GET without the bearer secret", async () => {
    process.env.CRON_SECRET = "worker-secret";
    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/internal/pipeline-worker"));

    expect(response.status).toBe(401);
    expect(consume).not.toHaveBeenCalled();
  });
});

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
