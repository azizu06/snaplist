import { z } from "zod";
import { recoveryRegistrationSchema } from "@/lib/guest-recovery/recovery-store";
import {
  buildPipelinePersistencePayload,
  pipelineResultSchema,
  type PipelineResult,
} from "@/lib/pipeline";
import { providerUsageRecordSchema } from "@/lib/provider-usage/schema";
import type { ProviderUsageRecord } from "@/lib/provider-usage";
import {
  pipelineWorkerCheckpointSchema,
  pipelineWorkerCheckpointWriteSchema,
  type PipelineWorkerCheckpoint,
  type PipelineWorkerCheckpointWrite,
} from "./checkpoint";

export const pipelineRunStatusSchema = z.enum([
  "queued",
  "running",
  "retrying",
  "succeeded",
  "failed",
  "canceled",
]);

export const pipelineRunStageSchema = z.enum([
  "queued",
  "identifying",
  "pricing",
  "generating",
  "persisting",
  "completed",
]);

export type PipelineRunStatus = z.infer<typeof pipelineRunStatusSchema>;
export type PipelineRunStage = z.infer<typeof pipelineRunStageSchema>;

const workerRunSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().min(1),
  item_id: z.string().uuid(),
  listing_id: z.string().uuid().nullable(),
  status: pipelineRunStatusSchema,
  stage: pipelineRunStageSchema,
  schema_version: z.literal(1),
  attempt_count: z.number().int().min(0),
  max_attempts: z.number().int().positive(),
  autopilot_enabled: z.boolean(),
  checkpoint: pipelineWorkerCheckpointSchema,
  lease_token: z.string().uuid(),
  lease_expires_at: z.string().min(1),
  next_attempt_at: z.string().nullable(),
  recovery_id: z.string().uuid().nullable(),
  recovery_token_hash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
});

const workerContextSchema = z.object({
  run: workerRunSchema,
  item: z.object({
    id: z.string().uuid(),
    user_id: z.string().min(1),
    photos: z.array(z.string()),
    photo_identity_kind: z.enum([
      "legacy_path_v0",
      "content_sha256_set_v1",
    ]),
    photo_identity_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    attributes: z.record(z.string(), z.unknown()),
    condition: z.string().nullable(),
    cost_basis: z.union([z.string(), z.number()]).nullable(),
    review_revision: z.string().uuid(),
    review_content_revision: z.string().uuid(),
  }),
});

export type PipelineWorkerContext = z.infer<typeof workerContextSchema>;

const acquisitionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("acquired"), context: workerContextSchema }).strict(),
  z
    .object({
      kind: z.literal("deferred"),
      retryAfterSeconds: z.number().int().min(1).max(3_600),
    })
    .strict(),
  z
    .object({
      kind: z.literal("terminal"),
      status: z.enum(["succeeded", "failed", "canceled"]),
    })
    .strict(),
  z.object({ kind: z.literal("mismatch") }).strict(),
]);

export type PipelineAttemptAcquisition = z.infer<typeof acquisitionSchema>;

const failureResultSchema = z
  .object({
    status: z.enum(["retrying", "failed"]),
    retryAfterSeconds: z.number().int().min(1).max(3_600).nullable(),
  })
  .strict();

export type PipelineAttemptFailureResult = z.infer<typeof failureResultSchema>;

type PipelineWorkerRpcName =
  | "claim_pipeline_run_attempt"
  | "checkpoint_pipeline_run"
  | "stage_guest_recovery_upload_cleanup"
  | "complete_pipeline_run_with_guest_recovery"
  | "finish_pipeline_run_attempt"
  | "reject_pipeline_message"
  | "record_pipeline_run_provider_usage";

interface PipelineWorkerRpcResult {
  data: unknown;
  error: { message: string } | null;
}

/** Fixed run-derived RPC capability; deliberately has no generic table surface. */
export interface PipelineWorkerRpcClient {
  rpc(
    functionName: PipelineWorkerRpcName,
    args: Record<string, unknown>,
  ): PromiseLike<PipelineWorkerRpcResult>;
}

export interface PipelineWorkerStore {
  acquire(input: {
    runId: string;
    messageId: string;
    leaseSeconds: number;
  }): Promise<PipelineAttemptAcquisition>;
  checkpoint(input: {
    runId: string;
    leaseToken: string;
    stage: Exclude<PipelineRunStage, "queued" | "completed">;
    checkpoint: PipelineWorkerCheckpointWrite;
    leaseSeconds: number;
  }): Promise<PipelineWorkerCheckpoint>;
  stageGuestRecoveryUploadCleanup(input: {
    runId: string;
    leaseToken: string;
    paths: string[];
  }): Promise<void>;
  complete(input: {
    runId: string;
    leaseToken: string;
    result: PipelineResult;
    autopilotEnabled: boolean;
    guestRecoveryRegistration?: z.infer<typeof recoveryRegistrationSchema> | null;
  }): Promise<{ listingId: string }>;
  /**
   * Persist what the attempt spent at paid providers (#716). Run-scoped and
   * lease-authenticated like every other worker write, so ownership is derived
   * from the stored run rather than asserted by the caller.
   */
  recordProviderUsage(input: {
    runId: string;
    leaseToken: string;
    usage: ProviderUsageRecord;
  }): Promise<void>;
  failAttempt(input: {
    runId: string;
    leaseToken: string;
    retryable: boolean;
    retryAfterSeconds: number;
    failureCode: string;
    safeFailureMessage: string;
  }): Promise<PipelineAttemptFailureResult>;
  rejectMessage(input: {
    runId: string;
    messageId: string;
    failureCode: string;
    safeFailureMessage: string;
  }): Promise<boolean>;
}

