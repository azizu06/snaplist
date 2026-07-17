import { logEvent } from "@/lib/observability";
import { PIPELINE_OPERATIONS_POLICY } from "./policy";
import type {
  PipelineCleanupOutcome,
  PipelineOperationsHealth,
  PipelineOperationsStore,
} from "./store";

export interface PipelinePhotoCleanupCapability {
  remove(paths: string[]): Promise<void>;
}

export interface PipelineMaintenanceSummary extends PipelineCleanupOutcome {
  health: PipelineOperationsHealth;
}

export async function runPipelineMaintenance(dependencies: {
  store: PipelineOperationsStore;
  photos: PipelinePhotoCleanupCapability;
}): Promise<PipelineMaintenanceSummary> {
  const prepared = await dependencies.store.prepareRetention(
    PIPELINE_OPERATIONS_POLICY.maintenance.batchSize,
  );
  let claimedStorageJobs = 0;
  let deletedObjects = 0;
  let failedObjects = 0;

  for (
    let index = 0;
    index < PIPELINE_OPERATIONS_POLICY.maintenance.batchSize;
    index += 1
  ) {
    const claim = await dependencies.store.claimStorageCleanup(
      PIPELINE_OPERATIONS_POLICY.maintenance.storageLeaseSeconds,
    );
    if (claim.kind === "empty") break;
    claimedStorageJobs += 1;
    try {
      await dependencies.photos.remove(claim.job.photoPaths);
      await dependencies.store.completeStorageCleanup(
        claim.job.jobId,
        claim.job.leaseToken,
      );
      deletedObjects += claim.job.photoPaths.length;
    } catch {
      await dependencies.store.failStorageCleanup(
        claim.job.jobId,
        claim.job.leaseToken,
        "Photo cleanup failed and will be retried.",
      );
      failedObjects += claim.job.photoPaths.length;
    }
  }

  const outcome: PipelineCleanupOutcome = {
    ...prepared,
    claimedStorageJobs,
    deletedObjects,
    failedObjects,
  };
  await dependencies.store.recordCleanupOutcome(outcome);
  const health = await dependencies.store.health();
  logEvent("pipeline.maintenance", {
    queueDepth: health.queueDepth,
    oldestJobAgeSeconds: health.oldestJobAgeSeconds,
    retries: health.retries,
    terminalFailures: health.terminalFailures,
    cleanupPending: health.cleanupPending,
    cleanupDeadLetters: health.cleanupDeadLetters,
    deletedObjects,
    failedObjects,
  });

  return { ...outcome, health };
}
