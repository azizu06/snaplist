import { z } from "zod";

export const pipelineConsumerSummarySchema = z
  .object({
    claimed: z.number().int().min(0),
    succeeded: z.number().int().min(0),
    retrying: z.number().int().min(0),
    failed: z.number().int().min(0),
    skipped: z.number().int().min(0),
  })
  .strict();
