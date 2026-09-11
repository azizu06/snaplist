import { describe, expect, it, vi } from "vitest";
import {
  createSupabaseActivationGuidanceStore,
  type ActivationGuidanceDatabaseClient,
} from "./store";

describe("activation-guidance completion store", () => {
    it("reads no completion when the seller has no RLS-visible row", async () => {
      const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      const eq = vi.fn(() => ({ maybeSingle }));
      const select = vi.fn(() => ({ eq }));
      const store = createSupabaseActivationGuidanceStore(() => ({
        from: vi.fn(() => ({ select })),
      }) as unknown as ActivationGuidanceDatabaseClient);

      await expect(
        store.isCompleted({ bearerToken: "seller-token", userId: "seller_123" })
      ).resolves.toBe(false);
      expect(eq).toHaveBeenCalledWith("user_id", "seller_123");
    });

  it("writes completion only for the authenticated seller identity", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const store = createSupabaseActivationGuidanceStore(() => ({
      from: vi.fn(() => ({ insert })),
    }) as unknown as ActivationGuidanceDatabaseClient);

    await store.complete({
      bearerToken: "seller-token",
      userId: "seller_123",
    });

    expect(insert).toHaveBeenCalledWith({ user_id: "seller_123" });
  });

  it("treats a replayed completion write as success", async () => {
    const insert = vi.fn().mockResolvedValue({
      error: { code: "23505", message: "already completed" },
    });
    const store = createSupabaseActivationGuidanceStore(() => ({
      from: vi.fn(() => ({ insert })),
    }) as unknown as ActivationGuidanceDatabaseClient);

    await expect(
      store.complete({ bearerToken: "seller-token", userId: "seller_123" }),
    ).resolves.toBeUndefined();
  });

  it("surfaces a real read failure instead of reporting not completed", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "connection reset" },
    });
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    const store = createSupabaseActivationGuidanceStore(() => ({
      from: vi.fn(() => ({ select })),
    }) as unknown as ActivationGuidanceDatabaseClient);

    await expect(
      store.isCompleted({ bearerToken: "seller-token", userId: "seller_123" }),
    ).rejects.toThrow("Activation guidance completion read failed: connection reset");
  });

  it("surfaces a non-replay write failure instead of swallowing it as success", async () => {
    const insert = vi.fn().mockResolvedValue({
      error: { code: "53300", message: "too many connections" },
    });
    const store = createSupabaseActivationGuidanceStore(() => ({
      from: vi.fn(() => ({ insert })),
    }) as unknown as ActivationGuidanceDatabaseClient);

    await expect(
      store.complete({ bearerToken: "seller-token", userId: "seller_123" }),
    ).rejects.toThrow("Activation guidance completion failed: too many connections");
  });
});
