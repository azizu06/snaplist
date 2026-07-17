import { describe, expect, it, vi } from "vitest";
import {
  listRecentPipelineRuns,
  mergePipelineRun,
  mergePipelineRuns,
} from "./runs";

const run = {
  id: "00000000-0000-4000-8000-000000000001",
  user_id: "seller-1",
  item_id: "10000000-0000-4000-8000-000000000001",
  listing_id: null,
  status: "queued" as const,
  stage: "queued" as const,
  attempt_count: 0,
  max_attempts: 3,
  safe_failure_message: null,
  updated_at: "2026-07-17T00:00:00.000001Z",
};

describe("listRecentPipelineRuns", () => {
  it("loads the seller's newest durable rows and drops malformed data", async () => {
    const limit = vi.fn(async () => ({
      data: [
        run,
        { id: "malformed" },
      ],
      error: null,
    }));
    const query = {
      select: vi.fn(() => query),
      order: vi.fn(() => query),
      limit,
    };
    const supabase = { from: vi.fn(() => query) };

    await expect(listRecentPipelineRuns(supabase as never, 5)).resolves.toHaveLength(1);
    expect(supabase.from).toHaveBeenCalledWith("pipeline_runs");
    expect(query.order).toHaveBeenCalledWith("updated_at", { ascending: false });
    expect(limit).toHaveBeenCalledWith(5);
  });

  it("degrades to an empty list when the saved-state query fails", async () => {
    const query = {
      select: vi.fn(() => query),
      order: vi.fn(() => query),
      limit: vi.fn(async () => ({ data: null, error: { message: "offline" } })),
    };

    await expect(
      listRecentPipelineRuns({ from: vi.fn(() => query) } as never),
    ).resolves.toEqual([]);
  });

  it("deduplicates a run and keeps the freshest DB row", () => {
    const fresh = {
      ...run,
      status: "running" as const,
      stage: "identifying" as const,
      attempt_count: 1,
      updated_at: "2026-07-17T00:00:00.000002Z",
    };

    expect(mergePipelineRun([run], fresh)).toEqual([fresh]);
    expect(mergePipelineRun([fresh], run)).toEqual([fresh]);
  });

  it("sorts distinct saved rows newest first and applies the display limit", () => {
    const later = {
      ...run,
      id: "00000000-0000-4000-8000-000000000002",
      item_id: "10000000-0000-4000-8000-000000000002",
      updated_at: "2026-07-17T01:00:00.000001Z",
    };

    expect(mergePipelineRun([run], later, 1)).toEqual([later]);
  });

  it("does not let an older saved refresh overwrite a newer Realtime event", () => {
    const terminalEvent = {
      ...run,
      status: "succeeded" as const,
      stage: "completed" as const,
      listing_id: "20000000-0000-4000-8000-000000000001",
      updated_at: "2026-07-17T00:00:00.000003Z",
    };

    expect(mergePipelineRuns([terminalEvent], [run])).toEqual([terminalEvent]);
  });
});
