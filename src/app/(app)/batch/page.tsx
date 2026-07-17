import { redirect } from "next/navigation";
import { z } from "zod";
import { getUserId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  buildPipelineRecoveryHref,
  PIPELINE_PROGRESS_SELECT,
  pipelineProgressRunSchema,
} from "@/lib/pipeline-progress";
import { DurableBatchCapture } from "./durable-batch-capture";

/**
 * /batch - bulk capture plus durable progress recovery. Photo Files stay in
 * the browser only until enqueue, while pipeline_runs is authoritative after
 * the server accepts the batch.
 */
export default async function BatchPage({
  searchParams,
}: {
  searchParams: Promise<{ batch?: string }>;
}) {
  const requestedBatchId = (await searchParams).batch;
  const parsedBatchId = z.string().uuid().safeParse(requestedBatchId);
  const recoveryHref = parsedBatchId.success
    ? buildPipelineRecoveryHref("/batch", parsedBatchId.data)
    : "/batch";
  const userId = await getUserId();
  if (!userId) redirect(`/login?next=${encodeURIComponent(recoveryHref)}`);
  const batchId = parsedBatchId.success ? parsedBatchId.data : crypto.randomUUID();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("pipeline_runs")
    .select(PIPELINE_PROGRESS_SELECT)
    .eq("batch_id", batchId)
    .order("batch_position", { ascending: true });
  if (error) throw new Error(`Failed to load batch progress: ${error.message}`);
  const initialRuns = pipelineProgressRunSchema.array().parse(data ?? []);
  return (
    <DurableBatchCapture
      userId={userId}
      initialBatchId={batchId}
      initialRuns={initialRuns}
    />
  );
}
