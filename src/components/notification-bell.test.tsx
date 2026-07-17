import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PipelineProgressRun } from "@/lib/pipeline-progress";
import { PipelineRunMenu } from "./notification-bell";

const statuses = ["queued", "running", "retrying", "succeeded", "failed"] as const;

function run(
  status: (typeof statuses)[number],
  index: number,
): PipelineProgressRun {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    user_id: "seller-1",
    item_id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    listing_id:
      status === "succeeded"
        ? `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`
        : null,
    status,
    stage:
      status === "queued"
        ? "queued"
        : status === "succeeded"
          ? "completed"
          : "pricing",
    attempt_count: status === "queued" ? 0 : 1,
    max_attempts: 3,
    safe_failure_message:
      status === "failed" ? "Listing preparation stopped." : null,
    retention_cleaned_at: null,
    updated_at: `2026-07-17T00:00:0${index}.000Z`,
  };
}

describe("PipelineRunMenu", () => {
  it("renders every seller-facing durable state from pipeline run rows", () => {
    const html = renderToStaticMarkup(
      <PipelineRunMenu
        runs={statuses.map(run)}
        connection="live"
        onOpenRun={() => undefined}
      />,
    );

    for (const label of [
      "Queued",
      "Researching the price",
      "Retrying",
      "Ready for review",
      "Failed",
    ]) {
      expect(html).toContain(label);
    }
  });

  it("explains the server-refresh fallback when Realtime is unavailable", () => {
    const html = renderToStaticMarkup(
      <PipelineRunMenu
        runs={[run("running", 1)]}
        connection="failed"
        onOpenRun={() => undefined}
      />,
    );

    expect(html).toContain("Live updates unavailable");
    expect(html).toContain("checking saved status");
  });
});
