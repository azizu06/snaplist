import { describe, expect, it, vi } from "vitest";
import { eraseAccount } from "./service";

const generationId = "38400000-0000-4000-8000-000000000001";
const idempotencyKey = "38400000-0000-4000-8000-000000000002";

describe("durable account erasure service", () => {
  it("persists Storage absence and reports unresolved provider dispositions as blocked", async () => {
    const storageObject = {
      bucketId: "photos",
      objectName: "user_384/items/item-1/photo.jpg",
    };
    const store = {
      begin: vi.fn().mockResolvedValue({
        generationId,
        status: "deleting" as const,
        blockers: [],
        storageObjects: [storageObject],
      }),
      confirmStorageAbsence: vi.fn().mockResolvedValue(true),
      advance: vi.fn().mockResolvedValue({
        generationId,
        status: "blocked" as const,
        blockers: ["hosted-transcription-retention", "clerk-identity-retention"],
        storageObjects: [],
      }),
    };
    const storage = { remove: vi.fn().mockResolvedValue(undefined) };
    const dispositions = { resolvedBlockers: vi.fn().mockResolvedValue([]) };

    const result = await eraseAccount(
      { userId: "user_384", idempotencyKey },
      { store, storage, dispositions },
    );

    expect(storage.remove).toHaveBeenCalledWith(storageObject);
    expect(store.confirmStorageAbsence).toHaveBeenCalledWith({
      generationId,
      ...storageObject,
    });
    expect(dispositions.resolvedBlockers).toHaveBeenCalledWith({
      generationId,
      userId: "user_384",
    });
    expect(store.advance).toHaveBeenCalledWith({
      generationId,
      resolvedBlockers: [],
    });
    expect(result).toEqual({
      generationId,
      status: "blocked",
      blockers: ["hosted-transcription-retention", "clerk-identity-retention"],
      storageObjects: [],
    });
  });

  it("resumes the same generation when Storage removal is interrupted", async () => {
    const storageObject = {
      bucketId: "message-photos" as const,
      objectName: "user_384/messages/photo.jpg",
    };
    const deleting = {
      generationId,
      status: "deleting" as const,
      blockers: [],
      storageObjects: [storageObject],
    };
    const store = {
      begin: vi.fn().mockResolvedValue(deleting),
      confirmStorageAbsence: vi.fn().mockResolvedValue(true),
      advance: vi.fn().mockResolvedValue({
        generationId,
        status: "blocked" as const,
        blockers: ["clerk-identity-retention"],
        storageObjects: [],
      }),
    };
    const storage = {
      remove: vi.fn()
        .mockRejectedValueOnce(new Error("interrupted"))
        .mockResolvedValueOnce(undefined),
    };
    const dispositions = { resolvedBlockers: vi.fn().mockResolvedValue([]) };

    await expect(eraseAccount(
      { userId: "user_384", idempotencyKey },
      { store, storage, dispositions },
    )).rejects.toThrow("interrupted");
    await expect(eraseAccount(
      { userId: "user_384", idempotencyKey },
      { store, storage, dispositions },
    )).resolves.toMatchObject({ generationId, status: "blocked" });

    expect(store.begin).toHaveBeenCalledTimes(2);
    expect(store.begin).toHaveBeenNthCalledWith(1, {
      userId: "user_384",
      idempotencyKey,
    });
    expect(store.begin).toHaveBeenNthCalledWith(2, {
      userId: "user_384",
      idempotencyKey,
    });
    expect(store.confirmStorageAbsence).toHaveBeenCalledTimes(1);
    expect(store.advance).toHaveBeenCalledTimes(1);
  });
});
