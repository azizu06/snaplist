import type {
  PipelineProgressRun,
  PipelineProgressStage,
  PipelineProgressStatus,
} from "@/lib/pipeline-progress";

export type DurableProgressScenario =
  | "queued"
  | "slow"
  | "retrying"
  | "ready"
  | "failed"
  | "partial-failure";

export type DurableProgressFlow = "single" | "batch";
export type DurableProgressTheme = "light" | "dark";

export const DURABLE_PROGRESS_SCENARIOS = new Set<DurableProgressScenario>([
  "queued",
  "slow",
  "retrying",
  "ready",
  "failed",
  "partial-failure",
]);

export function isDurableProgressScenario(value: string): value is DurableProgressScenario {
  return DURABLE_PROGRESS_SCENARIOS.has(value as DurableProgressScenario);
}

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

function singleRun(scenario: DurableProgressScenario): PipelineProgressRun {
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

export function durableProgressFixtures(
  flow: DurableProgressFlow,
  scenario: DurableProgressScenario,
): PipelineProgressRun[] {
  if (flow === "batch" && scenario === "partial-failure") {
    return [
      fixture(1, "succeeded", "completed"),
      fixture(2, "running", "generating"),
      fixture(3, "failed", "pricing", {
        safe_failure_message: "Price research stopped before the draft was ready.",
      }),
    ];
  }
  return [singleRun(scenario)];
}
