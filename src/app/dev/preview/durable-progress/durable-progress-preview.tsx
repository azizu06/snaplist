"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { PipelineProgressCard } from "@/components/pipeline-run-progress";
import type { PipelineProgressRun } from "@/lib/pipeline-progress";

export function DurableProgressPreview({
  runs,
  flow,
  theme,
}: {
  runs: PipelineProgressRun[];
  flow: "single" | "batch";
  theme: "light" | "dark";
}) {
  const [checked, setChecked] = useState(0);
  const { setTheme } = useTheme();

  useEffect(() => {
    setTheme(theme);
  }, [setTheme, theme]);

  return (
    <div className={theme === "dark" ? "dark" : ""}>
      <main
        data-testid="durable-progress"
        className="min-h-dvh min-w-0 bg-bg px-4 py-6 text-fg sm:px-6"
      >
        <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4">
          <header className="min-w-0">
            <h1 className="font-display text-[22px] font-bold tracking-tight text-fg-strong">
              {flow === "batch" ? "Batch progress" : "Listing progress"}
            </h1>
            <p className="mt-1 max-w-[58ch] text-[14px] leading-relaxed text-muted">
              Your photos and progress are saved. You can leave this page and come back later.
            </p>
          </header>

          <div className="grid min-w-0 gap-4">
            {runs.map((run, index) => (
              <PipelineProgressCard
                key={run.id}
                run={run}
                connection={run.status === "failed" || run.status === "retrying" ? "failed" : "live"}
                reviewHref={run.status === "succeeded" ? `/review/${run.item_id}` : undefined}
                onRefresh={() => setChecked((count) => count + 1)}
                onRetryConnection={() => undefined}
                onRetryRun={
                  run.status === "failed" || run.status === "canceled"
                    ? () => undefined
                    : undefined
                }
                onCancelRun={
                  run.status === "queued" || run.status === "running" || run.status === "retrying"
                    ? () => undefined
                    : undefined
                }
                title={flow === "batch" ? `Item ${index + 1}` : "Building your listing"}
              />
            ))}
          </div>

          <p className="min-h-5 text-center text-[12.5px] text-faint">
            {checked > 0 ? "Status checked" : ""}
          </p>
        </div>
      </main>
    </div>
  );
}
