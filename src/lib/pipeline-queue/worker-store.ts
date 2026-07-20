import { z } from "zod";
import {
  buildPipelinePersistencePayload,
  pipelineResultSchema,
  type PipelineResult,
} from "@/lib/pipeline";
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
});

const workerContextSchema = z.object({
  run: workerRunSchema,
  item: z.object({
    id: z.string().uuid(),
    user_id: z.string().min(1),
    photos: z.array(z.string()),
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
  | "complete_pipeline_run"
  | "finish_pipeline_run_attempt"
  | "reject_pipeline_message";

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
  complete(input: {
    runId: string;
    leaseToken: string;
    result: PipelineResult;
    autopilotEnabled: boolean;
  }): Promise<{ listingId: string }>;
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

    async complete(input) {
      const parsed = z
        .object({
          runId: z.string().uuid(),
          leaseToken: z.string().uuid(),
          result: pipelineResultSchema,
          autopilotEnabled: z.boolean(),
        })
        .strict()
        .parse(input);
      const persistence = buildPipelinePersistencePayload(
        parsed.result,
        parsed.autopilotEnabled,
      );
      const result = await client.rpc("complete_pipeline_run", {
        p_lease_token: parsed.leaseToken,
        p_persistence: persistence,
        p_run_id: parsed.runId,
      });
      return z
        .object({ listingId: z.string().uuid() })
        .strict()
        .parse(rpcData("completion", result));
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
