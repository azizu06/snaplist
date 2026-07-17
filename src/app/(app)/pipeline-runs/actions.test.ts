import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getUserId: vi.fn(),
  revalidatePath: vi.fn(),
  reportServerError: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth", () => ({ getUserId: mocks.getUserId }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/sentry", () => ({ reportServerError: mocks.reportServerError }));

import { cancelPipelineRun, retryPipelineRun } from "./actions";

const RUN_ID = "33333333-3333-4333-8333-333333333333";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";

describe("pipeline recovery server actions", () => {
  const rpc = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserId.mockResolvedValue("user_123");
    mocks.createClient.mockResolvedValue({ rpc });
    rpc.mockResolvedValue({
      data: { runId: RUN_ID, itemId: ITEM_ID, status: "queued" },
      error: null,
    });
  });

  it("retries through the tenant-scoped database transition", async () => {
    await expect(retryPipelineRun(RUN_ID)).resolves.toEqual({ ok: true });

    expect(rpc).toHaveBeenCalledWith("retry_pipeline_run", { p_run_id: RUN_ID });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/review/${ITEM_ID}`);
  });

  it("cancels through the tenant-scoped database transition", async () => {
    rpc.mockResolvedValueOnce({
      data: { runId: RUN_ID, itemId: ITEM_ID, status: "canceled" },
      error: null,
    });

    await expect(cancelPipelineRun(RUN_ID)).resolves.toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("cancel_pipeline_run", { p_run_id: RUN_ID });
  });

  it("rejects anonymous and malformed requests before touching the database", async () => {
    await expect(retryPipelineRun("not-a-run-id")).resolves.toEqual({
      ok: false,
      error: "That listing run is not valid.",
    });
    expect(mocks.createClient).not.toHaveBeenCalled();

    mocks.getUserId.mockResolvedValueOnce(null);
    await expect(cancelPipelineRun(RUN_ID)).resolves.toEqual({
      ok: false,
      error: "Sign in to manage this listing run.",
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns safe copy when the database rejects an illegal or cross-tenant transition", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "Pipeline run not found" } });

    await expect(retryPipelineRun(RUN_ID)).resolves.toEqual({
      ok: false,
      error: "We could not retry this listing. Refresh the status and try again.",
    });
    expect(mocks.reportServerError).toHaveBeenCalledWith(
      "pipelineRuns.retry",
      expect.anything(),
      { runId: RUN_ID },
    );
  });

  it("directs a stale retry request to recapture after retention cleanup", async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "This saved run has expired. Start a new capture." },
    });

    await expect(retryPipelineRun(RUN_ID)).resolves.toEqual({
      ok: false,
      error: "This saved run has expired. Start a new capture.",
    });
    expect(mocks.reportServerError).not.toHaveBeenCalled();
  });
});
