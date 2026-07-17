import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PipelineProgressRun } from "@/lib/pipeline-progress";
import {
  isPipelineProgressUpdateStale,
  PipelineProgressCard,
} from "./pipeline-run-progress";

const RUN: PipelineProgressRun = {
  id: "00000000-0000-4000-8000-000000000001",
  user_id: "seller-1",
  item_id: "00000000-0000-4000-8000-000000000002",
  listing_id: null,
  status: "running",
  stage: "pricing",
  attempt_count: 1,
  max_attempts: 3,
  safe_failure_message: null,
  updated_at: "2026-07-15T12:00:00.000Z",
};

describe("PipelineProgressCard", () => {
  it("renders an accessible, durable working state", () => {
    const html = renderToStaticMarkup(
      <PipelineProgressCard run={RUN} connection="live" />,
    );

    expect(html).toContain('data-testid="run-row"');
    expect(html).toContain('data-run-status="running"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Researching the price");
    expect(html).toContain("Live updates on");
  });

  it("names the five durable steps without promising publication", () => {
    const html = renderToStaticMarkup(
      <PipelineProgressCard run={RUN} connection="failed" />,
    );

    for (const label of [
      "Queued",
      "Read photos",
      "Research price",
      "Draft listing",
      "Save draft",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Checking saved status every 5 seconds");
    expect(html).not.toMatch(/publish(?:ing|ed)? automatically/i);
  });

  it("shows a review link only after success", () => {
    const html = renderToStaticMarkup(
      <PipelineProgressCard
        run={{ ...RUN, status: "succeeded", stage: "completed" }}
        connection="live"
        reviewHref="/review/item-1"
      />,
    );

    expect(html).toContain("Review draft");
    expect(html).toContain('href="/review/item-1"');
  });

  it("offers cancellation only while work is active", () => {
    const html = renderToStaticMarkup(
      <PipelineProgressCard
        run={RUN}
        connection="live"
        onCancelRun={() => undefined}
      />,
    );

    expect(html).toContain("Cancel processing");
    expect(html).not.toContain("Try again");
  });

  it("offers a safe retry path after terminal failure", () => {
    const html = renderToStaticMarkup(
      <PipelineProgressCard
        run={{
          ...RUN,
          status: "failed",
          safe_failure_message:
            "Price research stopped before the draft was ready. Your photos are still saved.",
        }}
        connection="failed"
        onRetryRun={() => undefined}
      />,
    );

    expect(html).toContain("Try again");
    expect(html).toContain("Your photos are still saved");
    expect(html).not.toContain("Cancel processing");
  });
});

describe("isPipelineProgressUpdateStale", () => {
  it("rejects a delayed Realtime row after a newer saved row was accepted", () => {
    const succeeded: PipelineProgressRun = {
      ...RUN,
      status: "succeeded",
      stage: "completed",
      listing_id: "00000000-0000-4000-8000-000000000003",
      updated_at: "2026-07-15T12:05:00.000Z",
    };
    const delayedRunning = {
      ...RUN,
      updated_at: "2026-07-15T12:04:59.999Z",
    };

    expect(isPipelineProgressUpdateStale(delayedRunning, succeeded)).toBe(true);
    expect(isPipelineProgressUpdateStale(succeeded, delayedRunning)).toBe(false);
  });

  it("preserves Postgres microsecond ordering within one JavaScript millisecond", () => {
    const older = { ...RUN, updated_at: "2026-07-15T12:05:00.123456Z" };
    const newer = { ...RUN, updated_at: "2026-07-15T12:05:00.123999Z" };

    expect(Date.parse(older.updated_at)).toBe(Date.parse(newer.updated_at));
    expect(isPipelineProgressUpdateStale(older, newer)).toBe(true);
    expect(isPipelineProgressUpdateStale(newer, older)).toBe(false);
  });
});
