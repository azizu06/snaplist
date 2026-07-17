"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getUserId } from "@/lib/auth";
import { reportServerError } from "@/lib/sentry";
import { createClient } from "@/lib/supabase/server";

const runIdSchema = z.string().uuid();
const transitionResultSchema = z.object({
  runId: z.string().uuid(),
  itemId: z.string().uuid(),
  status: z.enum(["queued", "running", "retrying", "canceled"]),
  queueMessageId: z.union([z.string(), z.number()]).nullish(),
});

export type PipelineRunActionResult =
  | { ok: true }
  | { ok: false; error: string };

async function transitionPipelineRun(
  operation: "retry" | "cancel",
  rawRunId: string,
): Promise<PipelineRunActionResult> {
  const parsedRunId = runIdSchema.safeParse(rawRunId);
  if (!parsedRunId.success) {
    return { ok: false, error: "That listing run is not valid." };
  }

  const userId = await getUserId();
  if (!userId) {
    return { ok: false, error: "Sign in to manage this listing run." };
  }

  const supabase = await createClient();
  const rpcName = operation === "retry" ? "retry_pipeline_run" : "cancel_pipeline_run";
  const { data, error } = await supabase.rpc(rpcName, {
    p_run_id: parsedRunId.data,
  });
  const parsed = transitionResultSchema.safeParse(data);
  if (error || !parsed.success) {
    reportServerError(
      `pipelineRuns.${operation}`,
      new Error(error?.message ?? "Invalid pipeline transition response"),
      { runId: parsedRunId.data },
    );
    return {
      ok: false,
      error:
        operation === "retry"
          ? "We could not retry this listing. Refresh the status and try again."
          : "We could not cancel this listing. Refresh the status and try again.",
    };
  }

  revalidatePath("/dashboard");
  revalidatePath(`/review/${parsed.data.itemId}`);
  return { ok: true };
}

export async function retryPipelineRun(
  runId: string,
): Promise<PipelineRunActionResult> {
  return transitionPipelineRun("retry", runId);
}

export async function cancelPipelineRun(
  runId: string,
): Promise<PipelineRunActionResult> {
  return transitionPipelineRun("cancel", runId);
}
