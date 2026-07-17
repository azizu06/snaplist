import { describe, expect, it, vi } from "vitest";
import { runPipelineMaintenance } from "./maintenance";

describe("pipeline maintenance", () => {
  it("deletes only claimed photo paths and exposes aggregate health", async () => {
    const store = {
      expireGuestRecoveries: vi.fn().mockResolvedValue({
        expiredCount: 2,
        skippedForLock: false,
      }),
      prepareRetention: vi.fn().mockResolvedValue({
        queueMessagesDeleted: 1,
        queueArchiveRowsDeleted: 2,
        stagingIntentsProtected: 3,
        storageJobsQueued: 1,
        terminalRunsPruned: 4,
        cronRowsDeleted: 5,
        httpRowsDeleted: 6,
        skippedForLock: false,
      }),
      claimStorageCleanup: vi.fn()
        .mockResolvedValueOnce({
          kind: "claimed",
          job: {
            jobId: "11111111-1111-4111-8111-111111111111",
            leaseToken: "22222222-2222-4222-8222-222222222222",
            photoPaths: ["user/pipeline-staging/a/photo.jpg"],
            attemptCount: 1,
            maxAttempts: 5,
          },
        })
        .mockResolvedValueOnce({ kind: "empty" }),
      completeStorageCleanup: vi.fn().mockResolvedValue(true),
      failStorageCleanup: vi.fn(),
      recordCleanupOutcome: vi.fn().mockResolvedValue(true),
      health: vi.fn().mockResolvedValue({
        queueDepth: 0,
        oldestJobAgeSeconds: 0,
        retries: 0,
        terminalFailures: 0,
        expiredWorkerLeases: 0,
        cleanupPending: 0,
        cleanupDeadLetters: 0,
        lastCleanupAt: "2026-07-17T00:00:00.000Z",
        lastCleanupDeletedObjects: 1,
        lastCleanupFailedObjects: 0,
      }),
    };
    const photos = { remove: vi.fn().mockResolvedValue(undefined) };

    await expect(runPipelineMaintenance({ store, photos })).resolves.toMatchObject({
      claimedStorageJobs: 1,
      deletedObjects: 1,
      failedObjects: 0,
      guestRecoveryExpiry: { expiredCount: 2, skippedForLock: false },
      health: { queueDepth: 0 },
    });
    expect(photos.remove).toHaveBeenCalledWith([
      "user/pipeline-staging/a/photo.jpg",
    ]);
    expect(store.completeStorageCleanup).toHaveBeenCalledOnce();
    expect(store.recordCleanupOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ deletedObjects: 1, failedObjects: 0 }),
    );
  });

  it("dead-letters through the store without leaking raw Storage errors", async () => {
    const store = {
      expireGuestRecoveries: vi.fn().mockResolvedValue({
        expiredCount: 0,
        skippedForLock: false,
      }),
      prepareRetention: vi.fn().mockResolvedValue({
        queueMessagesDeleted: 0,
        queueArchiveRowsDeleted: 0,
        stagingIntentsProtected: 0,
        storageJobsQueued: 1,
        terminalRunsPruned: 0,
        cronRowsDeleted: 0,
        httpRowsDeleted: 0,
        skippedForLock: false,
      }),
      claimStorageCleanup: vi.fn()
        .mockResolvedValueOnce({
          kind: "claimed",
          job: {
            jobId: "11111111-1111-4111-8111-111111111111",
            leaseToken: "22222222-2222-4222-8222-222222222222",
            photoPaths: ["user/pipeline-staging/a/photo.jpg"],
            attemptCount: 5,
            maxAttempts: 5,
          },
        })
        .mockResolvedValueOnce({ kind: "empty" }),
      completeStorageCleanup: vi.fn(),
      failStorageCleanup: vi.fn().mockResolvedValue(true),
      recordCleanupOutcome: vi.fn().mockResolvedValue(true),
      health: vi.fn().mockResolvedValue({
        queueDepth: 1,
        oldestJobAgeSeconds: 5,
        retries: 1,
        terminalFailures: 1,
        expiredWorkerLeases: 0,
        cleanupPending: 0,
        cleanupDeadLetters: 1,
        lastCleanupAt: null,
        lastCleanupDeletedObjects: 0,
        lastCleanupFailedObjects: 1,
      }),
    };
    const photos = {
      remove: vi.fn().mockRejectedValue(new Error("provider token=secret-detail")),
    };

    const result = await runPipelineMaintenance({ store, photos });
    expect(result.failedObjects).toBe(1);
    expect(store.failStorageCleanup).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "Photo cleanup failed and will be retried.",
    );
    expect(JSON.stringify(result)).not.toContain("secret-detail");
  });
});
