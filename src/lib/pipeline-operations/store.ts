import { z } from "zod";

const preparationSchema = z.object({
  queueMessagesDeleted: z.number().int().nonnegative(),
  queueArchiveRowsDeleted: z.number().int().nonnegative(),
  stagingIntentsProtected: z.number().int().nonnegative(),
  storageJobsQueued: z.number().int().nonnegative(),
  terminalRunsPruned: z.number().int().nonnegative(),
  cronRowsDeleted: z.number().int().nonnegative(),
  httpRowsDeleted: z.number().int().nonnegative(),
  skippedForLock: z.boolean(),
}).strict();

const cleanupJobSchema = z.object({
  jobId: z.string().uuid(),
  leaseToken: z.string().uuid(),
  photoPaths: z.array(z.string().min(1).max(1_024)).min(1).max(800),
  fenceGeneration: z.number().int().positive().nullable(),
  attemptCount: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
}).strict();

const cleanupClaimSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("claimed"), job: cleanupJobSchema }).strict(),
  z.object({ kind: z.literal("empty") }).strict(),
]);

const cleanupAuthorizationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("authorized"),
    photoPaths: z.array(z.string().min(1).max(1_024)).min(1).max(800),
  }).strict(),
  z.object({ kind: z.literal("stale") }).strict(),
]);

const cleanupOutcomeSchema = preparationSchema.extend({
  claimedStorageJobs: z.number().int().nonnegative(),
  deletedObjects: z.number().int().nonnegative(),
  failedObjects: z.number().int().nonnegative(),
}).strict();

const guestRecoveryExpirySchema = z.object({
  expiredCount: z.number().int().nonnegative(),
  skippedForLock: z.boolean(),
}).strict();

const healthSchema = z.object({
  queueDepth: z.number().int().nonnegative(),
  oldestJobAgeSeconds: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  terminalFailures: z.number().int().nonnegative(),
  expiredWorkerLeases: z.number().int().nonnegative(),
  cleanupPending: z.number().int().nonnegative(),
  cleanupDeadLetters: z.number().int().nonnegative(),
  lastCleanupAt: z.string().datetime({ offset: true }).nullable(),
  lastCleanupDeletedObjects: z.number().int().nonnegative(),
  lastCleanupFailedObjects: z.number().int().nonnegative(),
}).strict();

export type PipelineRetentionPreparation = z.infer<typeof preparationSchema>;
export type PipelineStorageCleanupClaim = z.infer<typeof cleanupClaimSchema>;
export type PipelineStorageCleanupAuthorization = z.infer<
  typeof cleanupAuthorizationSchema
>;
export type PipelineCleanupOutcome = z.infer<typeof cleanupOutcomeSchema>;
export type GuestRecoveryExpiry = z.infer<typeof guestRecoveryExpirySchema>;
export type PipelineOperationsHealth = z.infer<typeof healthSchema>;

type PipelineOperationsRpcName =
  | "expire_guest_draft_recoveries"
  | "prepare_pipeline_retention"
  | "claim_pipeline_storage_cleanup"
  | "authorize_pipeline_storage_cleanup"
  | "complete_pipeline_storage_cleanup"
  | "fail_pipeline_storage_cleanup"
  | "record_pipeline_cleanup_outcome"
  | "pipeline_operations_health";

interface PipelineOperationsRpcResult {
  data: unknown;
  error: { message: string } | null;
}

/** Fixed maintenance capability: deliberately no generic table access. */
export interface PipelineOperationsRpcClient {
  rpc(
    functionName: PipelineOperationsRpcName,
    args?: Record<string, unknown>,
  ): PromiseLike<PipelineOperationsRpcResult>;
}

