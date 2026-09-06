import { describe, expect, it } from "vitest";
import {
  pipelineProgressSteps,
  pipelineProgressView,
  type PipelineProgressRun,
} from "./status";
import { sellerCopyViolations } from "../seller-copy";

const BASE: PipelineProgressRun = {
  id: "00000000-0000-4000-8000-000000000001",
  user_id: "seller-1",
  item_id: "00000000-0000-4000-8000-000000000002",
  listing_id: null,
  status: "queued",
  stage: "queued",
  attempt_count: 0,
  max_attempts: 3,
  safe_failure_message: null,
  retention_cleaned_at: null,
  updated_at: "2026-07-15T12:00:00.000Z",
};

describe("pipeline progress copy", () => {
  it.each([
    ["queued", "queued", "Accepted"],
    ["running", "identifying", "Analyzing"],
    ["running", "pricing", "Analyzing"],
    ["running", "generating", "Analyzing"],
    ["running", "persisting", "Analyzing"],
    ["retrying", "pricing", "Analyzing"],
    ["succeeded", "completed", "Ready to review"],
    ["failed", "generating", "Needs retry"],
    ["canceled", "queued", "Needs retry"],
  ] as const)("maps %s/%s to %s", (status, stage, label) => {
    expect(pipelineProgressView({ ...BASE, status, stage }).label).toBe(label);
  });

  it("uses fixed seller copy instead of arbitrary stored failure text", () => {
    const view = pipelineProgressView({
      ...BASE,
      status: "failed",
      stage: "pricing",
      safe_failure_message: "Price research timed out. Try this item again.",
    });

    expect(view.detail).toBe("We could not finish this item. Your photos are still saved.");
  });

  it("keeps publish approval explicit after success", () => {
    expect(
      pipelineProgressView({ ...BASE, status: "succeeded", stage: "completed" }).detail,
    ).toMatch(/review it before anything posts/i);
  });

  it("makes a retention-cleaned terminal run explicitly non-retryable", () => {
    const view = pipelineProgressView({
      ...BASE,
      status: "failed",
      retention_cleaned_at: "2026-07-16T12:00:00.000Z",
    });

    expect(view).toMatchObject({
      label: "Needs retry",
      detail: "This saved item expired. Start a new capture to try again.",
    });
  });
});

describe("pipeline progress copy — seller-visible contract (#243)", () => {
  it.each([
    ["queued", "queued"],
    ["running", "identifying"],
    ["retrying", "pricing"],
    ["succeeded", "completed"],
    ["failed", "generating"],
    ["canceled", "queued"],
  ] as const)("maps %s/%s without internal or synthetic copy", (status, stage) => {
    const view = pipelineProgressView({ ...BASE, status, stage });

    expect(sellerCopyViolations(`${view.label}\n${view.detail}`)).toEqual([]);
  });

  it("does not pass through a stored failure message that leaks an internal error", () => {
    const view = pipelineProgressView({
      ...BASE,
      status: "failed",
      safe_failure_message: "PostgrestError: worker lease timed out",
    });

    expect(view.label).toBe("Needs retry");
    expect(view.detail).toBe("We could not finish this item. Your photos are still saved.");
  });
});

describe("pipeline progress steps", () => {
  it("marks only persisted stages as complete", () => {
    expect(
      pipelineProgressSteps({ ...BASE, status: "running", stage: "generating" }).map(
        (step) => step.state,
      ),
    ).toEqual(["complete", "complete", "complete", "current", "upcoming"]);
  });

  it("holds the saved stage while retrying", () => {
    const steps = pipelineProgressSteps({
      ...BASE,
      status: "retrying",
      stage: "pricing",
      attempt_count: 2,
    });

    expect(steps.find((step) => step.state === "current")?.label).toBe(
      "Research price",
    );
  });

  it("marks every step complete only after durable success", () => {
    expect(
      pipelineProgressSteps({ ...BASE, status: "succeeded", stage: "completed" }).every(
        (step) => step.state === "complete",
      ),
    ).toBe(true);
  });

  it("holds the stalled stage current on a failed run, same shape as running", () => {
    // pipelineProgressView renders this same run as "Needs retry" with a
    // danger tone, but the steps list has no failure state of its own — it
    // falls through to the same STAGE_INDEX lookup as "running"/"retrying".
    // This pins that fallthrough as a known, intentional contract rather
    // than an accident nothing would catch if it changed.
    expect(
      pipelineProgressSteps({ ...BASE, status: "failed", stage: "generating" }).map(
        (step) => step.state,
      ),
    ).toEqual(["complete", "complete", "complete", "current", "upcoming"]);
  });

  it("holds the stalled stage current on a canceled run", () => {
    expect(
      pipelineProgressSteps({ ...BASE, status: "canceled", stage: "queued" }).map(
        (step) => step.state,
      ),
    ).toEqual(["current", "upcoming", "upcoming", "upcoming", "upcoming"]);
  });
});
