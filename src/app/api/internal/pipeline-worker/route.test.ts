import { beforeEach, describe, expect, it, vi } from "vitest";

const { consume, after, createWorker, logError } = vi.hoisted(() => ({
  consume: vi.fn(), after: vi.fn(), createWorker: vi.fn(), logError: vi.fn(),
}));
vi.mock("next/server", async (original) => ({
  ...await original<typeof import("next/server")>(), after,
}));
vi.mock("@/lib/pipeline-queue/internal", () => ({
  createInternalPipelineWorker: createWorker,
}));
vi.mock("@/lib/api/errors", () => ({ logServerError: logError }));

beforeEach(() => {
  after.mockReset();
  logError.mockReset();
  createWorker.mockReset().mockReturnValue({ consume });
});

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
        headers: { authorization: "Bearer worker-secret", "x-snaplist-worker-wake": "1" },
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
    expect(after).not.toHaveBeenCalled();
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

  function wakeRequest(secret = "worker-secret") {
    return new Request("http://localhost/api/internal/pipeline-worker", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "x-snaplist-worker-wake": "1" },
    });
  }

  it("admits a wake before processing and tracks consumption until it settles", async () => {
    process.env.CRON_SECRET = "worker-secret";
    let finish!: () => void;
    consume.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { POST } = await import("./route");
    const response = await POST(wakeRequest());
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
    expect(after).toHaveBeenCalledOnce();
    expect(consume).not.toHaveBeenCalled();
    let settled = false;
    const background = after.mock.calls[0][0]().then(() => { settled = true; });
    await Promise.resolve();
    expect(consume).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    finish();
    await background;
    expect(settled).toBe(true);
  });

  it("logs a background failure while durable queue recovery remains with cron", async () => {
    process.env.CRON_SECRET = "worker-secret";
    const failure = new Error("consume failed");
    consume.mockRejectedValue(failure);
    const { POST } = await import("./route");
    expect((await POST(wakeRequest())).status).toBe(202);
    await expect(after.mock.calls[0][0]()).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith("pipeline.worker", failure);
  });

  it("rejects a wake without authority before registering background work", async () => {
    const { POST } = await import("./route");
    expect((await POST(wakeRequest())).status).toBe(503);
    process.env.CRON_SECRET = "worker-secret";
    expect((await POST(wakeRequest("wrong-secret"))).status).toBe(401);
    expect(after).not.toHaveBeenCalled();
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("does not accept a wake if worker setup or background registration fails", async () => {
    process.env.CRON_SECRET = "worker-secret";
    const { POST } = await import("./route");
    createWorker.mockImplementationOnce(() => { throw new Error("not configured"); });
    expect((await POST(wakeRequest())).status).toBe(500);
    expect(after).not.toHaveBeenCalled();
    after.mockImplementationOnce(() => { throw new Error("no execution context"); });
    expect((await POST(wakeRequest())).status).toBe(500);
    expect(consume).not.toHaveBeenCalled();
  });
});