export interface PipelineOperationsStore {
  expireGuestRecoveries(batchSize: number): Promise<GuestRecoveryExpiry>;
  prepareRetention(batchSize: number): Promise<PipelineRetentionPreparation>;
  claimStorageCleanup(leaseSeconds: number): Promise<PipelineStorageCleanupClaim>;
  authorizeStorageCleanup(
    jobId: string,
    leaseToken: string,
  ): Promise<PipelineStorageCleanupAuthorization>;
  completeStorageCleanup(jobId: string, leaseToken: string): Promise<boolean>;
  failStorageCleanup(
    jobId: string,
    leaseToken: string,
    safeError: string,
  ): Promise<boolean>;
  recordCleanupOutcome(input: PipelineCleanupOutcome): Promise<boolean>;
  health(): Promise<PipelineOperationsHealth>;
}

function rpcData(operation: string, result: PipelineOperationsRpcResult): unknown {
  if (result.error) {
    throw new Error(`Pipeline operations ${operation} failed: ${result.error.message}`);
  }
  return result.data;
}

const batchSizeSchema = z.number().int().min(1).max(100);
const leaseSecondsSchema = z.number().int().min(30).max(3_600);

export function createSupabasePipelineOperationsStore(
  client: PipelineOperationsRpcClient,
): PipelineOperationsStore {
  return {
    async expireGuestRecoveries(rawBatchSize) {
      const batchSize = batchSizeSchema.parse(rawBatchSize);
      const result = await client.rpc("expire_guest_draft_recoveries", {
        p_batch_size: batchSize,
      });
      return guestRecoveryExpirySchema.parse(
        rpcData("guest recovery expiry", result),
      );
    },

    async prepareRetention(rawBatchSize) {
      const batchSize = batchSizeSchema.parse(rawBatchSize);
      const result = await client.rpc("prepare_pipeline_retention", {
        p_batch_size: batchSize,
      });
      return preparationSchema.parse(rpcData("retention preparation", result));
    },

    async claimStorageCleanup(rawLeaseSeconds) {
      const leaseSeconds = leaseSecondsSchema.parse(rawLeaseSeconds);
      const result = await client.rpc("claim_pipeline_storage_cleanup", {
        p_lease_seconds: leaseSeconds,
      });
      return cleanupClaimSchema.parse(rpcData("cleanup claim", result));
    },

    async authorizeStorageCleanup(rawJobId, rawLeaseToken) {
      const jobId = z.string().uuid().parse(rawJobId);
      const leaseToken = z.string().uuid().parse(rawLeaseToken);
      const result = await client.rpc("authorize_pipeline_storage_cleanup", {
        p_job_id: jobId,
        p_lease_token: leaseToken,
      });
      return cleanupAuthorizationSchema.parse(
        rpcData("cleanup authorization", result),
      );
    },

    async completeStorageCleanup(rawJobId, rawLeaseToken) {
      const jobId = z.string().uuid().parse(rawJobId);
      const leaseToken = z.string().uuid().parse(rawLeaseToken);
      const result = await client.rpc("complete_pipeline_storage_cleanup", {
        p_job_id: jobId,
        p_lease_token: leaseToken,
      });
      return z.boolean().parse(rpcData("cleanup completion", result));
    },

    async failStorageCleanup(rawJobId, rawLeaseToken, rawSafeError) {
      const jobId = z.string().uuid().parse(rawJobId);
      const leaseToken = z.string().uuid().parse(rawLeaseToken);
      const safeError = z.string().min(1).max(200).parse(rawSafeError);
      const result = await client.rpc("fail_pipeline_storage_cleanup", {
        p_job_id: jobId,
        p_lease_token: leaseToken,
        p_safe_error: safeError,
      });
      return z.boolean().parse(rpcData("cleanup failure", result));
    },

    async recordCleanupOutcome(rawInput) {
      const input = cleanupOutcomeSchema.parse(rawInput);
      const result = await client.rpc("record_pipeline_cleanup_outcome", {
        p_summary: input,
      });
      return z.boolean().parse(rpcData("cleanup outcome", result));
    },

    async health() {
      const result = await client.rpc("pipeline_operations_health");
      return healthSchema.parse(rpcData("health", result));
    },
  };
}
