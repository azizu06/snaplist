import { z } from "zod";

const storagePathSchema = z
  .string()
  .min(3)
  .max(1_024)
  .refine((value) => !value.includes("://") && !/[?#]/.test(value), {
    message: "Photo paths must be private Storage object paths, not URLs",
  });

const MAX_SINGLE_ITEM_PHOTOS = 5;
const MAX_BATCH_ITEM_PHOTOS = 4;

export const pipelineStageEntrySchema = z
  .object({
    idempotencyKey: z.string().min(1).max(128),
    source: z.enum(["single", "batch"]),
    autopilotEnabled: z.boolean(),
    photoPaths: z.array(storagePathSchema).min(1).max(MAX_SINGLE_ITEM_PHOTOS),
    costBasis: z.number().finite().nonnegative().nullable(),
  })
  .strict();

export const pipelineStageBatchInputSchema = z
  .object({
    batchId: z.string().uuid(),
    userId: z.string().min(1).max(255),
    dailyLimit: z.number().int().positive().max(10_000),
    perMinuteLimit: z.number().int().positive().max(10_000),
    entries: z.array(pipelineStageEntrySchema).min(1).max(200),
  })
  .strict()
  .superRefine((input, context) => {
    const keys = new Set<string>();
    for (const [index, entry] of input.entries.entries()) {
      if (
        entry.source === "batch" &&
        entry.photoPaths.length > MAX_BATCH_ITEM_PHOTOS
      ) {
        context.addIssue({
          code: "custom",
          message: "Batch items accept at most 4 photos",
          path: ["entries", index, "photoPaths"],
        });
      }
      if (keys.has(entry.idempotencyKey)) {
        context.addIssue({
          code: "custom",
          message: "Idempotency keys must be unique within a batch",
          path: ["entries", index, "idempotencyKey"],
        });
      }
      keys.add(entry.idempotencyKey);
      for (const [photoIndex, path] of entry.photoPaths.entries()) {
        if (!path.startsWith(`${input.userId}/`)) {
          context.addIssue({
            code: "custom",
            message: "Photo paths must use the owning seller prefix",
            path: ["entries", index, "photoPaths", photoIndex],
          });
        }
      }
    }
  });

const pipelineStageResultSchema = z
  .object({
    batch_id: z.string().uuid(),
    batch_position: z.number().int().nonnegative(),
    idempotency_key: z.string().min(1).max(128),
    item_id: z.string().uuid(),
    run_id: z.string().uuid(),
    queue_message_id: z.union([z.string(), z.number(), z.bigint()]).transform(String),
    listing_id: z.string().uuid().nullable(),
    status: z.enum(["queued", "running", "retrying", "succeeded", "failed", "canceled"]),
    stage: z.enum(["queued", "identifying", "pricing", "generating", "persisting", "completed"]),
    attempt_count: z.number().int().nonnegative(),
    max_attempts: z.number().int().positive(),
    safe_failure_message: z.string().min(1).max(500).nullable(),
    updated_at: z.string().min(1),
  })
  .strict();

export const pipelineStageBatchResultSchema = z.array(pipelineStageResultSchema);

export const pipelineStagingCleanupIntentInputSchema = z
  .object({
    cleanupId: z.string().uuid(),
    userId: z.string().min(1).max(255),
    batchId: z.string().uuid(),
    photoPaths: z.array(storagePathSchema).min(1).max(800),
  })
  .strict()
  .superRefine((input, context) => {
    const prefix = `${input.userId}/pipeline-staging/${input.batchId}/`;
    for (const [index, path] of input.photoPaths.entries()) {
      if (!path.startsWith(prefix)) {
        context.addIssue({
          code: "custom",
          message: "Cleanup paths must use the owning seller and batch staging prefix",
          path: ["photoPaths", index],
        });
      }
    }
  });

export const pipelineReplayEntrySchema = z
  .object({
    idempotencyKey: z.string().min(1).max(128),
    source: z.enum(["single", "batch"]),
    autopilotEnabled: z.boolean(),
    photoCount: z.number().int().min(1).max(MAX_SINGLE_ITEM_PHOTOS),
    costBasis: z.number().finite().nonnegative().nullable(),
  })
  .strict();

export const pipelineReplayBatchInputSchema = z
  .object({
    batchId: z.string().uuid(),
    userId: z.string().min(1).max(255),
    entries: z.array(pipelineReplayEntrySchema).min(1).max(200),
  })
  .strict()
  .superRefine((input, context) => {
    const keys = new Set<string>();
    for (const [index, entry] of input.entries.entries()) {
      if (
        entry.source === "batch" &&
        entry.photoCount > MAX_BATCH_ITEM_PHOTOS
      ) {
        context.addIssue({
          code: "custom",
          message: "Batch items accept at most 4 photos",
          path: ["entries", index, "photoCount"],
        });
      }
      if (keys.has(entry.idempotencyKey)) {
        context.addIssue({
          code: "custom",
          message: "Idempotency keys must be unique within a replay",
          path: ["entries", index, "idempotencyKey"],
        });
      }
      keys.add(entry.idempotencyKey);
    }
  });

export type PipelineStageBatchInput = z.infer<typeof pipelineStageBatchInputSchema>;
export type PipelineStageBatchResult = z.infer<typeof pipelineStageBatchResultSchema>;
export type PipelineReplayBatchInput = z.infer<typeof pipelineReplayBatchInputSchema>;
export type PipelineStagingCleanupIntentInput = z.infer<
  typeof pipelineStagingCleanupIntentInputSchema
>;
