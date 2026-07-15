import { z } from "zod";

export const PIPELINE_QUEUE_SCHEMA_VERSION = 1 as const;

/**
 * The durable queue is a wake-up signal, not a tenant-data transport. The
 * worker resolves every other fact from `pipeline_runs` through its audited
 * run-scoped database capability.
 */
export const pipelineQueueEnvelopeSchema = z
  .object({
    run_id: z.string().uuid(),
    schema_version: z.literal(PIPELINE_QUEUE_SCHEMA_VERSION),
  })
  .strict();

export type PipelineQueueEnvelope = z.infer<typeof pipelineQueueEnvelopeSchema>;

export function createPipelineQueueEnvelope(runId: string): PipelineQueueEnvelope {
  return pipelineQueueEnvelopeSchema.parse({
    run_id: runId,
    schema_version: PIPELINE_QUEUE_SCHEMA_VERSION,
  });
}
