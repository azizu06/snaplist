import { beforeEach, describe, expect, it, vi } from "vitest";

const advance = vi.fn();
vi.mock("@/lib/included-offer-fence/configured", () => ({
  createConfiguredIncludedOfferFence: () => ({
    fence: {},
    worker: { advance },
  }),
}));

describe("/api/internal/included-offer-worker", () => {
  beforeEach(() => {
    vi.resetModules();
    advance.mockReset();
    delete process.env.CRON_SECRET;
  });

  it("advances one head claim for an authorized scheduler on either method", async () => {
    process.env.CRON_SECRET = "worker-secret";
    advance.mockResolvedValue({
      acked: ["claim-a"],
      expired: ["claim-b"],
      opened: [],
    });
    const route = await import("./route");
    for (const invoke of [route.GET, route.POST]) {
      advance.mockClear();
      const response = await invoke(
        new Request("http://localhost/api/internal/included-offer-worker", {
          headers: { authorization: "Bearer worker-secret" },
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);
      // The sweep of abandoned Apple writes is reported, not swallowed: an
      // operator watching this endpoint should see claims being terminalized.
      await expect(response.json()).resolves.toEqual({
        acked: ["claim-a"],
        expired: ["claim-b"],
        opened: [],
      });
      expect(advance).toHaveBeenCalledOnce();
    }
  });

  it("fails closed when the internal secret is not configured", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/internal/included-offer-worker", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(503);
    expect(advance).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated or wrong-secret caller", async () => {
    process.env.CRON_SECRET = "worker-secret";
    const { POST } = await import("./route");
    const cases: Record<string, string>[] = [
      {},
      { authorization: "Bearer wrong-secret" },
    ];
    for (const headers of cases) {
      const response = await POST(
        new Request("http://localhost/api/internal/included-offer-worker", {
          headers,
          method: "POST",
        }),
      );
      expect(response.status).toBe(401);
    }
    expect(advance).not.toHaveBeenCalled();
  });
});
