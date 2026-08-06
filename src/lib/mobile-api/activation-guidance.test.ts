import { describe, expect, it, vi } from "vitest";
import { createMobileApiHandler } from "./app";

describe("mobile activation-guidance boundary", () => {
  it("reads only the authenticated seller's completion", async () => {
    const isCompleted = vi.fn().mockResolvedValue(true);
    const handler = createMobileApiHandler({
      activationGuidance: { complete: vi.fn(), isCompleted },
      authenticate: vi.fn().mockResolvedValue({ kind: "clerk", userId: "seller_123" }),
      requestId: () => "activation-request",
      worker: { consume: vi.fn() },
    });

    const response = await handler(
      new Request("https://snaplist.example/v1/activation-guidance", {
        headers: { authorization: "Bearer signed-seller-token" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { completed: true },
      meta: { requestId: "activation-request" },
    });
    expect(isCompleted).toHaveBeenCalledWith({
      bearerToken: "signed-seller-token",
      userId: "seller_123",
    });
  });

  it("writes and returns only the authenticated seller's completion", async () => {
    const complete = vi.fn().mockResolvedValue(undefined);
    const handler = createMobileApiHandler({
      activationGuidance: {
        complete,
        isCompleted: vi.fn().mockResolvedValue(false),
      },
      authenticate: vi.fn().mockResolvedValue({ kind: "clerk", userId: "seller_123" }),
      requestId: () => "activation-request",
      worker: { consume: vi.fn() },
    });

    const response = await handler(
      new Request("https://snaplist.example/v1/activation-guidance", {
        headers: { authorization: "Bearer signed-seller-token" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { completed: true },
      meta: { requestId: "activation-request" },
    });
    expect(complete).toHaveBeenCalledWith({
      bearerToken: "signed-seller-token",
      userId: "seller_123",
    });
  });
});
