import { z } from "zod";
import type { PipelineQueueEnvelope } from "./envelope";

const claimOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(100),
    visibilityTimeoutSeconds: z.number().int().min(1).max(3_600),
  })
  .strict();

export interface PipelineQueueClaimOptions {
  limit: number;
  visibilityTimeoutSeconds: number;
}

export interface ClaimedPipelineQueueMessage {
  id: string;
  readCount: number;
  enqueuedAt: string;
  visibleAt: string;
  envelope: PipelineQueueEnvelope;
}

export interface PipelineQueue {
  enqueue(envelope: PipelineQueueEnvelope): Promise<string>;
  claim(options: PipelineQueueClaimOptions): Promise<ClaimedPipelineQueueMessage[]>;
  ack(messageId: string): Promise<boolean>;
}

export function parsePipelineQueueClaimOptions(
  options: PipelineQueueClaimOptions,
): PipelineQueueClaimOptions {
  return claimOptionsSchema.parse(options);
}

export function parsePipelineQueueMessageId(value: unknown): string {
  const normalized = String(value);
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error("Pipeline queue message id must be a positive integer");
  }
  return normalized;
}
