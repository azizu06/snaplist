/** Semantic tone for the progress badge; mirrors the shared status-color vocabulary (issue #40). */
export type StatusTone = "success" | "success-solid" | "warning" | "danger" | "info" | "neutral";

export type PipelineProgressStatus =
  | "queued"
  | "running"
  | "retrying"
  | "succeeded"
  | "failed"
  | "canceled";

export type PipelineProgressStage =
  | "queued"
  | "identifying"
  | "pricing"
  | "generating"
  | "persisting"
  | "completed";

export interface PipelineProgressRun {
  id: string;
  user_id: string;
  item_id: string;
  listing_id: string | null;
  status: PipelineProgressStatus;
  stage: PipelineProgressStage;
  attempt_count: number;
  max_attempts: number;
  safe_failure_message: string | null;
  retention_cleaned_at: string | null;
  updated_at: string;
}

export interface PipelineProgressView {
  label: string;
  detail: string;
  tone: StatusTone;
  pulse: boolean;
}

export type PipelineProgressStepState = "complete" | "current" | "upcoming";

export interface PipelineProgressStep {
  key: Exclude<PipelineProgressStage, "completed">;
  label: string;
  state: PipelineProgressStepState;
}

const STEPS = [
  { key: "queued", label: "Accepted" },
  { key: "identifying", label: "Read photos" },
  { key: "pricing", label: "Research price" },
  { key: "generating", label: "Draft listing" },
  { key: "persisting", label: "Save draft" },
] as const;

const STAGE_INDEX: Record<PipelineProgressStage, number> = {
  queued: 0,
  identifying: 1,
  pricing: 2,
  generating: 3,
  persisting: 4,
  completed: 5,
};

export function pipelineProgressView(run: PipelineProgressRun): PipelineProgressView {
  if (
    run.retention_cleaned_at !== null
    && (run.status === "failed" || run.status === "canceled")
  ) {
    return {
      label: "Needs retry",
      detail: "This saved item expired. Start a new capture to try again.",
      tone: "neutral",
      pulse: false,
    };
  }
  if (run.status === "succeeded") {
    return {
      label: "Ready to review",
      detail: "Your draft is saved. Review it before anything posts.",
      tone: "success",
      pulse: false,
    };
  }
  if (run.status === "failed") {
    return {
      label: "Needs retry",
      detail: "We could not finish this item. Your photos are still saved.",
      tone: "danger",
      pulse: false,
    };
  }
  if (run.status === "canceled") {
    return {
      label: "Needs retry",
      detail: "This item was stopped. Try again when you are ready.",
      tone: "neutral",
      pulse: false,
    };
  }
  if (run.status === "retrying") {
    return {
      label: "Analyzing",
      detail: "We are trying this item again. Your photos are still saved.",
      tone: "warning",
      pulse: true,
    };
  }
  if (run.status === "queued") {
    return {
      label: "Accepted",
      detail: "Your photos are saved and ready to analyze.",
      tone: "info",
      pulse: false,
    };
  }

  switch (run.stage) {
    case "identifying":
      return {
        label: "Analyzing",
        detail: "SnapList is checking the item, condition, and any visible barcode.",
        tone: "info",
        pulse: true,
      };
    case "pricing":
      return {
        label: "Analyzing",
        detail: "SnapList is checking used-market evidence and building a price range.",
        tone: "info",
        pulse: true,
      };
    case "generating":
      return {
        label: "Analyzing",
        detail: "SnapList is writing the title and description from the saved item details.",
        tone: "info",
        pulse: true,
      };
    case "persisting":
    case "completed":
      return {
        label: "Analyzing",
        detail: "SnapList is saving the listing and price research for your review.",
        tone: "info",
        pulse: true,
      };
    case "queued":
      return {
        label: "Accepted",
        detail: "Your photos are saved and ready to analyze.",
        tone: "info",
        pulse: false,
      };
  }
}

export function pipelineProgressSteps(run: PipelineProgressRun): PipelineProgressStep[] {
  if (run.status === "succeeded") {
    return STEPS.map((step) => ({ ...step, state: "complete" }));
  }

  const current = Math.min(STAGE_INDEX[run.stage], STEPS.length - 1);
  return STEPS.map((step, index) => ({
    ...step,
    state: index < current ? "complete" : index === current ? "current" : "upcoming",
  }));
}
