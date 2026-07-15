import { z } from "zod";

export const pipelineRunStatusSchema = z.enum([
  "queued",
  "running",
  "retrying",
  "succeeded",
  "failed",
  "canceled",
]);

export const pipelineRunStageSchema = z.enum([
  "queued",
  "identifying",
  "pricing",
  "generating",
  "persisting",
  "completed",
]);

export type PipelineRunStatus = z.infer<typeof pipelineRunStatusSchema>;
export type PipelineRunStage = z.infer<typeof pipelineRunStageSchema>;

const workerRunSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().min(1),
  item_id: z.string().uuid(),
  listing_id: z.string().uuid().nullable(),
  status: pipelineRunStatusSchema,
  stage: pipelineRunStageSchema,
  schema_version: z.literal(1),
  attempt_count: z.number().int().min(0),
  max_attempts: z.number().int().positive(),
});

const workerContextSchema = z.object({
  run: workerRunSchema,
  item: z.object({
    id: z.string().uuid(),
    user_id: z.string().min(1),
    photos: z.array(z.string()),
    attributes: z.record(z.string(), z.unknown()),
    condition: z.string().nullable(),
    cost_basis: z.union([z.string(), z.number()]).nullable(),
    review_revision: z.string().uuid(),
    review_content_revision: z.string().uuid(),
  }),
});

export type PipelineWorkerContext = z.infer<typeof workerContextSchema>;

type PipelineWorkerRpcName =
  | "load_pipeline_run_worker_context"
  | "transition_pipeline_run"
  | "link_pipeline_run_listing";

interface PipelineWorkerRpcResult {
  data: unknown;
  error: { message: string } | null;
}

/**
 * The worker receives this capability instead of a generic service-role
 * Supabase client. Its SQL functions derive the tenant from `run_id`; none of
 * the methods accepts a user id or arbitrary table/payload operation.
 */
export interface PipelineWorkerRpcClient {
  rpc(
    functionName: PipelineWorkerRpcName,
    args: Record<string, unknown>,
  ): PromiseLike<PipelineWorkerRpcResult>;
}

export interface PipelineRunTransitionInput {
  runId: string;
  expectedStatus: PipelineRunStatus;
  nextStatus: PipelineRunStatus;
  nextStage: PipelineRunStage;
  attemptCount: number;
  failureCode?: string | null;
  safeFailureMessage?: string | null;
}

export interface PipelineWorkerStore {
  loadContext(runId: string): Promise<PipelineWorkerContext>;
  transition(input: PipelineRunTransitionInput): Promise<z.infer<typeof workerRunSchema>>;
  linkListing(runId: string, listingId: string): Promise<z.infer<typeof workerRunSchema>>;
}

function rpcData(
  operation: string,
  result: PipelineWorkerRpcResult,
): unknown {
  if (result.error) {
    throw new Error(`Pipeline worker ${operation} failed: ${result.error.message}`);
  }
  return result.data;
}

export function createSupabasePipelineWorkerStore(
  client: PipelineWorkerRpcClient,
): PipelineWorkerStore {
  return {
    async loadContext(runId) {
      const id = z.string().uuid().parse(runId);
      const result = await client.rpc("load_pipeline_run_worker_context", {
        p_run_id: id,
      });
      return workerContextSchema.parse(rpcData("context load", result));
    },

    async transition(input) {
      const parsed = z
        .object({
          runId: z.string().uuid(),
          expectedStatus: pipelineRunStatusSchema,
          nextStatus: pipelineRunStatusSchema,
          nextStage: pipelineRunStageSchema,
          attemptCount: z.number().int().min(0),
          failureCode: z.string().min(1).max(64).nullable().optional(),
          safeFailureMessage: z.string().min(1).max(500).nullable().optional(),
        })
        .strict()
        .parse(input);
      const result = await client.rpc("transition_pipeline_run", {
        p_attempt_count: parsed.attemptCount,
        p_expected_status: parsed.expectedStatus,
        p_failure_code: parsed.failureCode ?? null,
        p_failure_message: parsed.safeFailureMessage ?? null,
        p_next_stage: parsed.nextStage,
        p_next_status: parsed.nextStatus,
        p_run_id: parsed.runId,
      });
      return workerRunSchema.parse(rpcData("transition", result));
    },

    async linkListing(runId, listingId) {
      const ids = z
        .object({ runId: z.string().uuid(), listingId: z.string().uuid() })
        .parse({ runId, listingId });
      const result = await client.rpc("link_pipeline_run_listing", {
        p_listing_id: ids.listingId,
        p_run_id: ids.runId,
      });
      return workerRunSchema.parse(rpcData("listing link", result));
    },
  };
}
