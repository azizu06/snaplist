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

export const pipelineWorkerCheckpointSchema = z
  .object({
    identified: identifiedPipelineStageSchema.optional(),
    priced: priceResultSchema.optional(),
    /** Service-role-written duplicate consumed only by the RLS loader; raw JSON stays untrusted. */
    priceEvidence: priceResultSchema.optional(),
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
    if (checkpoint.priceEvidence && !checkpoint.priced) {
      context.addIssue({
        code: "custom",
        message: "A price-evidence checkpoint requires a pricing checkpoint",
        path: ["priceEvidence"],
      });
    }
    if (
      checkpoint.priceEvidence &&
      checkpoint.priced &&
      JSON.stringify(checkpoint.priceEvidence) !==
        JSON.stringify(checkpoint.priced)
    ) {
      context.addIssue({
        code: "custom",
        message: "Price evidence must match the persisted pricing checkpoint",
        path: ["priceEvidence"],
      });
    }
  });

export type IdentifiedPipelineStage = z.infer<typeof identifiedPipelineStageSchema>;
export type GeneratedPipelineStage = z.infer<typeof generatedPipelineStageSchema>;
export type PipelineWorkerCheckpoint = z.infer<typeof pipelineWorkerCheckpointSchema>;
