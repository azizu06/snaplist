import { notFound } from "next/navigation";
import type {
  PipelineProgressRun,
  PipelineProgressStage,
  PipelineProgressStatus,
} from "@/lib/pipeline-progress";
import { DurableProgressPreview } from "./durable-progress-preview";

type Scenario =
  | "queued"
  | "slow"
  | "retrying"
  | "ready"
  | "failed"
  | "partial-failure";

const VALID_SCENARIOS = new Set<Scenario>([
  "queued",
  "slow",
  "retrying",
  "ready",
  "failed",
  "partial-failure",
]);

function fixture(
  suffix: number,
  status: PipelineProgressStatus,
  stage: PipelineProgressStage,
  overrides: Partial<PipelineProgressRun> = {},
): PipelineProgressRun {
  return {
    id: `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`,
    user_id: "preview-seller",
    item_id: `10000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`,
    listing_id:
      status === "succeeded"
        ? `20000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`
        : null,
    status,
    stage,
    attempt_count: status === "queued" ? 0 : 1,
    max_attempts: 3,
    safe_failure_message: null,
    updated_at: "2026-07-15T12:00:00.000Z",
    ...overrides,
  };
}

function singleRun(scenario: Scenario): PipelineProgressRun {
  switch (scenario) {
    case "queued":
      return fixture(1, "queued", "queued");
    case "retrying":
      return fixture(1, "retrying", "pricing", { attempt_count: 2 });
    case "ready":
      return fixture(1, "succeeded", "completed");
    case "failed":
      return fixture(1, "failed", "generating", {
        safe_failure_message: "We could not finish this draft. Your photos are still saved.",
      });
    case "partial-failure":
    case "slow":
      return fixture(1, "running", "pricing");
  }
}

export default async function DurableProgressPreviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();

  const params = await searchParams;
  const flow = params.flow === "batch" ? "batch" : "single";
  const theme = params.theme === "dark" ? "dark" : "light";
  const rawScenario = typeof params.scenario === "string" ? params.scenario : "slow";
  const scenario = VALID_SCENARIOS.has(rawScenario as Scenario)
    ? (rawScenario as Scenario)
    : "slow";
  const runs =
    flow === "batch" && scenario === "partial-failure"
      ? [
          fixture(1, "succeeded", "completed"),
          fixture(2, "running", "generating"),
          fixture(3, "failed", "pricing", {
            safe_failure_message: "Price research stopped before the draft was ready.",
          }),
        ]
      : [singleRun(scenario)];

  return <DurableProgressPreview runs={runs} flow={flow} theme={theme} />;
}
