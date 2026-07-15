import { z } from "zod";
import {
  pipelineStageBatchInputSchema,
  pipelineStageBatchResultSchema,
  type PipelineStageBatchInput,
  type PipelineStageBatchResult,
} from "./schema";

type PipelineStagingRpcName =
  | "stage_pipeline_batch"
  | "release_pipeline_run_daily_reservation";

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
  stageAndEnqueue(input: PipelineStageBatchInput): Promise<PipelineStageBatchResult>;
  releaseDailyReservation(runId: string): Promise<boolean>;
}

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
  };
}
