import { pipelineQueueEnvelopeSchema, type PipelineQueueEnvelope } from "./envelope";
import {
  parsePipelineQueueClaimOptions,
  parsePipelineQueueMessageId,
  type ClaimedPipelineQueueMessage,
  type PipelineQueue,
} from "./queue";

interface StoredMessage extends ClaimedPipelineQueueMessage {
  visibleAtMs: number;
}

export function createInMemoryPipelineQueue(options: { now?: () => Date } = {}): PipelineQueue {
  const now = options.now ?? (() => new Date());
  const messages = new Map<string, StoredMessage>();
  let nextId = 1;

  return {
    async enqueue(input: PipelineQueueEnvelope) {
      const envelope = pipelineQueueEnvelopeSchema.parse(input);
      const enqueuedAt = now();
      const id = String(nextId++);
      messages.set(id, {
        id,
        readCount: 0,
        enqueuedAt: enqueuedAt.toISOString(),
        visibleAt: enqueuedAt.toISOString(),
        visibleAtMs: enqueuedAt.getTime(),
        envelope,
      });
      return id;
    },

    async claim(input) {
      const claim = parsePipelineQueueClaimOptions(input);
      const claimedAt = now();
      const visibilityDeadline = new Date(
        claimedAt.getTime() + claim.visibilityTimeoutSeconds * 1_000,
      );
      const available = [...messages.values()]
        .filter((message) => message.visibleAtMs <= claimedAt.getTime())
        .sort((left, right) => Number(left.id) - Number(right.id))
        .slice(0, claim.limit);

      return available.map((message) => {
        message.readCount += 1;
        message.visibleAt = visibilityDeadline.toISOString();
        message.visibleAtMs = visibilityDeadline.getTime();
        return {
          id: message.id,
          readCount: message.readCount,
          enqueuedAt: message.enqueuedAt,
          visibleAt: message.visibleAt,
          envelope: message.envelope,
        };
      });
    },

    async ack(input) {
      const messageId = parsePipelineQueueMessageId(input);
      return messages.delete(messageId);
    },
  };
}
