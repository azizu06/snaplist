import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isPipelineProgressUpdateStale,
  PIPELINE_PROGRESS_SELECT,
  pipelineProgressRunSchema,
  type PipelineProgressRun,
} from "@/lib/pipeline-progress";

export const RECENT_PIPELINE_RUN_LIMIT = 8;

export async function listRecentPipelineRuns(
  supabase: SupabaseClient,
  limit = RECENT_PIPELINE_RUN_LIMIT,
): Promise<PipelineProgressRun[]> {
  const { data, error } = await supabase
    .from("pipeline_runs")
    .select(PIPELINE_PROGRESS_SELECT)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];

  return data.flatMap((row) => {
    const parsed = pipelineProgressRunSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

export function mergePipelineRun(
  current: PipelineProgressRun[],
  candidate: PipelineProgressRun,
  limit = RECENT_PIPELINE_RUN_LIMIT,
): PipelineProgressRun[] {
  const existing = current.find((run) => run.id === candidate.id);
  if (existing && isPipelineProgressUpdateStale(candidate, existing)) return current;
  return [candidate, ...current.filter((run) => run.id !== candidate.id)]
    .sort((left, right) => {
      const timeDifference = Date.parse(right.updated_at) - Date.parse(left.updated_at);
      return timeDifference || right.updated_at.localeCompare(left.updated_at);
    })
    .slice(0, limit);
}

export function mergePipelineRuns(
  current: PipelineProgressRun[],
  candidates: PipelineProgressRun[],
  limit = RECENT_PIPELINE_RUN_LIMIT,
): PipelineProgressRun[] {
  return candidates.reduce(
    (merged, candidate) => mergePipelineRun(merged, candidate, limit),
    current.slice(0, limit),
  );
}
