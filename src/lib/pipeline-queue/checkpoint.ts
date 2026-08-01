import { z } from "zod";
import {
  extractedAttributesSchema,
  identificationSchema,
  listingCopySchema,
} from "@/lib/pipeline/types";
import { priceResultSchema } from "@/lib/pricing";
import { toJsonbSafe } from "./jsonb-safe";

export const identifiedPipelineStageSchema = z
  .object({
    attributes: extractedAttributesSchema,
    identification: identificationSchema.optional(),
    model: z.string().min(1),
  })
  .strict();

export const generatedPipelineStageSchema = z
  .object({
    copy: listingCopySchema,
    model: z.string().min(1),
  })
  .strict();

export const pricedPipelineStageSchema = z
  .object({
    result: priceResultSchema,
    evidenceAsOf: z.string().datetime({ offset: true }),
  })
  .strict();

const pricedPipelineStageWriteSchema = z
  .object({
    result: priceResultSchema,
    evidenceAsOf: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

function requireCheckpointOrder(
  checkpoint: {
    identified?: unknown;
    priced?: unknown;
    generated?: unknown;
  },
  context: z.RefinementCtx,
): void {
  if (checkpoint.priced && !checkpoint.identified) {
    context.addIssue({
      code: "custom",
      message: "A pricing checkpoint requires an identification checkpoint",
      path: ["priced"],
    });
  }
  if (checkpoint.generated && !checkpoint.identified) {
    context.addIssue({
      code: "custom",
      message: "A generation checkpoint requires an identification checkpoint",
      path: ["generated"],
    });
  }
}

export const pipelineWorkerCheckpointSchema = z
  .object({
    identified: identifiedPipelineStageSchema.optional(),
    priced: pricedPipelineStageSchema.optional(),
    generated: generatedPipelineStageSchema.optional(),
  })
  .strict()
  .superRefine(requireCheckpointOrder);

/**
 * The write boundary repairs PostgreSQL-unsafe strings before validation, so no
 * checkpoint the worker builds can reach the `checkpoint_pipeline_run` RPC with
 * content `jsonb` refuses to store. Without it the RPC returns a generic error,
 * the worker classifies it as retryable, and the run re-runs the paid
 * identification stage into the same rejection until it dead-letters.
 *
 * Repair runs ahead of `.strict()`, so an unsafe *top-level* key would be
 * repaired into a recognized one rather than rejected as unrecognized. The
 * write input is assembled from typed stage objects, never raw model JSON, so
 * no caller can reach that.
 */
export const pipelineWorkerCheckpointWriteSchema = z.preprocess(
  toJsonbSafe,
  z
    .object({
      identified: identifiedPipelineStageSchema.optional(),
      priced: pricedPipelineStageWriteSchema.optional(),
      generated: generatedPipelineStageSchema.optional(),
    })
    .strict()
    .superRefine(requireCheckpointOrder),
);

export type IdentifiedPipelineStage = z.infer<typeof identifiedPipelineStageSchema>;
export type PricedPipelineStage = z.infer<typeof pricedPipelineStageSchema>;
export type GeneratedPipelineStage = z.infer<typeof generatedPipelineStageSchema>;
export type PipelineWorkerCheckpoint = z.infer<typeof pipelineWorkerCheckpointSchema>;
export type PipelineWorkerCheckpointWrite = z.infer<
  typeof pipelineWorkerCheckpointWriteSchema
>;
