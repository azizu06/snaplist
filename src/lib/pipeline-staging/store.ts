import { z } from "zod";
import {
  pipelineStageBatchInputSchema,
  pipelineStageBatchResultSchema,
  pipelineReplayBatchInputSchema,
  pipelineStagingCleanupIntentInputSchema,
  type PipelineReplayBatchInput,
  type PipelineStageBatchInput,
  type PipelineStageBatchResult,
  type PipelineStagingCleanupIntentInput,
} from "./schema";

type PipelineStagingRpcName =
  | "find_pipeline_batch_replay"
  | "stage_pipeline_batch"
  | "release_pipeline_run_daily_reservation"
  | "reserve_legacy_pipeline_usage"
  | "release_legacy_pipeline_usage"
  | "record_pipeline_staging_cleanup_intent"
  | "resolve_pipeline_staging_cleanup_intent";

interface PipelineStagingRpcResult {
  data: unknown;
  error: { message: string } | null;
}

/** Fixed producer capability: it deliberately has no generic `.from()` surface. */
export interface PipelineStagingRpcClient {
  rpc(
    functionName: PipelineStagingRpcName,
    args: Record<string, unknown>,
  ): PromiseLike<PipelineStagingRpcResult>;
}

export interface PipelineStagingStore {
  findReplay(input: PipelineReplayBatchInput): Promise<PipelineStageBatchResult>;
  stageAndEnqueue(input: PipelineStageBatchInput): Promise<PipelineStageBatchResult>;
  releaseDailyReservation(runId: string): Promise<boolean>;
  reserveLegacyUsage(input: LegacyPipelineUsageInput): Promise<boolean>;
  releaseLegacyDailyReservation(reservationId: string): Promise<boolean>;
  recordCleanupIntent(input: PipelineStagingCleanupIntentInput): Promise<boolean>;
  resolveCleanupIntent(cleanupId: string): Promise<boolean>;
}

const legacyPipelineUsageInputSchema = z.object({
  reservationId: z.string().uuid(),
  userId: z.string().min(1).max(255),
  dailyLimit: z.number().int().positive().max(10_000),
  perMinuteLimit: z.number().int().positive().max(10_000),
}).strict();

export type LegacyPipelineUsageInput = z.infer<
  typeof legacyPipelineUsageInputSchema
>;

function rpcData(operation: string, result: PipelineStagingRpcResult): unknown {
  if (result.error) {
    throw new Error(`Pipeline ${operation} failed: ${result.error.message}`);
  }
  return result.data;
}

export function createSupabasePipelineStagingStore(
  client: PipelineStagingRpcClient,
): PipelineStagingStore {
  return {
    async findReplay(rawInput) {
      const input = pipelineReplayBatchInputSchema.parse(rawInput);
      const result = await client.rpc("find_pipeline_batch_replay", {
        p_batch_id: input.batchId,
        p_entries: input.entries.map((entry) => ({
          autopilot_enabled: entry.autopilotEnabled,
          cost_basis: entry.costBasis,
          idempotency_key: entry.idempotencyKey,
          photo_count: entry.photoCount,
          source: entry.source,
        })),
        p_user_id: input.userId,
      });
      return pipelineStageBatchResultSchema.parse(rpcData("replay lookup", result));
    },

    async stageAndEnqueue(rawInput) {
      const input = pipelineStageBatchInputSchema.parse(rawInput);
      const result = await client.rpc("stage_pipeline_batch", {
        p_batch_id: input.batchId,
        p_daily_limit: input.dailyLimit,
        p_entries: input.entries.map((entry) => ({
          autopilot_enabled: entry.autopilotEnabled,
          cost_basis: entry.costBasis,
          idempotency_key: entry.idempotencyKey,
          photo_paths: entry.photoPaths,
          source: entry.source,
        })),
        p_per_minute_limit: input.perMinuteLimit,
        p_user_id: input.userId,
      });
      return pipelineStageBatchResultSchema.parse(rpcData("staging", result));
    },

    async releaseDailyReservation(runId) {
      const id = z.string().uuid().parse(runId);
      const result = await client.rpc("release_pipeline_run_daily_reservation", {
        p_run_id: id,
      });
      return z.boolean().parse(rpcData("quota release", result));
    },

    async reserveLegacyUsage(rawInput) {
      const input = legacyPipelineUsageInputSchema.parse(rawInput);
      const result = await client.rpc("reserve_legacy_pipeline_usage", {
        p_daily_limit: input.dailyLimit,
        p_per_minute_limit: input.perMinuteLimit,
        p_reservation_id: input.reservationId,
        p_user_id: input.userId,
      });
      return z.boolean().parse(rpcData("legacy usage reservation", result));
    },

    async releaseLegacyDailyReservation(reservationId) {
      const id = z.string().uuid().parse(reservationId);
      const result = await client.rpc("release_legacy_pipeline_usage", {
        p_reservation_id: id,
      });
      return z.boolean().parse(rpcData("legacy quota release", result));
    },

    async recordCleanupIntent(rawInput) {
      const input = pipelineStagingCleanupIntentInputSchema.parse(rawInput);
      const result = await client.rpc("record_pipeline_staging_cleanup_intent", {
        p_batch_id: input.batchId,
        p_cleanup_id: input.cleanupId,
        p_photo_paths: input.photoPaths,
        p_user_id: input.userId,
      });
      return z.boolean().parse(rpcData("staging cleanup registration", result));
    },

    async resolveCleanupIntent(cleanupId) {
      const id = z.string().uuid().parse(cleanupId);
      const result = await client.rpc("resolve_pipeline_staging_cleanup_intent", {
        p_cleanup_id: id,
      });
      return z.boolean().parse(rpcData("staging cleanup resolution", result));
    },
  };
}
