import { z } from "zod";
import {
  pipelineQueueEnvelopeSchema,
  type PipelineQueueEnvelope,
} from "./envelope";
import {
  parsePipelineQueueClaimOptions,
  parsePipelineQueueMessageId,
  parsePipelineQueueVisibilityTimeoutSeconds,
  type PipelineQueue,
} from "./queue";

type PipelineQueueRpcName =
  | "enqueue_pipeline_message"
  | "claim_pipeline_messages"
  | "ack_pipeline_message"
  | "defer_pipeline_message";

interface PipelineQueueRpcResult {
  data: unknown;
  error: { message: string } | null;
}

/**
 * Deliberately narrower than `SupabaseClient`: the queue authority can invoke
 * only these fixed RPC names and has no `.from()` tenant-domain escape hatch.
 */
export interface PipelineQueueRpcClient {
  rpc(
    functionName: PipelineQueueRpcName,
    args: Record<string, unknown>,
  ): PromiseLike<PipelineQueueRpcResult>;
}

const claimedRowSchema = z
  .object({
    message_id: z.union([z.string(), z.number(), z.bigint()]),
    read_count: z.coerce.number().int().min(1),
    enqueued_at: z.string().min(1),
    visible_at: z.string().min(1),
    envelope: z.unknown(),
  })
  .strict();

function rpcFailure(operation: string, error: { message: string } | null): void {
  if (error) throw new Error(`Pipeline queue ${operation} failed: ${error.message}`);
}

export function createSupabasePgmqPipelineQueue(
  client: PipelineQueueRpcClient,
): PipelineQueue {
  return {
    async enqueue(input: PipelineQueueEnvelope) {
      const envelope = pipelineQueueEnvelopeSchema.parse(input);
      const { data, error } = await client.rpc("enqueue_pipeline_message", {
        p_run_id: envelope.run_id,
        p_schema_version: envelope.schema_version,
      });
      rpcFailure("enqueue", error);
      return parsePipelineQueueMessageId(data);
    },

    async claim(input) {
      const claim = parsePipelineQueueClaimOptions(input);
      const { data, error } = await client.rpc("claim_pipeline_messages", {
        p_quantity: claim.limit,
        p_visibility_timeout_seconds: claim.visibilityTimeoutSeconds,
      });
      rpcFailure("claim", error);
      const rows = z.array(claimedRowSchema).parse(data ?? []);
      return rows.map((row) => ({
        id: parsePipelineQueueMessageId(row.message_id),
        readCount: row.read_count,
        enqueuedAt: row.enqueued_at,
        visibleAt: row.visible_at,
        envelope: row.envelope,
      }));
    },

    async ack(input) {
      const messageId = parsePipelineQueueMessageId(input);
      const { data, error } = await client.rpc("ack_pipeline_message", {
        p_message_id: messageId,
      });
      rpcFailure("ack", error);
      return z.boolean().parse(data);
    },

    async defer(input, visibilityTimeoutSeconds) {
      const messageId = parsePipelineQueueMessageId(input);
      const timeout = parsePipelineQueueVisibilityTimeoutSeconds(
        visibilityTimeoutSeconds,
      );
      const { data, error } = await client.rpc("defer_pipeline_message", {
        p_message_id: messageId,
        p_visibility_timeout_seconds: timeout,
      });
      rpcFailure("defer", error);
      return z.boolean().parse(data);
    },
  };
}
