import { describe, expect, it, vi } from "vitest";
import { createSupabasePipelineOperationsStore } from "./store";

describe("pipeline operations fixed RPC store", () => {
  it("prepares retention, claims cleanup work, records outcomes, and loads health", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: { expiredCount: 2, skippedForLock: false },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          queueMessagesDeleted: 2,
          queueArchiveRowsDeleted: 3,
          stagingIntentsProtected: 1,
          storageJobsQueued: 4,
          terminalRunsPruned: 5,
          cronRowsDeleted: 6,
          httpRowsDeleted: 7,
          skippedForLock: false,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          kind: "claimed",
          job: {
            jobId: "11111111-1111-4111-8111-111111111111",
            leaseToken: "22222222-2222-4222-8222-222222222222",
            photoPaths: ["user/photos/example.jpg"],
            attemptCount: 1,
            maxAttempts: 5,
          },
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          kind: "authorized",
          photoPaths: ["user/photos/example.jpg"],
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({
        data: {
          queueDepth: 0,
          oldestJobAgeSeconds: 0,
          retries: 2,
          terminalFailures: 1,
          expiredWorkerLeases: 0,
          cleanupPending: 0,
          cleanupDeadLetters: 0,
          lastCleanupAt: "2026-07-17T22:44:17.103155+00:00",
          lastCleanupDeletedObjects: 1,
          lastCleanupFailedObjects: 0,
        },
        error: null,
      });
    const store = createSupabasePipelineOperationsStore({ rpc });

    await expect(store.expireGuestRecoveries(25)).resolves.toEqual({
      expiredCount: 2,
      skippedForLock: false,
    });
    await expect(store.prepareRetention(25)).resolves.toMatchObject({
      storageJobsQueued: 4,
      skippedForLock: false,
    });
    const claim = await store.claimStorageCleanup(300);
    expect(claim).toMatchObject({ kind: "claimed" });
    if (claim.kind !== "claimed") throw new Error("expected a claimed job");
    await expect(store.authorizeStorageCleanup(
      claim.job.jobId,
      claim.job.leaseToken,
    )).resolves.toEqual({
      kind: "authorized",
      photoPaths: ["user/photos/example.jpg"],
    });
    await expect(store.completeStorageCleanup(
      claim.job.jobId,
      claim.job.leaseToken,
    )).resolves.toBe(true);
    await expect(store.recordCleanupOutcome({
      ...{
        queueMessagesDeleted: 2,
        queueArchiveRowsDeleted: 3,
        stagingIntentsProtected: 1,
        storageJobsQueued: 4,
        terminalRunsPruned: 5,
        cronRowsDeleted: 6,
        httpRowsDeleted: 7,
        skippedForLock: false,
      },
      claimedStorageJobs: 1,
      deletedObjects: 1,
      failedObjects: 0,
    })).resolves.toBe(true);
    await expect(store.health()).resolves.toMatchObject({
      queueDepth: 0,
      retries: 2,
      terminalFailures: 1,
    });

    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "expire_guest_draft_recoveries",
      "prepare_pipeline_retention",
      "claim_pipeline_storage_cleanup",
      "authorize_pipeline_storage_cleanup",
      "complete_pipeline_storage_cleanup",
      "record_pipeline_cleanup_outcome",
      "pipeline_operations_health",
    ]);
  });

  it("releases failed cleanup work with a bounded safe reason", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    const store = createSupabasePipelineOperationsStore({ rpc });
    await store.failStorageCleanup(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "Storage temporarily unavailable.",
    );
    expect(rpc).toHaveBeenCalledWith("fail_pipeline_storage_cleanup", {
      p_job_id: "11111111-1111-4111-8111-111111111111",
      p_lease_token: "22222222-2222-4222-8222-222222222222",
      p_safe_error: "Storage temporarily unavailable.",
    });
  });
});
