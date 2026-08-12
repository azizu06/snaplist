import { z } from "zod";
import {
  extractedAttributesSchema,
  identificationSchema,
  listingCopySchema,
  sellerContextSchema,
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

const sellerVoiceCheckpointIdentitySchema = z.object({
  version: z.literal(1),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const sellerVoiceGenerationBindingSchema = sellerVoiceCheckpointIdentitySchema
  .extend({
    outcome: z.enum([
      "transcribed",
      "empty",
      "unsupported",
      "timed-out",
      "failed",
    ]),
  })
  .strict();

export const sellerVoiceTranscriptionAttemptSchema = z
  .object({
    role: z.literal("sellerContext"),
    provider: z.enum(["openai", "google"]),
    model: z.string().min(1).max(200),
    calls: z.literal(1),
    chargedUsd: z.null(),
  })
  .strict();

const sellerVoiceGenerationSchema = z
  .object({
    voice: sellerVoiceGenerationBindingSchema,
    generated: generatedPipelineStageSchema,
  })
  .strict();

export const sellerVoiceAttemptCheckpointSchema =
  sellerVoiceCheckpointIdentitySchema
    .extend({
      transcriptionAttempt: sellerVoiceTranscriptionAttemptSchema.optional(),
    })
    .strict();

export const sellerVoiceCheckpointSchema = z.discriminatedUnion("outcome", [
  sellerVoiceCheckpointIdentitySchema
    .extend({
      outcome: z.literal("transcribed"),
      providerContacted: z.literal(true),
      sellerContext: sellerContextSchema,
      transcriptionAttempt: sellerVoiceTranscriptionAttemptSchema.optional(),
    })
    .strict(),
  sellerVoiceCheckpointIdentitySchema
    .extend({
      outcome: z.enum(["empty", "unsupported", "timed-out", "failed"]),
      providerContacted: z.boolean(),
      sellerContext: z.null(),
      transcriptionAttempt: sellerVoiceTranscriptionAttemptSchema.optional(),
    })
    .strict(),
]);

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
    voiceAttempt?: unknown;
    voice?: unknown;
    voiceGenerations?: unknown;
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
  if ((checkpoint.voiceAttempt || checkpoint.voice) && !checkpoint.identified) {
    context.addIssue({
      code: "custom",
      message: "A seller voice checkpoint requires an identification checkpoint",
      path: ["voice"],
    });
  }
  if (checkpoint.voiceGenerations && !checkpoint.generated) {
    context.addIssue({
      code: "custom",
      message: "A seller voice generation requires the base generation checkpoint",
      path: ["voiceGenerations"],
    });
  }
}

export const pipelineWorkerCheckpointSchema = z
  .object({
    identified: identifiedPipelineStageSchema.optional(),
    priced: pricedPipelineStageSchema.optional(),
    generated: generatedPipelineStageSchema.optional(),
    voiceAttempt: sellerVoiceAttemptCheckpointSchema.optional(),
    voice: sellerVoiceCheckpointSchema.optional(),
    voiceGenerations: z.array(sellerVoiceGenerationSchema).max(4).optional(),
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
      voiceAttempt: sellerVoiceAttemptCheckpointSchema.optional(),
      voice: sellerVoiceCheckpointSchema.optional(),
      voiceGenerations: z.array(sellerVoiceGenerationSchema).max(4).optional(),
    })
    .strict()
    .superRefine(requireCheckpointOrder),
);

export type IdentifiedPipelineStage = z.infer<typeof identifiedPipelineStageSchema>;
export type PricedPipelineStage = z.infer<typeof pricedPipelineStageSchema>;
export type GeneratedPipelineStage = z.infer<typeof generatedPipelineStageSchema>;
export type SellerVoiceCheckpoint = z.infer<typeof sellerVoiceCheckpointSchema>;
export type SellerVoiceTranscriptionAttempt = z.infer<
  typeof sellerVoiceTranscriptionAttemptSchema
>;
export type PipelineWorkerCheckpoint = z.infer<typeof pipelineWorkerCheckpointSchema>;
export type PipelineWorkerCheckpointWrite = z.infer<
  typeof pipelineWorkerCheckpointWriteSchema
>;
