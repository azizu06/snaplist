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
  /** Strictly validated by the consumer so one bad row cannot poison a whole batch. */
  envelope: unknown;
}

export interface PipelineQueue {
  enqueue(envelope: PipelineQueueEnvelope): Promise<string>;
  claim(options: PipelineQueueClaimOptions): Promise<ClaimedPipelineQueueMessage[]>;
  ack(messageId: string): Promise<boolean>;
  defer(messageId: string, visibilityTimeoutSeconds: number): Promise<boolean>;
}

export function parsePipelineQueueVisibilityTimeoutSeconds(value: unknown): number {
  return z.number().int().min(1).max(3_600).parse(value);
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
