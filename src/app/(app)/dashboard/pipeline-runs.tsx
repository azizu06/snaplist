import { PipelineRunProgress } from "@/components/pipeline-run-progress";
import type { PipelineProgressRun } from "@/lib/pipeline-progress";

export function DashboardPipelineRuns({
  userId,
  runs,
}: {
  userId: string;
  runs: PipelineProgressRun[];
}) {
  if (runs.length === 0) return null;
  return (
    <section data-testid="pipeline-activity" aria-labelledby="pipeline-activity-title">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2
            id="pipeline-activity-title"
            className="font-display text-[18px] font-bold tracking-tight text-fg-strong"
          >
            Listing preparation
          </h2>
          <p className="mt-0.5 text-[13px] text-muted">
            Saved status for your most recent listing runs.
          </p>
        </div>
      </div>
      <div className="grid min-w-0 gap-3">
        {runs.map((run, index) => (
          <PipelineRunProgress
            key={run.id}
            userId={userId}
            initialRun={run}
            reviewHref={`/review/${run.item_id}`}
            title={`Listing run ${index + 1}`}
          />
        ))}
      </div>
    </section>
  );
}
