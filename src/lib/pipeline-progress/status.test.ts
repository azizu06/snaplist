import { describe, expect, it } from "vitest";
import {
  pipelineProgressSteps,
  pipelineProgressView,
  type PipelineProgressRun,
} from "./status";

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
  updated_at: "2026-07-15T12:00:00.000Z",
};

describe("pipeline progress copy", () => {
  it.each([
    ["queued", "queued", "Queued"],
    ["running", "identifying", "Reading your photos"],
    ["running", "pricing", "Researching the price"],
    ["running", "generating", "Drafting the listing"],
    ["running", "persisting", "Saving the draft"],
    ["retrying", "pricing", "Retrying"],
    ["succeeded", "completed", "Ready for review"],
    ["failed", "generating", "Failed"],
    ["canceled", "queued", "Canceled"],
  ] as const)("maps %s/%s to %s", (status, stage, label) => {
    expect(pipelineProgressView({ ...BASE, status, stage }).label).toBe(label);
  });

  it("uses only the bounded seller-safe failure summary", () => {
    const view = pipelineProgressView({
      ...BASE,
      status: "failed",
      stage: "pricing",
      safe_failure_message: "Price research timed out. Try this item again.",
    });

    expect(view.detail).toBe("Price research timed out. Try this item again.");
  });

  it("keeps publish approval explicit after success", () => {
    expect(
      pipelineProgressView({ ...BASE, status: "succeeded", stage: "completed" }).detail,
    ).toMatch(/review it before anything posts/i);
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
});