function rpcData(operation: string, result: PipelineWorkerRpcResult): unknown {
  if (result.error) {
    throw new Error(`Pipeline worker ${operation} failed: ${result.error.message}`);
  }
  return result.data;
}

const positiveIntegerString = z.string().regex(/^[1-9]\d*$/);
const leaseSecondsSchema = z.number().int().min(1).max(3_600);

export function createSupabasePipelineWorkerStore(
  client: PipelineWorkerRpcClient,
): PipelineWorkerStore {
  return {
    async acquire(input) {
      const parsed = z
        .object({
          runId: z.string().uuid(),
          messageId: positiveIntegerString,
          leaseSeconds: leaseSecondsSchema,
        })
        .strict()
        .parse(input);
      const result = await client.rpc("claim_pipeline_run_attempt", {
        p_lease_seconds: parsed.leaseSeconds,
        p_message_id: parsed.messageId,
        p_run_id: parsed.runId,
      });
      return acquisitionSchema.parse(rpcData("attempt claim", result));
    },

    async checkpoint(input) {
      const parsed = z
        .object({
          runId: z.string().uuid(),
          leaseToken: z.string().uuid(),
          stage: pipelineRunStageSchema.exclude(["queued", "completed"]),
          checkpoint: pipelineWorkerCheckpointWriteSchema,
          leaseSeconds: leaseSecondsSchema,
        })
        .strict()
        .parse(input);
      const result = await client.rpc("checkpoint_pipeline_run", {
        p_checkpoint: parsed.checkpoint,
        p_lease_seconds: parsed.leaseSeconds,
        p_lease_token: parsed.leaseToken,
        p_run_id: parsed.runId,
        p_stage: parsed.stage,
      });
      return pipelineWorkerCheckpointSchema.parse(rpcData("checkpoint", result));
    },

    async stageGuestRecoveryUploadCleanup(input) {
      const parsed = z
        .object({
          runId: z.string().uuid(),
          leaseToken: z.string().uuid(),
          paths: z.array(z.string().min(1).max(1_024)).min(1).max(5),
        })
        .strict()
        .parse(input);
      const result = await client.rpc("stage_guest_recovery_upload_cleanup", {
        p_lease_token: parsed.leaseToken,
        p_photo_paths: parsed.paths,
        p_run_id: parsed.runId,
      });
      z.literal(true).parse(rpcData("guest recovery upload cleanup staging", result));
    },

    /**
     * `p_persistence` needs no separate `jsonb` repair, but only transitively:
     * the durable processor assembles the result from checkpoint content it read
     * back from `checkpoint_pipeline_run` (already repaired at the write
     * boundary), and `assemble` is pure recomposition that introduces no new
     * model strings. A future producer that reaches this RPC with fresh model
     * output would need its own pass.
     */
    async complete(input) {
      const parsed = z
        .object({
          runId: z.string().uuid(),
          leaseToken: z.string().uuid(),
          result: pipelineResultSchema,
          autopilotEnabled: z.boolean(),
          guestRecoveryRegistration: recoveryRegistrationSchema.nullable().optional().default(null),
        })
        .strict()
        .parse(input);
      const persistence = buildPipelinePersistencePayload(
        parsed.result,
        parsed.autopilotEnabled,
      );
      const result = await client.rpc("complete_pipeline_run_with_guest_recovery", {
        p_guest_recovery_registration: parsed.guestRecoveryRegistration,
        p_lease_token: parsed.leaseToken,
        p_persistence: persistence,
        p_run_id: parsed.runId,
      });
      return z
        .object({ listingId: z.string().uuid() })
        .strict()
        .parse(rpcData("completion", result));
    },

    async recordProviderUsage(input) {
      const parsed = z
        .object({
          runId: z.string().uuid(),
          leaseToken: z.string().uuid(),
          usage: providerUsageRecordSchema,
        })
        .strict()
        .parse(input);
      const result = await client.rpc("record_pipeline_run_provider_usage", {
        p_lease_token: parsed.leaseToken,
        p_run_id: parsed.runId,
        p_usage: parsed.usage,
      });
      rpcData("provider usage recording", result);
    },

    async failAttempt(input) {
      const parsed = z
        .object({
          runId: z.string().uuid(),
          leaseToken: z.string().uuid(),
          retryable: z.boolean(),
          retryAfterSeconds: leaseSecondsSchema,
          failureCode: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
          safeFailureMessage: z.string().min(1).max(500),
        })
        .strict()
        .parse(input);
      const result = await client.rpc("finish_pipeline_run_attempt", {
        p_failure_code: parsed.failureCode,
        p_failure_message: parsed.safeFailureMessage,
        p_lease_token: parsed.leaseToken,
        p_retry_after_seconds: parsed.retryAfterSeconds,
        p_retryable: parsed.retryable,
        p_run_id: parsed.runId,
      });
      return failureResultSchema.parse(rpcData("attempt finish", result));
    },

    async rejectMessage(input) {
      const parsed = z
        .object({
          runId: z.string().uuid(),
          messageId: positiveIntegerString,
          failureCode: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
          safeFailureMessage: z.string().min(1).max(500),
        })
        .strict()
        .parse(input);
      const result = await client.rpc("reject_pipeline_message", {
        p_failure_code: parsed.failureCode,
        p_failure_message: parsed.safeFailureMessage,
        p_message_id: parsed.messageId,
        p_run_id: parsed.runId,
      });
      return z.boolean().parse(rpcData("message rejection", result));
    },
  };
}
