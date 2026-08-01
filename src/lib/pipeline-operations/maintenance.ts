import { logEvent } from "@/lib/observability";
import { PIPELINE_OPERATIONS_POLICY } from "./policy";
import type {
  PipelineCleanupOutcome,
  GuestRecoveryExpiry,
  PipelineOperationsHealth,
  PipelineOperationsStore,
  RawSellerVoiceRetention,
} from "./store";

export interface PipelineStorageCleanupCapability {
  remove(paths: string[]): Promise<void>;
  /**
   * Raw seller voice is the one datum whose retention row demands proof of
   * absence, not merely a successful removal call. Rejects when any object is
   * still readable, which keeps the job durable work instead of a false receipt.
   */
  confirmAbsent(paths: string[]): Promise<void>;
}

export interface PipelineMaintenanceSummary extends PipelineCleanupOutcome {
  guestRecoveryExpiry: GuestRecoveryExpiry;
  rawSellerVoiceRetention: RawSellerVoiceRetention;
  health: PipelineOperationsHealth;
}

export async function runPipelineMaintenance(dependencies: {
  store: PipelineOperationsStore;
  storage: PipelineStorageCleanupCapability;
}): Promise<PipelineMaintenanceSummary> {
  const guestRecoveryExpiry = await dependencies.store.expireGuestRecoveries(
    PIPELINE_OPERATIONS_POLICY.maintenance.batchSize,
  );
  const prepared = await dependencies.store.prepareRetention(
    PIPELINE_OPERATIONS_POLICY.maintenance.batchSize,
  );
  // The 24 hour ceiling runs before the claim loop so raw audio that passed its
  // deadline is removed in the same pass rather than one interval later.
  const rawSellerVoiceRetention = await dependencies.store
    .prepareRawSellerVoiceRetention(
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
    const authorization = await dependencies.store.authorizeStorageCleanup(
      claim.job.jobId,
      claim.job.leaseToken,
    );
    if (authorization.kind === "stale") continue;
    const isRawSellerVoice = claim.job.sourceType === "raw_voice";
    try {
      await dependencies.storage.remove(authorization.photoPaths);
      if (isRawSellerVoice) {
        await dependencies.storage.confirmAbsent(authorization.photoPaths);
      }
      // Completion is the only place a deletion is reported, and for raw voice
      // it is where the retention contract's completion proof is recorded.
      await dependencies.store.completeStorageCleanup(
        claim.job.jobId,
        claim.job.leaseToken,
      );
      deletedObjects += authorization.photoPaths.length;
    } catch {
      await dependencies.store.failStorageCleanup(
        claim.job.jobId,
        claim.job.leaseToken,
        isRawSellerVoice
          ? "Raw seller voice cleanup failed and will be retried."
          : "Photo cleanup failed and will be retried.",
      );
      failedObjects += authorization.photoPaths.length;
    }
  }

  // `storageJobsQueued` is a persisted metric owned by `prepare_pipeline_retention`.
  // The raw voice ceiling reports its own count so neither number silently
  // changes meaning for whoever reads the recorded outcome.
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
    guestRecoveriesExpired: guestRecoveryExpiry.expiredCount,
    rawVoiceJobsQueued: rawSellerVoiceRetention.rawVoiceJobsQueued,
  });

  return { ...outcome, guestRecoveryExpiry, rawSellerVoiceRetention, health };
}
