import { z } from "zod";
import {
  extractedAttributesSchema,
  identificationSchema,
  listingCopySchema,
} from "@/lib/pipeline/types";
import { priceResultSchema } from "@/lib/pricing";
import { durablePriceEvidenceSchema } from "@/lib/pricing/approved-sold-provider";

export const PIPELINE_CHECKPOINT_MAX_JSONB_BYTES = 262_144;

function jsonbWhitespaceBytes(value: unknown): number {
  if (Array.isArray(value)) {
    return (
      Math.max(0, value.length - 1) +
      value.reduce((total, entry) => total + jsonbWhitespaceBytes(entry), 0)
    );
  }
  if (value && typeof value === "object") {
    const entries = Object.values(value).filter(
      (entry) => entry !== undefined,
    );
    return (
      entries.length +
      Math.max(0, entries.length - 1) +
      entries.reduce((total, entry) => total + jsonbWhitespaceBytes(entry), 0)
    );
  }
  return 0;
}

/** Match PostgreSQL `octet_length(jsonb::text)` before attempting the RPC. */
export function pipelineCheckpointJsonbByteLength(value: unknown): number {
  return (
    new TextEncoder().encode(JSON.stringify(value)).byteLength +
    jsonbWhitespaceBytes(value)
  );
}

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
    /** Compact service-role-written projection consumed only by the RLS loader. */
    priceEvidence: durablePriceEvidenceSchema.optional(),
    generated: generatedPipelineStageSchema.optional(),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    if (
      pipelineCheckpointJsonbByteLength(checkpoint) >
      PIPELINE_CHECKPOINT_MAX_JSONB_BYTES
    ) {
      context.addIssue({
        code: "custom",
        message: "Pipeline checkpoint exceeds the database byte limit",
        path: [],
      });
    }
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
  });

export type IdentifiedPipelineStage = z.infer<typeof identifiedPipelineStageSchema>;
export type GeneratedPipelineStage = z.infer<typeof generatedPipelineStageSchema>;
export type PipelineWorkerCheckpoint = z.infer<typeof pipelineWorkerCheckpointSchema>;
