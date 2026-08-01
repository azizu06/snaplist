import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const remove = vi.fn();
const exists = vi.fn();
const from = vi.fn(() => ({ exists, remove }));
const genericFrom = vi.fn(() => {
  throw new Error("generic domain access is forbidden");
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: genericFrom,
    rpc,
    storage: { from },
  }),
}));

describe("internal pipeline maintenance composition", () => {
  beforeEach(() => {
    rpc.mockReset();
    remove.mockReset();
    exists.mockReset();
    from.mockClear();
    genericFrom.mockClear();
  });

  it("encloses admin authority behind fixed RPCs and photos-only deletion", async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === "expire_guest_draft_recoveries") {
        return {
          data: { expiredCount: 0, skippedForLock: false },
          error: null,
        };
      }
      if (name === "prepare_pipeline_retention") {
        return {
          data: {
            queueMessagesDeleted: 0,
            queueArchiveRowsDeleted: 0,
            stagingIntentsProtected: 0,
            storageJobsQueued: 1,
            terminalRunsPruned: 0,
            cronRowsDeleted: 0,
            httpRowsDeleted: 0,
            skippedForLock: false,
          },
          error: null,
        };
      }
      if (name === "prepare_raw_seller_voice_retention") {
        return {
          data: { rawVoiceJobsQueued: 0, skippedForLock: false },
          error: null,
        };
      }
      if (name === "claim_pipeline_storage_cleanup") {
        const priorClaims = rpc.mock.calls.filter(([called]) => (
          called === "claim_pipeline_storage_cleanup"
        )).length;
        return priorClaims === 1
          ? {
              data: {
                kind: "claimed",
                job: {
                  jobId: "11111111-1111-4111-8111-111111111111",
                  leaseToken: "22222222-2222-4222-8222-222222222222",
                  sourceType: "staging",
                  photoPaths: ["user/pipeline-staging/photo.jpg"],
                  attemptCount: 1,
                  maxAttempts: 5,
                },
              },
              error: null,
            }
          : { data: { kind: "empty" }, error: null };
      }
      if (name === "authorize_pipeline_storage_cleanup") {
        return {
          data: {
            kind: "authorized",
            photoPaths: ["user/pipeline-staging/photo.jpg"],
          },
          error: null,
        };
      }
      if (name === "pipeline_operations_health") {
        return {
          data: {
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
          },
          error: null,
        };
      }
      return { data: true, error: null };
    });
    remove.mockResolvedValue({ error: null });

    const { runInternalPipelineMaintenance } = await import("./internal");
    await expect(runInternalPipelineMaintenance()).resolves.toMatchObject({
      deletedObjects: 1,
      failedObjects: 0,
    });

    expect(from).toHaveBeenCalledWith("photos");
    expect(remove).toHaveBeenCalledWith(["user/pipeline-staging/photo.jpg"]);
    expect(genericFrom).not.toHaveBeenCalled();
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "expire_guest_draft_recoveries",
      "prepare_pipeline_retention",
      "prepare_raw_seller_voice_retention",
      "claim_pipeline_storage_cleanup",
      "authorize_pipeline_storage_cleanup",
      "complete_pipeline_storage_cleanup",
      "claim_pipeline_storage_cleanup",
      "record_pipeline_cleanup_outcome",
      "pipeline_operations_health",
    ]);
  });

  it("refuses to report a raw voice deletion while the object is still readable", async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === "expire_guest_draft_recoveries") {
        return { data: { expiredCount: 0, skippedForLock: false }, error: null };
      }
      if (name === "prepare_pipeline_retention") {
        return {
          data: {
            queueMessagesDeleted: 0,
            queueArchiveRowsDeleted: 0,
            stagingIntentsProtected: 0,
            storageJobsQueued: 0,
            terminalRunsPruned: 0,
            cronRowsDeleted: 0,
            httpRowsDeleted: 0,
            skippedForLock: false,
          },
          error: null,
        };
      }
      if (name === "prepare_raw_seller_voice_retention") {
        return {
          data: { rawVoiceJobsQueued: 1, skippedForLock: false },
          error: null,
        };
      }
      if (name === "claim_pipeline_storage_cleanup") {
        const priorClaims = rpc.mock.calls.filter(([called]) => (
          called === "claim_pipeline_storage_cleanup"
        )).length;
        return priorClaims === 1
          ? {
              data: {
                kind: "claimed",
                job: {
                  jobId: "33333333-3333-4333-8333-333333333333",
                  leaseToken: "44444444-4444-4444-8444-444444444444",
                  sourceType: "raw_voice",
                  photoPaths: [VOICE_PATH],
                  attemptCount: 1,
                  maxAttempts: 5,
                },
              },
              error: null,
            }
          : { data: { kind: "empty" }, error: null };
      }
      if (name === "authorize_pipeline_storage_cleanup") {
        return {
          data: { kind: "authorized", photoPaths: [VOICE_PATH] },
          error: null,
        };
      }
      if (name === "pipeline_operations_health") {
        return {
          data: {
            queueDepth: 0,
            oldestJobAgeSeconds: 0,
            retries: 0,
            terminalFailures: 0,
            expiredWorkerLeases: 0,
            cleanupPending: 1,
            cleanupDeadLetters: 0,
            lastCleanupAt: null,
            lastCleanupDeletedObjects: 0,
            lastCleanupFailedObjects: 1,
          },
          error: null,
        };
      }
      return { data: true, error: null };
    });
    // The bucket accepted the removal but the object is still readable, which is
    // exactly the case a success-only executor would record as deleted.
    remove.mockResolvedValue({ error: null });
    exists.mockResolvedValue({ data: true, error: null });

    const { runInternalPipelineMaintenance } = await import("./internal");
    await expect(runInternalPipelineMaintenance()).resolves.toMatchObject({
      deletedObjects: 0,
      failedObjects: 1,
    });

    expect(exists).toHaveBeenCalledWith(VOICE_PATH);
    expect(rpc.mock.calls.map(([name]) => name)).not.toContain(
      "complete_pipeline_storage_cleanup",
    );
    expect(rpc.mock.calls.map(([name]) => name)).toContain(
      "fail_pipeline_storage_cleanup",
    );
  });
});

const VOICE_PATH =
  "seller/pipeline-staging/9a1c1f2e-0000-4000-8000-000000000001/0/voice.wav";
