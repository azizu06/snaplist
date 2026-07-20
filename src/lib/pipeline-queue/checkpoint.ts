import { z } from "zod";
import {
  extractedAttributesSchema,
  identificationSchema,
  listingCopySchema,
} from "@/lib/pipeline/types";
import { priceResultSchema } from "@/lib/pricing";

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

export const pipelineWorkerCheckpointSchema = z
  .object({
    identified: identifiedPipelineStageSchema.optional(),
    priced: pricedPipelineStageSchema.optional(),
    generated: generatedPipelineStageSchema.optional(),
  })
  .strict()
  .superRefine((checkpoint, context) => {
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
  });

export type IdentifiedPipelineStage = z.infer<typeof identifiedPipelineStageSchema>;
export type PricedPipelineStage = z.infer<typeof pricedPipelineStageSchema>;
export type GeneratedPipelineStage = z.infer<typeof generatedPipelineStageSchema>;
export type PipelineWorkerCheckpoint = z.infer<typeof pipelineWorkerCheckpointSchema>;
