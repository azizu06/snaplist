import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getUserId: vi.fn() }));

vi.mock("@/lib/auth", () => ({ getUserId: mocks.getUserId }));

import { POST } from "./route";

describe("POST /api/batch/item", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves authentication on the retired endpoint", async () => {
    mocks.getUserId.mockResolvedValue(null);
    const response = await POST();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("never starts request-bound provider work and points clients to durable staging", async () => {
    mocks.getUserId.mockResolvedValue("user_123");
    const response = await POST();

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({
      error: "This legacy batch endpoint has been retired. Start the batch again.",
      kind: "gone",
      replacement: "/api/batch/enqueue",
    });
  });
});
