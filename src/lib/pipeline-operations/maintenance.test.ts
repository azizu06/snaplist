import { describe, expect, it, vi } from "vitest";
import { runPipelineMaintenance } from "./maintenance";

describe("pipeline maintenance", () => {
  it("purges exact expired guest source and abandoned claim-copy paths", async () => {
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
      prepareRawSellerVoiceRetention: vi.fn().mockResolvedValue({
        rawVoiceJobsQueued: 0,
        skippedForLock: false,
      }),
      claimStorageCleanup: vi.fn()
        .mockResolvedValueOnce({
          kind: "claimed",
          job: {
            jobId: "11111111-1111-4111-8111-111111111111",
            leaseToken: "22222222-2222-4222-8222-222222222222",
            sourceType: "staging",
            photoPaths: [
              "guest_fixture/items/front.enc",
              "user_account/guest-claims/recovery/lease/1",
            ],
            attemptCount: 1,
            maxAttempts: 5,
          },
        })
        .mockResolvedValueOnce({ kind: "empty" }),
      authorizeStorageCleanup: vi.fn().mockResolvedValue({
        kind: "authorized",
        photoPaths: [
          "guest_fixture/items/front.enc",
          "user_account/guest-claims/recovery/lease/1",
        ],
      }),
      completeStorageCleanup: vi.fn().mockResolvedValue(true),
      failStorageCleanup: vi.fn(),
      recordRawSellerVoiceTranscriptionOutcome: vi.fn().mockResolvedValue(true),
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
        lastCleanupDeletedObjects: 2,
        lastCleanupFailedObjects: 0,
      }),
    };
    const photos = {
      remove: vi.fn().mockResolvedValue(undefined),
      confirmAbsent: vi.fn().mockResolvedValue(undefined),
    };

    await expect(runPipelineMaintenance({ store, photos })).resolves.toMatchObject({
      claimedStorageJobs: 1,
      deletedObjects: 2,
      failedObjects: 0,
      guestRecoveryExpiry: { expiredCount: 2, skippedForLock: false },
      health: { queueDepth: 0 },
    });
    expect(photos.remove).toHaveBeenCalledWith([
      "guest_fixture/items/front.enc",
      "user_account/guest-claims/recovery/lease/1",
    ]);
    expect(store.completeStorageCleanup).toHaveBeenCalledOnce();
    // Photo cleanup keeps its single-call shape: only raw seller voice pays for
    // the extra read-back its retention row demands.
    expect(photos.confirmAbsent).not.toHaveBeenCalled();
    expect(store.recordCleanupOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ deletedObjects: 2, failedObjects: 0 }),
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
      prepareRawSellerVoiceRetention: vi.fn().mockResolvedValue({
        rawVoiceJobsQueued: 0,
        skippedForLock: false,
      }),
      claimStorageCleanup: vi.fn()
        .mockResolvedValueOnce({
          kind: "claimed",
          job: {
            jobId: "11111111-1111-4111-8111-111111111111",
            leaseToken: "22222222-2222-4222-8222-222222222222",
            sourceType: "staging",
            photoPaths: ["user/pipeline-staging/a/photo.jpg"],
            attemptCount: 5,
            maxAttempts: 5,
          },
        })
        .mockResolvedValueOnce({ kind: "empty" }),
      authorizeStorageCleanup: vi.fn().mockResolvedValue({
        kind: "authorized",
        photoPaths: ["user/pipeline-staging/a/photo.jpg"],
      }),
      completeStorageCleanup: vi.fn(),
      failStorageCleanup: vi.fn().mockResolvedValue(true),
      recordRawSellerVoiceTranscriptionOutcome: vi.fn().mockResolvedValue(true),
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
      confirmAbsent: vi.fn().mockResolvedValue(undefined),
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

  it("deletes raw seller voice only after an independent read proves absence", async () => {
    const store = rawVoiceStore();
    const photos = {
      remove: vi.fn().mockResolvedValue(undefined),
      confirmAbsent: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runPipelineMaintenance({ store, photos });

    expect(photos.remove).toHaveBeenCalledWith([RAW_VOICE_PATH]);
    expect(photos.confirmAbsent).toHaveBeenCalledWith([RAW_VOICE_PATH]);
    expect(store.completeStorageCleanup).toHaveBeenCalledOnce();
    expect(result.deletedObjects).toBe(1);
    expect(result.rawSellerVoiceRetention).toEqual({
      rawVoiceJobsQueued: 1,
      skippedForLock: false,
    });
    expect(store.recordCleanupOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ storageJobsQueued: 1 }),
    );
  });

  it("keeps raw seller voice deletion retryable when absence cannot be proven", async () => {
    const store = rawVoiceStore();
    const photos = {
      remove: vi.fn().mockResolvedValue(undefined),
      confirmAbsent: vi
        .fn()
        .mockRejectedValue(new Error("bucket token=secret-detail")),
    };

    const result = await runPipelineMaintenance({ store, photos });

    expect(store.completeStorageCleanup).not.toHaveBeenCalled();
    expect(store.failStorageCleanup).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      "Raw seller voice cleanup failed and will be retried.",
    );
    expect(result.deletedObjects).toBe(0);
    expect(result.failedObjects).toBe(1);
    expect(JSON.stringify(result)).not.toContain("secret-detail");
  });
});

const RAW_VOICE_PATH =
  "seller/pipeline-staging/9a1c1f2e-0000-4000-8000-000000000001/0/voice-abc.wav";

function rawVoiceStore() {
  return {
    expireGuestRecoveries: vi.fn().mockResolvedValue({
      expiredCount: 0,
      skippedForLock: false,
    }),
    prepareRetention: vi.fn().mockResolvedValue({
      queueMessagesDeleted: 0,
      queueArchiveRowsDeleted: 0,
      stagingIntentsProtected: 0,
      storageJobsQueued: 0,
      terminalRunsPruned: 0,
      cronRowsDeleted: 0,
      httpRowsDeleted: 0,
      skippedForLock: false,
    }),
    prepareRawSellerVoiceRetention: vi.fn().mockResolvedValue({
      rawVoiceJobsQueued: 1,
      skippedForLock: false,
    }),
    claimStorageCleanup: vi.fn()
      .mockResolvedValueOnce({
        kind: "claimed",
        job: {
          jobId: "33333333-3333-4333-8333-333333333333",
          leaseToken: "44444444-4444-4444-8444-444444444444",
          sourceType: "raw_voice",
          photoPaths: [RAW_VOICE_PATH],
          attemptCount: 1,
          maxAttempts: 5,
        },
      })
      .mockResolvedValueOnce({ kind: "empty" }),
    authorizeStorageCleanup: vi.fn().mockResolvedValue({
      kind: "authorized",
      photoPaths: [RAW_VOICE_PATH],
    }),
    completeStorageCleanup: vi.fn().mockResolvedValue(true),
    failStorageCleanup: vi.fn().mockResolvedValue(true),
    recordRawSellerVoiceTranscriptionOutcome: vi.fn().mockResolvedValue(true),
    recordCleanupOutcome: vi.fn().mockResolvedValue(true),
    health: vi.fn().mockResolvedValue({
      queueDepth: 0,
      oldestJobAgeSeconds: 0,
      retries: 0,
      terminalFailures: 0,
      expiredWorkerLeases: 0,
      cleanupPending: 0,
      cleanupDeadLetters: 0,
      lastCleanupAt: null,
      lastCleanupDeletedObjects: 0,
      lastCleanupFailedObjects: 0,
    }),
  };
}
