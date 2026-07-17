import type { StatusTone } from "@/lib/ui/status";

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
  { key: "queued", label: "Queued" },
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

export function isPipelineProgressTerminal(status: PipelineProgressStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

export function pipelineProgressView(run: PipelineProgressRun): PipelineProgressView {
  if (run.status === "succeeded") {
    return {
      label: "Ready for review",
      detail: "Your draft is saved. Review it before anything posts.",
      tone: "success",
      pulse: false,
    };
  }
  if (run.status === "failed") {
    return {
      label: "Failed",
      detail:
        run.safe_failure_message ??
        "We could not finish this draft. Your photos are still saved.",
      tone: "danger",
      pulse: false,
    };
  }
  if (run.status === "canceled") {
    return {
      label: "Canceled",
      detail: "Processing stopped. Your saved status will stay here.",
      tone: "neutral",
      pulse: false,
    };
  }
  if (run.status === "retrying") {
    return {
      label: "Retrying",
      detail: "The last attempt stopped. SnapList will try again. Your photos are still saved.",
      tone: "warning",
      pulse: true,
    };
  }
  if (run.status === "queued") {
    return {
      label: "Queued",
      detail: "Your photos are saved. Processing will start when a worker is ready.",
      tone: "info",
      pulse: false,
    };
  }

  switch (run.stage) {
    case "identifying":
      return {
        label: "Reading your photos",
        detail: "SnapList is checking the item, condition, and any visible barcode.",
        tone: "info",
        pulse: true,
      };
    case "pricing":
      return {
        label: "Researching the price",
        detail: "SnapList is checking used-market evidence and building a price range.",
        tone: "info",
        pulse: true,
      };
    case "generating":
      return {
        label: "Drafting the listing",
        detail: "SnapList is writing the title and description from the saved item details.",
        tone: "info",
        pulse: true,
      };
    case "persisting":
    case "completed":
      return {
        label: "Saving the draft",
        detail: "SnapList is saving the listing and price research for your review.",
        tone: "info",
        pulse: true,
      };
    case "queued":
      return {
        label: "Queued",
        detail: "Your photos are saved. Processing will start when a worker is ready.",
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
