import { z } from "zod";
import type { PipelineProgressRun } from "./status";

export const pipelineProgressRunSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().min(1),
  item_id: z.string().uuid(),
  listing_id: z.string().uuid().nullable(),
  status: z.enum(["queued", "running", "retrying", "succeeded", "failed", "canceled"]),
  stage: z.enum(["queued", "identifying", "pricing", "generating", "persisting", "completed"]),
  attempt_count: z.number().int().min(0),
  max_attempts: z.number().int().positive(),
  safe_failure_message: z.string().min(1).max(500).nullable(),
  updated_at: z.string().min(1),
}) satisfies z.ZodType<PipelineProgressRun>;

export const PIPELINE_PROGRESS_SELECT =
  "id,user_id,item_id,listing_id,status,stage,attempt_count,max_attempts,safe_failure_message,updated_at";
